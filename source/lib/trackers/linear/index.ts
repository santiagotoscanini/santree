import type {
	AssignedIssue,
	AuthStatus,
	Issue,
	IssueTracker,
	IssueTrackerResult,
} from "../types.js";
import { readLinearAuthStore } from "../auth-store.js";
import { getRepoLinearOrg, getValidTokens, removeRepoLinearOrg, revokeTokens } from "./auth.js";
import { fetchAssignedIssues, fetchIssue } from "./api.js";
import { cleanupLinearImages, rewriteLinearImages } from "./images.js";

export {
	getRepoLinearOrg,
	setRepoLinearOrg,
	removeRepoLinearOrg,
	getValidTokens,
	revokeTokens,
	startOAuthFlow,
} from "./auth.js";

async function getAuthStatus(repoRoot: string | null): Promise<AuthStatus> {
	const store = readLinearAuthStore();
	const orgs = Object.keys(store);
	if (orgs.length === 0) {
		return { authenticated: false, hint: "Run: santree linear auth" };
	}

	if (repoRoot) {
		const repoOrg = getRepoLinearOrg(repoRoot);
		if (repoOrg && store[repoOrg]) {
			const tokens = store[repoOrg]!;
			return {
				authenticated: true,
				accountLabel: `${tokens.org_name} (${repoOrg})`,
				expiresAt: tokens.expires_at,
				repoLinked: true,
			};
		}
	}

	const orgSlug = orgs[0]!;
	const tokens = store[orgSlug]!;
	return {
		authenticated: true,
		accountLabel: `${tokens.org_name} (${orgSlug})`,
		expiresAt: tokens.expires_at,
		repoLinked: false,
		hint: "Repo not linked. Run: santree linear auth",
	};
}

async function signOut(repoRoot: string): Promise<void> {
	const orgSlug = getRepoLinearOrg(repoRoot);
	if (orgSlug) {
		await revokeTokens(orgSlug);
		removeRepoLinearOrg(repoRoot);
	}
}

function extractIdFromBranch(branch: string): string | null {
	const match = branch.match(/([a-zA-Z]+)-(\d+)/);
	if (!match) return null;
	return `${match[1]!.toUpperCase()}-${match[2]}`;
}

async function listAssigned(repoRoot: string): Promise<IssueTrackerResult<AssignedIssue[]>> {
	const orgSlug = getRepoLinearOrg(repoRoot);
	if (!orgSlug) {
		return { ok: false, reason: "unauthenticated", message: "Run: santree linear auth" };
	}
	const tokens = await getValidTokens(orgSlug);
	if (!tokens) {
		return { ok: false, reason: "unauthenticated", message: "Run: santree linear auth" };
	}
	const issues = await fetchAssignedIssues(tokens.access_token);
	if (issues === null) {
		return { ok: false, reason: "network", message: "Linear API request failed" };
	}
	return { ok: true, value: issues };
}

async function getIssue(identifier: string, repoRoot: string): Promise<IssueTrackerResult<Issue>> {
	const orgSlug = getRepoLinearOrg(repoRoot);
	if (!orgSlug) {
		return { ok: false, reason: "unauthenticated", message: "Run: santree linear auth" };
	}
	const tokens = await getValidTokens(orgSlug);
	if (!tokens) {
		return { ok: false, reason: "unauthenticated", message: "Run: santree linear auth" };
	}
	const issue = await fetchIssue(identifier, tokens.access_token);
	if (!issue) {
		return { ok: false, reason: "not-found", message: `Issue ${identifier} not found` };
	}

	if (issue.description) {
		issue.description = await rewriteLinearImages(
			issue.description,
			identifier,
			tokens.access_token,
		);
	}
	for (const comment of issue.comments) {
		if (comment.body) {
			comment.body = await rewriteLinearImages(comment.body, identifier, tokens.access_token);
		}
		for (const child of comment.children) {
			if (child.body) {
				child.body = await rewriteLinearImages(child.body, identifier, tokens.access_token);
			}
		}
	}

	return { ok: true, value: issue };
}

export const linearTracker: IssueTracker = {
	kind: "linear",
	displayName: "Linear",
	issueNoun: "ticket",

	getAuthStatus,
	signOut,
	extractIdFromBranch,
	cleanupCache: cleanupLinearImages,
	listAssigned,
	getIssue,
};
