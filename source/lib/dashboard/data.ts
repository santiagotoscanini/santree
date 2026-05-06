import {
	listWorktrees,
	extractTicketId,
	getBaseBranch,
	readAllMetadata,
	readSessionState,
	isSessionAlive,
	clearSessionState,
	getGitStatusAsync,
	getCommitsAheadAsync,
	getDiffShortstatAsync,
} from "../git.js";
import {
	getPRInfoAsync,
	getPRChecksAsync,
	getPRReviewsAsync,
	getPRConversationCommentsAsync,
	getPRViewAsync,
	getReviewRequestedPRsAsync,
	getRepoNameAsync,
	type PRCheck,
	type PRReview,
} from "../github.js";
import { getIssueTracker } from "../trackers/index.js";
import type { DashboardIssue, ProjectGroup, StatusGroup, EnrichedReviewPR } from "./types.js";

export async function loadDashboardData(repoRoot: string): Promise<{
	groups: ProjectGroup[];
	flatIssues: DashboardIssue[];
}> {
	// Fetch issues and worktrees in parallel
	const tracker = getIssueTracker(repoRoot);
	const [listResult, worktrees] = await Promise.all([
		tracker.listAssigned(repoRoot),
		Promise.resolve(listWorktrees()),
	]);

	if (!listResult.ok) {
		const status = await tracker.getAuthStatus(repoRoot);
		throw new Error(
			listResult.message ?? status.hint ?? `Failed to authenticate with ${tracker.displayName}`,
		);
	}
	const issues = listResult.value;

	// Build worktree map: ticketId -> worktree info
	const wtMap = new Map<string, { path: string; branch: string }>();
	for (const wt of worktrees) {
		if (!wt.branch) continue;
		const tid = extractTicketId(wt.branch);
		if (tid) wtMap.set(tid, { path: wt.path, branch: wt.branch });
	}

	// Read metadata once for session IDs
	const metadata = readAllMetadata(repoRoot);

	// Track which ticket IDs are consumed by fetched issues
	const consumedTicketIds = new Set<string>();

	// Enrich issues in parallel
	const enriched: DashboardIssue[] = await Promise.all(
		issues.map(async (issue) => {
			const wt = wtMap.get(issue.identifier);
			if (wt) consumedTicketIds.add(issue.identifier);
			let worktreeInfo = null;
			let prInfo = null;

			let checksInfo: PRCheck[] | null = null;
			let reviewsInfo: PRReview[] | null = null;

			if (wt) {
				const base = getBaseBranch(wt.branch);
				const [gitStatusOutput, ahead, pr, shortstat] = await Promise.all([
					getGitStatusAsync(wt.path),
					getCommitsAheadAsync(wt.path, base),
					getPRInfoAsync(wt.branch),
					getDiffShortstatAsync(wt.path, base),
				]);
				let sessState = readSessionState(repoRoot, issue.identifier);
				// Validate against the active multiplexer — if the session has gone, clear stale state
				if (sessState && !isSessionAlive(issue.identifier)) {
					clearSessionState(repoRoot, issue.identifier);
					sessState = null;
				}
				const ss = sessState?.state ?? null;
				worktreeInfo = {
					path: wt.path,
					branch: wt.branch,
					dirty: Boolean(gitStatusOutput),
					commitsAhead: ahead,
					sessionId: metadata[issue.identifier]?.session_id ?? null,
					gitStatus: gitStatusOutput,
					sessionState: ss === "exited" ? null : ss,
					sessionMessage: sessState?.message ?? null,
					diffStats: shortstat,
				};
				prInfo = pr;

				if (pr) {
					[checksInfo, reviewsInfo] = await Promise.all([
						getPRChecksAsync(pr.number),
						getPRReviewsAsync(pr.number),
					]);
				}
			}

			return {
				issue,
				worktree: worktreeInfo,
				pr: prInfo,
				checks: checksInfo,
				reviews: reviewsInfo,
			};
		}),
	);

	// Build orphan DashboardIssue objects for worktrees not matched to any fetched issue
	const orphans: DashboardIssue[] = await Promise.all(
		[...wtMap.entries()]
			.filter(([tid]) => !consumedTicketIds.has(tid))
			.map(async ([tid, wt]) => {
				const base = getBaseBranch(wt.branch);
				const [gitStatusOutput, ahead, pr, shortstat] = await Promise.all([
					getGitStatusAsync(wt.path),
					getCommitsAheadAsync(wt.path, base),
					getPRInfoAsync(wt.branch),
					getDiffShortstatAsync(wt.path, base),
				]);

				let checksInfo: PRCheck[] | null = null;
				let reviewsInfo: PRReview[] | null = null;
				if (pr) {
					[checksInfo, reviewsInfo] = await Promise.all([
						getPRChecksAsync(pr.number),
						getPRReviewsAsync(pr.number),
					]);
				}

				// Derive a readable title from branch name: strip prefix and the
				// tracker-format ID literal (e.g. "TEAM-123-" or "123-"). The ID
				// shape comes from the tracker's parser so this works for both
				// Linear and GitHub branches.
				const idLiteral = tid ? new RegExp(`^${tid}-?`) : null;
				const titleFromBranch =
					(idLiteral
						? wt.branch.replace(/^[^/]+\//, "").replace(idLiteral, "")
						: wt.branch.replace(/^[^/]+\//, "")
					)
						.replace(/-/g, " ")
						.trim() || tid;

				let sessState = readSessionState(repoRoot, tid);
				if (sessState && !isSessionAlive(tid)) {
					clearSessionState(repoRoot, tid);
					sessState = null;
				}
				const ss = sessState?.state ?? null;
				return {
					issue: {
						identifier: tid,
						title: titleFromBranch,
						description: null,
						url: "",
						priority: 0,
						priorityLabel: "None",
						state: { name: "Orphaned", type: "orphaned" },
						labels: [],
						projectId: null,
						projectName: null,
					},
					worktree: {
						path: wt.path,
						branch: wt.branch,
						dirty: Boolean(gitStatusOutput),
						commitsAhead: ahead,
						sessionId: metadata[tid]?.session_id ?? null,
						gitStatus: gitStatusOutput,
						sessionState: ss === "exited" ? null : ss,
						sessionMessage: sessState?.message ?? null,
						diffStats: shortstat,
					},
					pr,
					checks: checksInfo,
					reviews: reviewsInfo,
				};
			}),
	);

	// ── Compute parent-child relationships ──────────────────────────
	// Build a map from worktree branch → DashboardIssue
	const allIssues = [...enriched, ...orphans];
	const branchToIssue = new Map<string, DashboardIssue>();
	for (const di of allIssues) {
		if (di.worktree) branchToIssue.set(di.worktree.branch, di);
	}

	// For each issue with a worktree, check if its base_branch matches another issue's branch
	const childTicketIds = new Set<string>();
	for (const di of allIssues) {
		if (!di.worktree) continue;
		const ticketId = di.issue.identifier;
		const baseBranch = metadata[ticketId]?.base_branch;
		if (!baseBranch) continue; // no custom base = branched from default, not a child

		const parent = branchToIssue.get(baseBranch);
		if (!parent || parent === di) continue;

		di.parentTicketId = parent.issue.identifier;
		if (!parent.children) parent.children = [];
		parent.children.push(di);
		childTicketIds.add(ticketId);
	}

	// Group by project (excluding children — they'll appear nested under parents)
	const groupMap = new Map<string, DashboardIssue[]>();
	for (const di of enriched) {
		if (childTicketIds.has(di.issue.identifier)) continue;
		const key = di.issue.projectName ?? "No Project";
		const list = groupMap.get(key) ?? [];
		list.push(di);
		groupMap.set(key, list);
	}

	// Status type priority: started > unstarted > backlog > triage
	const statusTypePriority: Record<string, number> = {
		started: 0,
		unstarted: 1,
		backlog: 2,
		triage: 3,
	};

	const groups: ProjectGroup[] = [...groupMap.entries()].map(([name, issues]) => {
		// Sub-group by status
		const statusMap = new Map<string, StatusGroup>();
		for (const di of issues) {
			const statusName = di.issue.state.name;
			const existing = statusMap.get(statusName);
			if (existing) {
				existing.issues.push(di);
			} else {
				statusMap.set(statusName, {
					name: statusName,
					type: di.issue.state.type,
					issues: [di],
				});
			}
		}

		// Sort status groups by type priority
		const statusGroups = [...statusMap.values()].sort(
			(a, b) => (statusTypePriority[a.type] ?? 99) - (statusTypePriority[b.type] ?? 99),
		);

		return {
			name,
			id: issues[0]?.issue.projectId ?? null,
			statusGroups,
		};
	});

	// Append orphaned worktrees as a separate group at the bottom (excluding children)
	const topLevelOrphans = orphans.filter((di) => !childTicketIds.has(di.issue.identifier));
	if (topLevelOrphans.length > 0) {
		groups.push({
			name: "Orphaned Worktrees",
			id: null,
			statusGroups: [
				{
					name: "Orphaned",
					type: "orphaned",
					issues: topLevelOrphans,
				},
			],
		});
	}

	// Flatten with children inserted right after their parent
	function flattenWithChildren(di: DashboardIssue): DashboardIssue[] {
		const result = [di];
		if (di.children) {
			for (const child of di.children) {
				result.push(...flattenWithChildren(child));
			}
		}
		return result;
	}

	const flatIssues = groups.flatMap((g) =>
		g.statusGroups.flatMap((sg) => sg.issues.flatMap(flattenWithChildren)),
	);
	return { groups, flatIssues };
}

export async function loadReviewsData(repoRoot: string): Promise<{
	flatReviews: EnrichedReviewPR[];
}> {
	const repo = await getRepoNameAsync();
	if (!repo) return { flatReviews: [] };

	const prs = await getReviewRequestedPRsAsync(repo);
	prs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

	// Build worktree map for matching PR branches to local worktrees
	const worktrees = listWorktrees();
	const branchToWt = new Map<string, { path: string; branch: string }>();
	for (const wt of worktrees) {
		if (wt.branch) branchToWt.set(wt.branch, { path: wt.path, branch: wt.branch });
	}
	const metadata = readAllMetadata(repoRoot);

	// Enrich each PR in parallel
	const enriched: EnrichedReviewPR[] = await Promise.all(
		prs.map(async (pr) => {
			const [view, checks, reviews, comments] = await Promise.all([
				getPRViewAsync(pr.number),
				getPRChecksAsync(String(pr.number)),
				getPRReviewsAsync(String(pr.number)),
				getPRConversationCommentsAsync(String(pr.number)),
			]);

			// Check if we have a local worktree for this PR's branch
			let worktreeInfo = null;
			const branch = view?.headRefName ?? null;
			if (branch) {
				const wt = branchToWt.get(branch);
				if (wt) {
					const ticketId = extractTicketId(branch);
					const base = getBaseBranch(branch);
					const [gitStatusOutput, ahead, shortstat] = await Promise.all([
						getGitStatusAsync(wt.path),
						getCommitsAheadAsync(wt.path, base),
						getDiffShortstatAsync(wt.path, base),
					]);
					let sessState = ticketId ? readSessionState(repoRoot, ticketId) : null;
					if (sessState && ticketId && !isSessionAlive(ticketId)) {
						clearSessionState(repoRoot, ticketId);
						sessState = null;
					}
					const ss = sessState?.state ?? null;
					worktreeInfo = {
						path: wt.path,
						branch: wt.branch,
						dirty: Boolean(gitStatusOutput),
						commitsAhead: ahead,
						sessionId: ticketId ? (metadata[ticketId]?.session_id ?? null) : null,
						gitStatus: gitStatusOutput,
						sessionState: ss === "exited" ? null : ss,
						sessionMessage: sessState?.message ?? null,
						diffStats: shortstat,
					};
				}
			}

			return {
				pr,
				body: view?.body ?? null,
				branch,
				baseBranch: view?.baseRefName ?? null,
				additions: view?.additions ?? 0,
				deletions: view?.deletions ?? 0,
				changedFiles: view?.changedFiles ?? 0,
				checks,
				reviews,
				comments,
				worktree: worktreeInfo,
			};
		}),
	);

	return { flatReviews: enriched };
}
