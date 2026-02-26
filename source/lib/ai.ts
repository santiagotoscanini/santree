import { execSync, spawn, spawnSync, type ChildProcess } from "child_process";
import { writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
	getCurrentBranch,
	extractTicketId,
	findRepoRoot,
	findMainRepoRoot,
	getBaseBranch,
} from "./git.js";
import { renderPrompt, renderTicket, renderDiff, renderPR } from "./prompts.js";
import { getTicketContent, cleanupImages, type LinearIssue } from "./linear.js";
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
	ticket: LinearIssue | null;
}

/**
 * Resolves repo, branch, ticket ID, and fetches the Linear ticket.
 * Returns an error string if any required context is missing.
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

	const ticketId = extractTicketId(branch);
	if (!ticketId) {
		return {
			ok: false,
			error:
				"Could not extract ticket ID from branch name. Expected format: user/TEAM-123-description",
		};
	}

	const mainRoot = findMainRepoRoot() ?? repoRoot;
	const ticket = await getTicketContent(ticketId, mainRoot);

	return {
		ok: true,
		context: { repoRoot, mainRoot, branch, ticketId, ticket },
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
		ticket_content: ctx.ticket ? renderTicket(ctx.ticket) : undefined,
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
 * Check if claude CLI is available on PATH.
 * Returns "claude" or null if not installed.
 */
export function resolveAgentBinary(): string | null {
	try {
		execSync("which claude", { stdio: "ignore" });
		return "claude";
	} catch {
		return null;
	}
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

	if (opts?.planMode) {
		args.push("--permission-mode", "plan");
	}

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
export function runAgent(prompt: string): RunAgentResult {
	const bin = resolveAgentBinary();
	if (!bin) {
		throw new Error("Claude CLI not found. Install: npm install -g @anthropic-ai/claude-code");
	}

	const result = spawnSync(bin, ["-p", "--output-format", "text", "--", promptArg(prompt)], {
		encoding: "utf-8",
		maxBuffer: 10 * 1024 * 1024,
	});

	return {
		success: result.status === 0,
		output: result.stdout?.trim() ?? "",
	};
}

/**
 * Cleanup images downloaded for a ticket.
 */
export { cleanupImages };
