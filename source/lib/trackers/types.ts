export type IssueTrackerKind = "linear" | "github" | "local";

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

/** Fields accepted when creating a new issue. Only the built-in Local tracker
 * supports mutation today (see `IssueTracker.canMutate`). */
export interface NewIssueInput {
	title: string;
	description: string;
	priority?: number;
	labels?: string[];
}

/** Partial patch for an existing issue. Omitted fields are left unchanged. */
export interface IssuePatch {
	title?: string;
	description?: string;
	priority?: number;
	labels?: string[];
	state?: State;
}

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

	/** When true, the tracker implements createIssue/updateIssue/deleteIssue.
	 * Read-only trackers (Linear, GitHub) leave this undefined; UI surfaces
	 * gate every mutation path on `tracker.canMutate === true` (feature
	 * detection — never a `kind === "local"` string check, per the
	 * no-tracker-conditionals-outside-the-factory policy). */
	readonly canMutate?: boolean;
	createIssue?(input: NewIssueInput, repoRoot: string): Promise<IssueTrackerResult<Issue>>;
	updateIssue?(
		identifier: string,
		patch: IssuePatch,
		repoRoot: string,
	): Promise<IssueTrackerResult<Issue>>;
	deleteIssue?(identifier: string, repoRoot: string): Promise<IssueTrackerResult<void>>;
}
