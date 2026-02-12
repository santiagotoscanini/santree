import { spawn, type ChildProcess } from "child_process";
import { getCurrentBranch, extractTicketId, findRepoRoot, findMainRepoRoot } from "./git.js";
import { renderPrompt, renderTicket } from "./prompts.js";
import { getTicketContent, cleanupImages, type LinearIssue } from "./linear.js";

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
