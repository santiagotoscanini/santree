import { linearTracker } from "./linear/index.js";
import { githubTracker } from "./github/index.js";
import { readTrackerConfig } from "./config.js";
import { readLinearAuthStore } from "./auth-store.js";
import type { IssueTracker, IssueTrackerKind } from "./types.js";

export type {
	AssignedIssue,
	AuthStatus,
	Comment,
	Issue,
	IssueTracker,
	IssueTrackerKind,
	IssueTrackerResult,
	State,
} from "./types.js";

export { setRepoTracker, removeRepoTracker, readTrackerConfig } from "./config.js";

/**
 * Resolve the active IssueTracker for a given repo. Selection order:
 *   1. SANTREE_TRACKER env override.
 *   2. Per-repo `_tracker.kind` in .santree/metadata.json.
 *   3. Legacy `_linear.org` (treated as kind: "linear" so existing repos keep working).
 *   4. Auto-detect: any stored Linear creds → Linear, else GitHub (gh is always available).
 */
export function getIssueTracker(repoRoot: string | null): IssueTracker {
	const explicit = process.env["SANTREE_TRACKER"]?.toLowerCase();
	if (explicit === "linear") return linearTracker;
	if (explicit === "github") return githubTracker;

	if (repoRoot) {
		const cfg = readTrackerConfig(repoRoot);
		if (cfg.kind === "linear") return linearTracker;
		if (cfg.kind === "github") return githubTracker;
		if (cfg.legacyLinearOrg) return linearTracker;
	}

	if (Object.keys(readLinearAuthStore()).length > 0) return linearTracker;
	return githubTracker;
}

export function getActiveTrackerKind(repoRoot: string | null): IssueTrackerKind {
	return getIssueTracker(repoRoot).kind;
}

/**
 * Trackers worth trying when resolving a ticket from a foreign PR branch.
 *
 * The active tracker is always first. When the active tracker is GitHub but
 * the user has stored Linear credentials, Linear is appended as a fallback —
 * the typical reviewer scenario is a santree-managed repo (active tracker:
 * GitHub) reviewing PRs from a Linear-driven team where branches encode
 * `TEAM-1234`-style IDs that GitHub's parser ignores.
 *
 * Only used by features that look at OTHER people's branches (like the
 * reviews tab). Per-repo flows still use the active tracker exclusively.
 */
export function getCandidateTrackers(repoRoot: string | null): IssueTracker[] {
	const active = getIssueTracker(repoRoot);
	if (active.kind === "github" && Object.keys(readLinearAuthStore()).length > 0) {
		return [active, linearTracker];
	}
	return [active];
}
