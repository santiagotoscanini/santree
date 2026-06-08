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

/** Readiness of an issue given its blocking dependencies:
 *   "ready"   — no unresolved blockers (or none at all)
 *   "blocked" — at least one blocker isn't done yet
 *   "unknown" — the tracker doesn't expose dependency data */
export type Readiness = "ready" | "blocked" | "unknown";

export function issueReadiness(blockedBy: IssueRef[] | undefined): Readiness {
	if (blockedBy === undefined) return "unknown";
	return blockedBy.some((b) => !b.done) ? "blocked" : "ready";
}

/** A lightweight reference to a related issue, with whether it's resolved
 * (state.type is completed/canceled). Used for dependency (blocks) relations. */
export interface IssueRef {
	identifier: string;
	done: boolean;
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
	/** Issues that block this one ("blocked by"). An issue is ready to start when
	 * every blocker is `done`. `undefined` when the tracker doesn't expose
	 * dependency relations (only Linear does); `[]` means no blockers. */
	blockedBy?: IssueRef[];
	/** Issues this one blocks (downstream dependents). */
	blocking?: IssueRef[];
	/** When the issue's triage SLA breaches, as an ISO timestamp, or null when
	 * no SLA applies. Only trackers with a native SLA concept populate it
	 * (Linear today); others leave it undefined. Surfaced on the Triage tab as a
	 * colored, urgency-coded countdown badge. */
	slaBreachesAt?: string | null;
	/** When the issue is snoozed until, as an ISO timestamp, or null when not
	 * snoozed. A snooze in the future means the issue is parked — surfaced on the
	 * Triage tab as a greyed, sunk-to-the-bottom row so active work stands out.
	 * Linear-only today. */
	snoozedUntilAt?: string | null;
}

export interface Issue extends AssignedIssue {
	comments: Comment[];
}

/** One slot in a triage on-call rotation. */
export interface TriageShift {
	startsAt: string; // ISO timestamp
	endsAt: string; // ISO timestamp
	/** Resolved display name (falls back to email, then "Unknown"). */
	name: string;
	/** True when this shift covers the current moment. */
	isCurrent: boolean;
	/** True when this shift belongs to the authenticated viewer. */
	isMe: boolean;
}

/** A team's triage responsibility rotation (Linear "Triage responsibility"
 * backed by a time schedule). */
export interface TriageSchedule {
	teamKey: string;
	teamName: string;
	scheduleName: string;
	/** Display name of whoever is on call right now, if known. */
	currentName: string | null;
	/** Whether the viewer is the one currently on call. */
	currentIsMe: boolean;
	/** Chronological list of shifts. */
	shifts: TriageShift[];
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

	/** When true, this tracker has a native triage concept (incoming issues in
	 * a `state.type === "triage"` inbox). The dashboard surfaces a dedicated
	 * Triage tab only when the active tracker sets this — feature detection,
	 * never a `kind === "linear"` string check, per the
	 * no-tracker-conditionals-outside-the-factory policy. Linear sets it;
	 * GitHub/Local leave it undefined. */
	readonly supportsTriage?: boolean;

	/** Triage on-call rotations for the viewer's teams. Optional — implemented
	 * only by trackers with a triage scheduling concept (Linear). Returns an
	 * empty array on failure or when no schedules exist; never throws. */
	getTriageSchedules?(repoRoot: string): Promise<TriageSchedule[]>;

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
