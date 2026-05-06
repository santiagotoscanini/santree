export type IssueTrackerKind = "linear" | "github";

export interface Comment {
	author: string;
	body: string;
	createdAt: string;
	children: Comment[];
}

export interface State {
	name: string;
	type: string;
}

export interface AssignedIssue {
	identifier: string;
	title: string;
	description: string | null;
	url: string;
	priority: number;
	priorityLabel: string;
	state: State;
	labels: string[];
	projectId: string | null;
	projectName: string | null;
}

export interface Issue extends AssignedIssue {
	comments: Comment[];
}

export interface AuthStatus {
	authenticated: boolean;
	accountLabel?: string;
	expiresAt?: number;
	repoLinked?: boolean;
	hint?: string;
}

export type IssueTrackerResult<T> =
	| { ok: true; value: T }
	| { ok: false; reason: "unauthenticated" | "not-found" | "network"; message?: string };

export interface IssueTracker {
	readonly kind: IssueTrackerKind;
	readonly displayName: string;
	readonly issueNoun: string;

	getAuthStatus(repoRoot: string | null): Promise<AuthStatus>;
	signOut(repoRoot: string): Promise<void>;

	extractIdFromBranch(branch: string): string | null;
	cleanupCache(identifier: string): void;

	listAssigned(repoRoot: string): Promise<IssueTrackerResult<AssignedIssue[]>>;
	getIssue(identifier: string, repoRoot: string): Promise<IssueTrackerResult<Issue>>;
}
