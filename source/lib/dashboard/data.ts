import {
	listWorktrees,
	extractTicketId,
	getBaseBranch,
	getDefaultBranch,
	readAllMetadata,
	readSessionState,
	isSessionAlive,
	clearSessionState,
	clearSessionId,
	getGitStatusAsync,
	getCommitsAheadAsync,
	getCommitsBehindAsync,
	getDiffShortstatAsync,
} from "../git.js";
import { runAsync } from "../exec.js";
import { readMainAgentTodos, findClaudeSessionCwd } from "../claude-todos.js";
import {
	getPRInfoAsync,
	getPRChecksAsync,
	getPRReviewsAsync,
	getPRConversationCommentsAsync,
	getPRViewAsync,
	getReviewRequestedPRsAsync,
	getRepoNameAsync,
	getGitHubUserNameAsync,
	type PRCheck,
	type PRReview,
} from "../github.js";
import { getIssueTracker, getCandidateTrackers } from "../trackers/index.js";
import { isSnoozed } from "./sla.js";
import type { DashboardIssue, ProjectGroup, StatusGroup, EnrichedReviewPR } from "./types.js";

export async function loadDashboardData(repoRoot: string): Promise<{
	groups: ProjectGroup[];
	flatIssues: DashboardIssue[];
	treeGroups: ProjectGroup[];
	flatTrees: DashboardIssue[];
	triageGroups: ProjectGroup[];
	flatTriage: DashboardIssue[];
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
				const storedId = metadata[issue.identifier]?.session_id ?? null;
				// Verify the session is still resumable. Claude Code clears old
				// transcript files (or `/clear` mints a new ID), leaving our stored
				// session_id pointing at nothing. Without this check the dashboard
				// offers `[↵] Resume`, which fails with "No conversation found with
				// session ID". `findClaudeSessionCwd` also returns the real cwd
				// where the session lives — needed because project conventions
				// (direnv, shell init) sometimes cd into a subdir before Claude
				// was launched, so resume must run from there. On a miss we drop
				// the stored ID from metadata so the next refresh skips this work.
				const sessionCwd = storedId ? findClaudeSessionCwd(wt.path, storedId) : null;
				let sessionId: string | null = storedId;
				if (storedId && !sessionCwd) {
					clearSessionId(repoRoot, issue.identifier);
					sessionId = null;
				}
				// Hide stale todos when the session has exited or its file is gone —
				// the on-disk todos file outlives the process and showing them
				// would lie about state.
				const claudeTodos = sessionId && ss !== "exited" ? readMainAgentTodos(sessionId) : null;
				worktreeInfo = {
					path: wt.path,
					branch: wt.branch,
					dirty: Boolean(gitStatusOutput),
					commitsAhead: ahead,
					commitsBehind: null,
					sessionId,
					sessionCwd,
					gitStatus: gitStatusOutput,
					sessionState: ss === "exited" ? null : ss,
					sessionMessage: sessState?.message ?? null,
					diffStats: shortstat,
					claudeTodos,
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
				const storedId = metadata[tid]?.session_id ?? null;
				const sessionCwd = storedId ? findClaudeSessionCwd(wt.path, storedId) : null;
				let sessionId: string | null = storedId;
				if (storedId && !sessionCwd) {
					clearSessionId(repoRoot, tid);
					sessionId = null;
				}
				const claudeTodos = sessionId && ss !== "exited" ? readMainAgentTodos(sessionId) : null;
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
						commitsBehind: null,
						sessionId,
						sessionCwd,
						gitStatus: gitStatusOutput,
						sessionState: ss === "exited" ? null : ss,
						sessionMessage: sessState?.message ?? null,
						diffStats: shortstat,
						claudeTodos,
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

	// Status type priority: started > unstarted > backlog > triage
	const statusTypePriority: Record<string, number> = {
		started: 0,
		unstarted: 1,
		backlog: 2,
		triage: 3,
	};

	// Group a set of (non-child) issues by project, then by status.
	function buildProjectGroups(issues: DashboardIssue[]): ProjectGroup[] {
		const groupMap = new Map<string, DashboardIssue[]>();
		for (const di of issues) {
			if (childTicketIds.has(di.issue.identifier)) continue;
			const key = di.issue.projectName ?? "No Project";
			const list = groupMap.get(key) ?? [];
			list.push(di);
			groupMap.set(key, list);
		}
		return [...groupMap.entries()].map(([name, list]) => {
			const statusMap = new Map<string, StatusGroup>();
			for (const di of list) {
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
			const statusGroups = [...statusMap.values()].sort(
				(a, b) => (statusTypePriority[a.type] ?? 99) - (statusTypePriority[b.type] ?? 99),
			);
			return { name, id: list[0]?.issue.projectId ?? null, statusGroups };
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
	function flatten(g: ProjectGroup[]): DashboardIssue[] {
		return g.flatMap((grp) =>
			grp.statusGroups.flatMap((sg) => sg.issues.flatMap(flattenWithChildren)),
		);
	}

	// ── Partition: Triage / Issues (backlog) / Trees (work in progress).
	// A tracker issue with no worktree is backlog — unless the active tracker
	// has a triage inbox and the issue sits in it (state.type === "triage"), in
	// which case it goes to the Triage tab instead. Once any issue gains a
	// worktree it moves to the Trees tab. Children always have a worktree, so
	// they only ever appear nested in Trees. Main-repo + orphaned worktrees
	// belong to Trees (they're active checkouts, not backlog).
	const triageEnabled = tracker.supportsTriage === true;
	const isTriage = (di: DashboardIssue) =>
		triageEnabled && !di.worktree && di.issue.state.type === "triage";
	const triageIssues = enriched.filter(isTriage);
	const backlogIssues = enriched.filter((di) => !di.worktree && !isTriage(di));
	const treeIssues = enriched.filter((di) => di.worktree);

	// Order the triage inbox so the work that needs attention now is on top:
	// active (non-snoozed) items first, snoozed parked at the bottom; within
	// each, by SLA breach time ascending (breached/soonest first), SLA-less last.
	const slaRank = (di: DashboardIssue): number => {
		const s = di.issue.slaBreachesAt;
		const t = s ? Date.parse(s) : NaN;
		return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
	};
	triageIssues.sort((a, b) => {
		const sa = isSnoozed(a.issue.snoozedUntilAt) ? 1 : 0;
		const sb = isSnoozed(b.issue.snoozedUntilAt) ? 1 : 0;
		if (sa !== sb) return sa - sb;
		return slaRank(a) - slaRank(b);
	});

	const groups = buildProjectGroups(backlogIssues);
	const flatIssues = flatten(groups);

	// Triage is scoped to issues assigned to the viewer, so project grouping and
	// the redundant "Triage" status header add noise. Render one flat group under
	// a single "Assigned to me" header (its column label is the SLA badge). The
	// empty status-group name makes IssueList skip the per-status sub-header.
	const triageGroups: ProjectGroup[] = triageIssues.length
		? [
				{
					name: "Assigned to me",
					id: null,
					statusGroups: [{ name: "", type: "triage", issues: triageIssues }],
				},
			]
		: [];
	const flatTriage = flatten(triageGroups);

	const treeGroups = buildProjectGroups(treeIssues);
	const topLevelOrphans = orphans.filter((di) => !childTicketIds.has(di.issue.identifier));
	if (topLevelOrphans.length > 0) {
		treeGroups.push({
			name: "Orphaned Worktrees",
			id: null,
			statusGroups: [{ name: "Orphaned", type: "orphaned", issues: topLevelOrphans }],
		});
	}
	const flatTrees = flatten(treeGroups);

	// Synthesize a "Main repo" row at the top of the Trees tab so users can
	// commit / view diffs / inspect drift on whatever branch their main
	// checkout happens to be on. state.type === "main" lets the renderer
	// differentiate.
	const mainEntry = await buildMainEntry(repoRoot);
	if (mainEntry) {
		treeGroups.unshift({
			name: "Main repo",
			id: null,
			statusGroups: [{ name: "Main", type: "main", issues: [mainEntry] }],
		});
		flatTrees.unshift(mainEntry);
	}

	return { groups, flatIssues, treeGroups, flatTrees, triageGroups, flatTriage };
}

/** Build the synthetic dashboard row for the main repo checkout — the
 * non-worktree clone that the user typically commits master/main from.
 * Returns null only if we can't read the current branch (e.g. detached
 * HEAD with no commits). */
async function buildMainEntry(repoRoot: string): Promise<DashboardIssue | null> {
	const branch = (await runAsync(`git -C "${repoRoot}" rev-parse --abbrev-ref HEAD`))?.trim();
	if (!branch || branch === "HEAD") return null;

	// `commitsAhead` here is "how many local commits haven't been pushed",
	// `commitsBehind` is "how many upstream commits I haven't pulled" —
	// both relative to origin/<currentBranch>. If there's no upstream,
	// both come back as 0; the renderer treats that as "in sync".
	const [gitStatusOutput, ahead, behind, shortstat] = await Promise.all([
		getGitStatusAsync(repoRoot),
		getCommitsAheadAsync(repoRoot, `origin/${branch}`),
		getCommitsBehindAsync(repoRoot, branch),
		// Diff vs origin so the +/- numbers reflect unpushed work.
		getDiffShortstatAsync(repoRoot, `origin/${branch}`),
	]);

	const defaultBranch = getDefaultBranch();
	const isDefault = branch === defaultBranch;
	const title = isDefault ? `${branch} (default)` : branch;

	return {
		issue: {
			identifier: branch.toUpperCase(),
			title,
			description: null,
			url: "",
			priority: 0,
			priorityLabel: "None",
			state: { name: "Main", type: "main" },
			labels: [],
			projectId: null,
			projectName: "Main repo",
		},
		worktree: {
			path: repoRoot,
			branch,
			dirty: Boolean(gitStatusOutput),
			commitsAhead: ahead,
			commitsBehind: behind,
			sessionId: null,
			sessionCwd: null,
			gitStatus: gitStatusOutput,
			sessionState: null,
			sessionMessage: null,
			diffStats: shortstat,
			claudeTodos: null,
		},
		pr: null,
		checks: null,
		reviews: null,
	};
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

	// Trackers worth trying when extracting a ticket ID from a PR's branch.
	// We hit the reviews tab to look at OTHER people's PRs — their branches
	// may follow a different convention than the current repo's active
	// tracker (e.g. a GitHub-tracker repo reviewing PRs from a Linear team
	// where branches encode `TEAM-1234`). The active tracker comes first;
	// `getCandidateTrackers` appends Linear as a fallback when GitHub is
	// active and Linear creds exist.
	const candidates = getCandidateTrackers(repoRoot);

	// Enrich each PR in parallel
	const enriched: EnrichedReviewPR[] = await Promise.all(
		prs.map(async (pr) => {
			const [view, checks, reviews, comments, authorName] = await Promise.all([
				getPRViewAsync(pr.number),
				getPRChecksAsync(String(pr.number)),
				getPRReviewsAsync(String(pr.number)),
				getPRConversationCommentsAsync(String(pr.number)),
				getGitHubUserNameAsync(pr.author.login),
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
					const storedId = ticketId ? (metadata[ticketId]?.session_id ?? null) : null;
					const sessionCwd = storedId ? findClaudeSessionCwd(wt.path, storedId) : null;
					let sessionId: string | null = storedId;
					if (storedId && ticketId && !sessionCwd) {
						clearSessionId(repoRoot, ticketId);
						sessionId = null;
					}
					const claudeTodos = sessionId && ss !== "exited" ? readMainAgentTodos(sessionId) : null;
					worktreeInfo = {
						path: wt.path,
						branch: wt.branch,
						dirty: Boolean(gitStatusOutput),
						commitsAhead: ahead,
						commitsBehind: null,
						sessionId,
						sessionCwd,
						gitStatus: gitStatusOutput,
						sessionState: ss === "exited" ? null : ss,
						sessionMessage: sessState?.message ?? null,
						diffStats: shortstat,
						claudeTodos,
					};
				}
			}

			// Resolve linked tracker issue. Try inputs in priority order:
			// branch first (most likely to encode the canonical ID), then PR
			// title (e.g. `[MSG-4084] …`). Each candidate tracker's
			// `extractIdFromBranch` regex is unanchored and works on any
			// text, not just branches — that's the (slightly misnamed but
			// load-bearing) reuse this fallback depends on.
			// Stops at the first hit. Failures stay silent.
			let ticket = null;
			const idInputs = [branch, pr.title].filter((s): s is string => Boolean(s));
			outer: for (const cand of candidates) {
				for (const text of idInputs) {
					const ticketId = cand.extractIdFromBranch(text);
					if (!ticketId) continue;
					try {
						const res = await cand.getIssue(ticketId, repoRoot);
						if (res.ok) {
							ticket = res.value;
							break outer;
						}
					} catch {
						// swallow — try the next candidate / input
					}
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
				ticket,
				authorName,
			};
		}),
	);

	return { flatReviews: enriched };
}
