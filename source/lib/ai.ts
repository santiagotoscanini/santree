import { execSync, spawn, spawnSync, type ChildProcess } from "child_process";
import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";
import { getCurrentBranch, findRepoRoot, findMainRepoRoot, getBaseBranch } from "./git.js";
import { renderPrompt, renderTicket, renderDiff, renderPR } from "./prompts.js";
import { getIssueTracker } from "./trackers/index.js";
import type { Issue } from "./trackers/types.js";
import {
	getPRInfoAsync,
	getPRChecksAsync,
	getPRReviewsAsync,
	getPRReviewCommentsAsync,
	getPRConversationCommentsAsync,
	getFailedCheckDetailsAsync,
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

/**
 * cmux ships its own Claude CLI shim wired to the active cmux workspace. When
 * we run inside cmux, the system `claude` (if any) talks to a different
 * session — confusing for the user. See manaflow-ai/cmux#2048.
 */
const CMUX_CLAUDE_PATH = "/Applications/cmux.app/Contents/Resources/bin/claude";

/**
 * Resolve the path to the Claude CLI binary, preferring cmux's bundled copy
 * when running inside cmux. Falls back to PATH lookup, then to Anthropic's
 * standard installer location (`~/.claude/local/claude`). Returns null if
 * none of those resolve.
 *
 * Used by every santree code path that needs to invoke or report the Claude
 * binary — version display, doctor checks, and interactive launches.
 */
export function resolveClaudeBinary(): string | null {
	// Inside cmux, the bundled binary is the only one wired to the active
	// workspace. Gate on `CMUX_SURFACE_ID` (real cmux runtime) — outside a live
	// workspace the bundled binary has no auth context and exits with
	// "Invalid API key".
	if (process.env["CMUX_SURFACE_ID"] && existsSync(CMUX_CLAUDE_PATH)) {
		return CMUX_CLAUDE_PATH;
	}

	// PATH lookup
	try {
		execSync("which claude", { stdio: "ignore" });
		return "claude";
	} catch {
		// fall through
	}

	// Anthropic installer location — Ink renders may not inherit the user's
	// shell PATH, so check this explicitly.
	const localClaude = join(homedir(), ".claude", "local", "claude");
	if (existsSync(localClaude)) return localClaude;

	return null;
}

/**
 * @deprecated Use `resolveClaudeBinary()` directly. Kept as an alias because
 * existing call sites pass the return value straight to spawn args.
 */
export function resolveAgentBinary(): string | null {
	return resolveClaudeBinary();
}

// Conservative limit: 200KB leaves room for env vars within macOS 256KB ARG_MAX
const ARG_MAX_SAFE = 200 * 1024;

/**
 * Build the prompt argument for the agent.
 * If the prompt fits in ARG_MAX, returns it directly.
 * Otherwise, writes to a temp file and returns a short instruction to read it.
 */
function promptArg(prompt: string): string {
	if (Buffer.byteLength(prompt) <= ARG_MAX_SAFE) {
		return prompt;
	}
	const filePath = join(tmpdir(), `santree-prompt-${Date.now()}.md`);
	writeFileSync(filePath, prompt);
	return `Read ${filePath} and follow the instructions inside.`;
}

/**
 * Launch an interactive agent session with a prompt.
 * Passes prompt directly or via temp file if too large for OS arg limit.
 * Throws if claude CLI is not found.
 */
export function launchAgent(
	prompt: string,
	opts?: { planMode?: boolean; sessionId?: string; resume?: boolean },
): ChildProcess {
	const bin = resolveAgentBinary();
	if (!bin) {
		throw new Error("Claude CLI not found. Install: npm install -g @anthropic-ai/claude-code");
	}

	const args: string[] = [];

	args.push("--permission-mode", opts?.planMode ? "plan" : "auto");

	if (opts?.sessionId) {
		if (opts.resume) {
			args.push("--resume", opts.sessionId);
		} else {
			args.push("--session-id", opts.sessionId);
		}
	}

	args.push("--", promptArg(prompt));

	return spawn(bin, args, { stdio: "inherit" });
}

export interface RunAgentResult {
	success: boolean;
	output: string;
}

/**
 * Run an agent in non-interactive print mode and capture output.
 * Passes prompt directly or via temp file if too large for OS arg limit.
 * Throws if claude CLI is not found.
 */
export function runAgent(prompt: string, opts?: { allowedTools?: string[] }): RunAgentResult {
	const bin = resolveAgentBinary();
	if (!bin) {
		throw new Error("Claude CLI not found. Install: npm install -g @anthropic-ai/claude-code");
	}

	const toolArgs = opts?.allowedTools?.length ? ["--allowedTools", ...opts.allowedTools] : [];

	const result = spawnSync(
		bin,
		[
			"--permission-mode",
			"auto",
			...toolArgs,
			"-p",
			"--output-format",
			"text",
			"--",
			promptArg(prompt),
		],
		{
			encoding: "utf-8",
			maxBuffer: 10 * 1024 * 1024,
		},
	);

	return {
		success: result.status === 0,
		output: result.stdout?.trim() ?? "",
	};
}

/**
 * Async version of runAgent. Use this from Ink renderers — spawnSync
 * blocks Node's event loop, freezing the UI (no spinner animation, no
 * keystroke processing) for the entire duration of Claude's generation.
 * spawn() lets the loop run during the call.
 */
export function runAgentAsync(
	prompt: string,
	opts?: { allowedTools?: string[] },
): Promise<RunAgentResult> {
	const bin = resolveAgentBinary();
	if (!bin) {
		return Promise.reject(
			new Error("Claude CLI not found. Install: npm install -g @anthropic-ai/claude-code"),
		);
	}

	const toolArgs = opts?.allowedTools?.length ? ["--allowedTools", ...opts.allowedTools] : [];
	const args = [
		"--permission-mode",
		"auto",
		...toolArgs,
		"-p",
		"--output-format",
		"text",
		"--",
		promptArg(prompt),
	];

	return new Promise<RunAgentResult>((resolve) => {
		const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		child.stdout?.on("data", (chunk) => (stdout += chunk.toString("utf-8")));
		child.on("error", () => resolve({ success: false, output: "" }));
		child.on("close", (code) => resolve({ success: code === 0, output: stdout.trim() }));
	});
}

/**
 * Clean up cached image downloads for an issue identifier on the active tracker.
 */
export function cleanupImages(ticketId: string): void {
	const repoRoot = findMainRepoRoot();
	getIssueTracker(repoRoot).cleanupCache(ticketId);
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
