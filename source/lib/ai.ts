import { type ChildProcess } from "child_process";
import { getAiAgent } from "./agents/index.js";
import type { RunResult, LaunchOpts, HeadlessOpts } from "./agents/types.js";
import { getCurrentBranch, findRepoRoot, findMainRepoRoot, getBaseBranch } from "./git.js";
import {
	renderPrompt,
	renderTicket,
	renderDiff,
	renderPR,
	renderFixContext,
	type FixContextData,
} from "./prompts.js";
import { getIssueTracker } from "./trackers/index.js";
import type { Issue } from "./trackers/types.js";
import {
	getPRInfoAsync,
	getPRChecksAsync,
	getPRReviewsAsync,
	getPRReviewCommentsAsync,
	getPRReviewThreadsAsync,
	getApprovedReviewThreads,
	getViewerLoginAsync,
	getPRConversationCommentsAsync,
	getFailedCheckDetailsAsync,
	getPRMergeStateAsync,
	classifyCheck,
} from "./github.js";
import { runAsync } from "./exec.js";

export interface AIContext {
	repoRoot: string;
	mainRoot: string;
	branch: string;
	ticketId: string | null;
	ticket: Issue | null;
	trackerName: string;
	issueNoun: string;
}

/**
 * Resolves repo, branch, issue identifier, and fetches the issue from the
 * active tracker (Linear or GitHub Issues — selected by repo config).
 */
export async function resolveAIContext(): Promise<
	{ ok: true; context: AIContext } | { ok: false; error: string }
> {
	const repoRoot = findRepoRoot();
	if (!repoRoot) {
		return { ok: false, error: "Not inside a git repository" };
	}

	const branch = getCurrentBranch();
	if (!branch) {
		return { ok: false, error: "Could not determine current branch" };
	}

	const mainRoot = findMainRepoRoot() ?? repoRoot;
	const tracker = getIssueTracker(mainRoot);

	const ticketId = tracker.extractIdFromBranch(branch);
	if (!ticketId) {
		return {
			ok: false,
			error: `Could not extract ${tracker.issueNoun} ID from branch name '${branch}'.`,
		};
	}

	const result = await tracker.getIssue(ticketId, mainRoot);
	const ticket = result.ok ? result.value : null;

	return {
		ok: true,
		context: {
			repoRoot,
			mainRoot,
			branch,
			ticketId,
			ticket,
			trackerName: tracker.displayName,
			issueNoun: tracker.issueNoun,
		},
	};
}

/**
 * Builds prompt template context from AIContext + extras.
 */
export function buildPromptContext(
	ctx: AIContext,
	extra?: Record<string, string | undefined>,
): Record<string, string | undefined> {
	return {
		ticket_id: ctx.ticketId ?? undefined,
		ticket_content: ctx.ticket ? renderTicket(ctx.ticket, ctx.trackerName) : undefined,
		...extra,
	};
}

/**
 * Renders a named prompt template with the given context.
 */
export function renderAIPrompt(
	template: string,
	ctx: AIContext,
	extra?: Record<string, string | undefined>,
): string {
	return renderPrompt(template, buildPromptContext(ctx, extra));
}

const BOT_AUTHORS = new Set([
	"linear",
	"github-actions",
	"codecov",
	"dependabot",
	"renovate",
	"netlify",
	"vercel",
]);

/**
 * Fetch and render PR feedback for a branch (async, non-blocking).
 * Returns rendered markdown or null if no PR exists.
 */
export async function fetchAndRenderPR(branch: string): Promise<string | null> {
	const prInfo = await getPRInfoAsync(branch);
	if (!prInfo) return null;

	const [checks, reviews, reviewComments, allComments] = await Promise.all([
		getPRChecksAsync(prInfo.number),
		getPRReviewsAsync(prInfo.number),
		getPRReviewCommentsAsync(prInfo.number),
		getPRConversationCommentsAsync(prInfo.number),
	]);

	const failedChecks = await Promise.all(
		(checks ?? []).filter((c) => c.bucket === "fail").map((c) => getFailedCheckDetailsAsync(c)),
	);

	const conversationComments = (allComments ?? []).filter(
		(c) => !BOT_AUTHORS.has(c.author) && !c.author.endsWith("[bot]"),
	);

	return renderPR({
		pr_number: prInfo.number,
		pr_url: prInfo.url ?? "",
		branch,
		checks,
		failed_checks: failedChecks,
		reviews,
		review_comments: reviewComments,
		conversation_comments: conversationComments,
	});
}

