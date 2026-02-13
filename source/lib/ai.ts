import { spawn, type ChildProcess } from "child_process";
import {
	getCurrentBranch,
	extractTicketId,
	findRepoRoot,
	findMainRepoRoot,
	getBaseBranch,
	getCommitLog,
	getDiffStat,
	getDiffContent,
} from "./git.js";
import { renderPrompt, renderTicket, renderDiff, renderPR } from "./prompts.js";
import { getTicketContent, cleanupImages, type LinearIssue } from "./linear.js";
import {
	getPRInfo,
	getPRChecks,
	getPRReviews,
	getPRReviewComments,
	getPRConversationComments,
	getFailedCheckDetails,
} from "./github.js";

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
 * Fetch and render PR feedback for a branch.
 * Returns rendered markdown or null if no PR exists.
 */
export function fetchAndRenderPR(branch: string): string | null {
	const prInfo = getPRInfo(branch);
	if (!prInfo) return null;

	const checks = getPRChecks(prInfo.number);
	const failedChecks = (checks ?? [])
		.filter((c) => c.bucket === "fail")
		.map((c) => getFailedCheckDetails(c));
	const reviews = getPRReviews(prInfo.number);
	const reviewComments = getPRReviewComments(prInfo.number);

	const allComments = getPRConversationComments(prInfo.number);
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
 * Fetch and render diff for a branch against its base branch.
 * Returns rendered markdown.
 */
export function fetchAndRenderDiff(branch: string): string {
	const baseBranch = getBaseBranch(branch);
	return renderDiff({
		base_branch: baseBranch,
		commit_log: getCommitLog(baseBranch),
		diff_stat: getDiffStat(baseBranch),
		diff: getDiffContent(baseBranch),
	});
}

/**
 * Spawns `happy` CLI with a rendered prompt.
 * Returns the child process so callers can listen for close/error.
 */
export function launchHappy(prompt: string, opts?: { planMode?: boolean }): ChildProcess {
	const args: string[] = [];

	if (opts?.planMode) {
		args.push("--permission-mode", "plan");
	}

	args.push(prompt);

	return spawn("happy", args, { stdio: "inherit" });
}

/**
 * Cleanup images downloaded for a ticket.
 */
export { cleanupImages };
