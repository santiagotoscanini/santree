import type {
	AssignedIssue,
	AuthStatus,
	Issue,
	IssueTracker,
	IssueTrackerResult,
} from "../types.js";
import { getAuthenticatedUser, getCurrentRepoNwo } from "./auth.js";
import { fetchAssignedIssues, fetchIssue } from "./api.js";
import { cleanupGithubImages, rewriteGithubImages } from "./images.js";

async function getAuthStatus(_repoRoot: string | null): Promise<AuthStatus> {
	const user = await getAuthenticatedUser();
	if (!user) {
		return { authenticated: false, hint: "GitHub CLI not authenticated. Run: gh auth login" };
	}
	return {
		authenticated: true,
		accountLabel: `@${user.login}`,
		repoLinked: true,
	};
}

async function signOut(_repoRoot: string): Promise<void> {
	// gh CLI owns the token. No santree-side credential to clear.
}

function extractIdFromBranch(branch: string): string | null {
	// Require an explicit prefix so commit-style branches like `fix-typo-1`
	// don't match. Recognized: `gh-NN`, `issue-NN`, `#NN`, or a slash-separated
	// number segment (e.g. `feature/123-foo`, `123-foo`).
	const explicit = branch.match(/(?:^|[/_-])(?:gh-|issue-|#)(\d+)/i);
	if (explicit?.[1]) return explicit[1];
	const slashLed = branch.match(/(?:^|\/)(\d+)(?:-|$)/);
	if (slashLed?.[1]) return slashLed[1];
	return null;
}

async function listAssigned(repoRoot: string): Promise<IssueTrackerResult<AssignedIssue[]>> {
	const user = await getAuthenticatedUser();
	if (!user) {
		return {
			ok: false,
			reason: "unauthenticated",
			message: "GitHub CLI not authenticated. Run: gh auth login",
		};
	}
	const nwo = await getCurrentRepoNwo(repoRoot);
	if (!nwo) {
		return { ok: false, reason: "network", message: "Could not resolve GitHub repo" };
	}
	const issues = await fetchAssignedIssues(nwo);
	if (issues === null) {
		return { ok: false, reason: "network", message: "GitHub API request failed" };
	}
	return { ok: true, value: issues };
}

async function getIssue(identifier: string, repoRoot: string): Promise<IssueTrackerResult<Issue>> {
	const nwo = await getCurrentRepoNwo(repoRoot);
	if (!nwo) {
		return { ok: false, reason: "network", message: "Could not resolve GitHub repo" };
	}
	const issue = await fetchIssue(nwo, identifier);
	if (!issue) {
		return { ok: false, reason: "not-found", message: `Issue #${identifier} not found` };
	}

	if (issue.description) {
		issue.description = await rewriteGithubImages(issue.description, identifier);
	}
	for (const comment of issue.comments) {
		if (comment.body) {
			comment.body = await rewriteGithubImages(comment.body, identifier);
		}
	}

	return { ok: true, value: issue };
}

export const githubTracker: IssueTracker = {
	kind: "github",
	displayName: "GitHub",
	issueNoun: "issue",

	getAuthStatus,
	signOut,
	extractIdFromBranch,
	cleanupCache: cleanupGithubImages,
	listAssigned,
	getIssue,
};