/**
 * Fetch and render the self-contained per-iteration brief the auto-fix loop
 * consumes — state AND the exact actions to take this iteration. It covers
 * conflict status vs. the base branch, failing checks tagged fixable/manual
 * (logs only for the fixable ones, to keep it tight), the 👍-approved review
 * threads, and a single computed `directive` telling the loop what to do (merge
 * / work / wait / stop). The loop just runs this and obeys. `santreeCmd` is the
 * absolute santree invocation embedded in the `--signal` / resolve commands.
 * Returns null when no PR exists for the branch.
 */
/** Structured fix-context: the rendered brief plus the machine-usable directive
 * and a state `signature` (used by the santree-driven Codex loop to detect a
 * fix that isn't making progress). */
export interface FixContextResult {
	brief: string;
	directive: FixContextData["directive"];
	/** Stable fingerprint of the actionable state — same value twice = no progress. */
	signature: string;
}

export async function fetchAndRenderFixContext(
	branch: string,
	santreeCmd: string,
): Promise<string | null> {
	const result = await computeFixContext(branch, santreeCmd);
	return result ? result.brief : null;
}

/**
 * Like {@link fetchAndRenderFixContext} but returns the brief *and* the computed
 * directive + state signature. The self-paced Claude `/loop` only needs the
 * brief; the santree-driven Codex loop also needs the directive to decide
 * continue/wait/stop and the signature to detect being stuck.
 */
export async function computeFixContext(
	branch: string,
	santreeCmd: string,
): Promise<FixContextResult | null> {
	const prInfo = await getPRInfoAsync(branch);
	if (!prInfo) return null;

	const baseBranch = getBaseBranch(branch);
	const [checks, reviews, threads, mergeState, viewer] = await Promise.all([
		getPRChecksAsync(prInfo.number),
		getPRReviewsAsync(prInfo.number),
		getPRReviewThreadsAsync(prInfo.number),
		getPRMergeStateAsync(branch),
		getViewerLoginAsync(),
	]);

	const failing = (checks ?? []).filter((c) => c.bucket === "fail");
	const failedDetails = await Promise.all(failing.map((c) => getFailedCheckDetailsAsync(c)));
	const failed_checks = failedDetails.map((d) => ({
		...d,
		fixable: classifyCheck(d) === "fixable",
	}));
	const fixable_count = failed_checks.filter((c) => c.fixable).length;
	const manual_count = failed_checks.filter((c) => !c.fixable).length;
	// Only genuinely-queued/running checks count as pending — `skipping`/`cancel`
	// won't run under the current conditions, so the loop must not wait on them.
	const pending_count = (checks ?? []).filter((c) => c.bucket === "pending").length;

	// Only surface review comments the viewer has 👍-approved on an unresolved
	// thread — resolved threads are skipped, and unapproved ones wait for approval.
	const approved_comments = viewer && threads ? getApprovedReviewThreads(threads, viewer) : [];

	const conflicts = mergeState?.hasConflicts ?? false;
	const mergeable = mergeState?.mergeable ?? "UNKNOWN";

	// The single recommended action, in priority order. Conflicts block CI, so
	// resolve them first; otherwise do any fixable work; otherwise wait for CI (or
	// for GitHub to finish computing mergeability) rather than declaring done;
	// otherwise stop — stuck if only manual failures remain, else clean.
	const directive: FixContextData["directive"] = conflicts
		? "merge"
		: fixable_count > 0 || approved_comments.length > 0
			? "work"
			: pending_count > 0 || mergeable === "UNKNOWN"
				? "wait"
				: manual_count > 0
					? "stop-stuck"
					: "stop-clean";

	const brief = renderFixContext({
		pr_number: prInfo.number,
		pr_url: prInfo.url ?? "",
		branch,
		base_branch: baseBranch,
		conflicts,
		mergeable,
		merge_state: mergeState?.mergeStateStatus ?? "UNKNOWN",
		failed_checks,
		fixable_count,
		manual_count,
		pending_count,
		reviews,
		approved_comments,
		directive,
		santree_cmd: santreeCmd,
	});

	const signature = JSON.stringify({
		directive,
		conflicts,
		checks: failed_checks.map((c) => c.name).sort(),
		comments: approved_comments.map((c) => c.id).sort(),
	});

	return { brief, directive, signature };
}

/**
 * Fetch and render diff for a branch against its base branch (async, non-blocking).
 * Returns rendered markdown.
 */
