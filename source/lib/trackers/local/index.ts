import type {
	AssignedIssue,
	AuthStatus,
	Issue,
	IssuePatch,
	IssueTracker,
	IssueTrackerResult,
	NewIssueInput,
} from "../types.js";
import {
	allocateId,
	deleteIssueFile,
	listIssues,
	priorityLabel,
	readCreatedAt,
	readIssue,
	writeIssue,
} from "./store.js";

// Terminal states are hidden from the "assigned" list, mirroring how Linear
// filters out completed/canceled issues.
const TERMINAL_TYPES = new Set(["completed", "canceled"]);

async function getAuthStatus(repoRoot: string | null): Promise<AuthStatus> {
	if (!repoRoot) {
		return { authenticated: false, hint: "Not inside a git repository" };
	}
	// Local has no credentials — being in a repo is all it needs.
	return { authenticated: true, accountLabel: ".santree/issues" };
}

async function signOut(_repoRoot: string): Promise<void> {
	// No credentials to clear.
}

function extractIdFromBranch(branch: string): string | null {
	// Recognizes `LOCAL-1`, `local-1`, `feature/LOCAL-1-foo`, `local-1-foo`.
	// The dashboard builds branches as `feature/${ticketId}-${slug}` where
	// ticketId is `LOCAL-1`, so the literal `LOCAL-1` is always present.
	const m = branch.match(/(?:^|[/_-])local-(\d+)(?:-|$)/i);
	if (!m) return null;
	return `LOCAL-${m[1]}`;
}

function cleanupCache(_identifier: string): void {
	// No remote image cache for local issues.
}

async function listAssigned(repoRoot: string): Promise<IssueTrackerResult<AssignedIssue[]>> {
	// Local has no assignee concept — "assigned" == all non-terminal issues.
	const issues = listIssues(repoRoot).filter((i) => !TERMINAL_TYPES.has(i.state.type));
	return { ok: true, value: issues };
}

async function getIssue(identifier: string, repoRoot: string): Promise<IssueTrackerResult<Issue>> {
	const issue = readIssue(repoRoot, identifier);
	if (!issue) {
		return { ok: false, reason: "not-found", message: `Issue ${identifier} not found` };
	}
	return { ok: true, value: issue };
}

async function createIssue(
	input: NewIssueInput,
	repoRoot: string,
): Promise<IssueTrackerResult<Issue>> {
	const identifier = allocateId(repoRoot);
	const priority = input.priority ?? 0;
	const issue: Issue = {
		identifier,
		title: input.title,
		description: input.description.trim() === "" ? null : input.description,
		url: "",
		priority,
		priorityLabel: priorityLabel(priority),
		state: { name: "Todo", type: "unstarted" },
		labels: input.labels ?? [],
		projectId: null,
		projectName: null,
		comments: [],
	};
	writeIssue(repoRoot, issue, new Date().toISOString());
	return { ok: true, value: issue };
}

async function updateIssue(
	identifier: string,
	patch: IssuePatch,
	repoRoot: string,
): Promise<IssueTrackerResult<Issue>> {
	const existing = readIssue(repoRoot, identifier);
	if (!existing) {
		return { ok: false, reason: "not-found", message: `Issue ${identifier} not found` };
	}
	const priority = patch.priority ?? existing.priority;
	const updated: Issue = {
		...existing,
		title: patch.title ?? existing.title,
		description:
			patch.description !== undefined
				? patch.description.trim() === ""
					? null
					: patch.description
				: existing.description,
		priority,
		priorityLabel: patch.priority !== undefined ? priorityLabel(priority) : existing.priorityLabel,
		labels: patch.labels ?? existing.labels,
		state: patch.state ?? existing.state,
	};
	// Preserve the original creation timestamp across edits.
	writeIssue(repoRoot, updated, readCreatedAt(repoRoot, identifier) || new Date().toISOString());
	return { ok: true, value: updated };
}

async function deleteIssue(
	identifier: string,
	repoRoot: string,
): Promise<IssueTrackerResult<void>> {
	const ok = deleteIssueFile(repoRoot, identifier);
	if (!ok) {
		return { ok: false, reason: "not-found", message: `Issue ${identifier} not found` };
	}
	return { ok: true, value: undefined };
}

export const localTracker: IssueTracker = {
	kind: "local",
	displayName: "Local",
	issueNoun: "issue",

	getAuthStatus,
	signOut,
	extractIdFromBranch,
	cleanupCache,
	listAssigned,
	getIssue,

	canMutate: true,
	createIssue,
	updateIssue,
	deleteIssue,
};