export async function fetchAndRenderDiff(branch: string): Promise<string> {
	const baseBranch = getBaseBranch(branch);
	const [commitLog, diffStat, diff] = await Promise.all([
		runAsync(`git log ${baseBranch}..HEAD --format="- %s"`).then((v) => v || null),
		runAsync(`git diff ${baseBranch}..HEAD --stat`).then((v) => v || null),
		runAsync(`git diff ${baseBranch}..HEAD`, { maxBuffer: 10 * 1024 * 1024 }).then(
			(v) => v || null,
		),
	]);
	return renderDiff({
		base_branch: baseBranch,
		commit_log: commitLog,
		diff_stat: diffStat,
		diff,
	});
}

// Binary resolution + launch/run live in the pluggable agent layer
// (`lib/agents/`). `resolveClaudeBinary` is re-exported for the few call sites
// that specifically need Claude (cmux-bundled path, the Claude version row);
// everything else goes through the active agent.
export { resolveClaudeBinary } from "./agents/claude/index.js";

/** Binary of the *active* agent (Claude or Codex). */
export function resolveAgentBinary(): string | null {
	return getAiAgent().resolveBinary();
}

export type RunAgentResult = RunResult;

/**
 * Launch an interactive session with the active agent. Plan mode, session id,
 * and resume are mapped per-agent (Claude uses `--permission-mode`/`--session-id`;
 * Codex uses `--sandbox`/`resume`). Throws if the agent binary is not found.
 */
export function launchAgent(prompt: string, opts?: LaunchOpts): ChildProcess {
	return getAiAgent().launchInteractive(prompt, opts);
}

/**
 * Run the active agent headless and capture output. `allowedTools` is honoured
 * by agents that support a per-tool allowlist (Claude); others map it to a
 * read-only sandbox. Throws if the agent binary is not found.
 */
export function runAgent(prompt: string, opts?: HeadlessOpts): RunAgentResult {
	return getAiAgent().runHeadless(prompt, opts);
}

/**
 * Async headless run — use from Ink renderers so the event loop keeps turning
 * during the agent's generation (a blocking call freezes the spinner/keypresses).
 */
export function runAgentAsync(prompt: string, opts?: HeadlessOpts): Promise<RunAgentResult> {
	return getAiAgent().runHeadlessAsync(prompt, opts);
}

/**
 * Clean up cached image downloads for an issue identifier on the active tracker.
 */
export function cleanupImages(ticketId: string): void {
	const repoRoot = findMainRepoRoot();
	getIssueTracker(repoRoot).cleanupCache(ticketId);
}

/**
 * Ask Claude a clarifying question about a triage issue. The full issue —
 * description plus every comment — is rendered via the shared `ticket.njk`
 * template and injected into `ask.njk`. Read-only codebase tools are granted
 * (Read for downloaded issue images, Grep/Glob so Claude can judge whether the
 * issue is fixable against the real code). Runs non-interactively and returns
 * the captured answer text. Async so the Ink dashboard keeps animating.
 */
export async function askTicketQuestion(opts: {
	ticket: Issue;
	trackerName: string;
	question: string;
}): Promise<RunAgentResult> {
	const prompt = renderPrompt("ask", {
		ticket_id: opts.ticket.identifier,
		ticket_content: renderTicket(opts.ticket, opts.trackerName),
		user_question: opts.question,
	});
	return runAgentAsync(prompt, { allowedTools: ["Read", "Grep", "Glob"] });
}

export interface FillCommitOpts {
	branch: string;
	ticketId: string | null;
	ticketContent?: string;
	diffContent: string;
}

/**
 * Generate a short imperative commit message from a staged diff.
 * Async so callers (the Ink dashboard, the CLI commit flow) keep the
 * event loop turning during Claude's ~5–30s generation — using the sync
 * runAgent here freezes the renderer.
 *
 * Returns the trimmed message string (no quotes, no preamble) on success,
 * or null if Claude failed. Caller is responsible for ensuring the diff
 * is non-empty.
 */
export async function fillCommitMessage(opts: FillCommitOpts): Promise<string | null> {
	const prompt = renderPrompt("fill-commit", {
		branch_name: opts.branch,
		ticket_id: opts.ticketId ?? "",
		ticket_content: opts.ticketContent,
		diff_content: opts.diffContent,
	});
	const result = await runAgentAsync(prompt);
	if (!result.success) return null;
	// Trim quotes/whitespace; Claude occasionally wraps despite instructions.
	return result.output.trim().replace(/^["'`]|["'`]$/g, "");
}
