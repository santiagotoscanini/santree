import {
	listWorktrees,
	extractTicketId,
	getBaseBranch,
	readAllMetadata,
	getGitStatusAsync,
	getCommitsAheadAsync,
} from "../git.js";
import {
	getPRInfoAsync,
	getPRChecksAsync,
	getPRReviewsAsync,
	type PRCheck,
	type PRReview,
} from "../github.js";
import { fetchAssignedIssues } from "../linear.js";
import type { DashboardIssue, ProjectGroup, StatusGroup } from "./types.js";

export async function loadDashboardData(repoRoot: string): Promise<{
	groups: ProjectGroup[];
	flatIssues: DashboardIssue[];
}> {
	// Fetch issues and worktrees in parallel
	const [issues, worktrees] = await Promise.all([
		fetchAssignedIssues(repoRoot),
		Promise.resolve(listWorktrees()),
	]);

	if (!issues) throw new Error("Failed to fetch Linear issues. Check authentication.");

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
				const [gitStatusOutput, ahead, pr] = await Promise.all([
					getGitStatusAsync(wt.path),
					getCommitsAheadAsync(wt.path, base),
					getPRInfoAsync(wt.branch),
				]);
				worktreeInfo = {
					path: wt.path,
					branch: wt.branch,
					dirty: Boolean(gitStatusOutput),
					commitsAhead: ahead,
					sessionId: metadata[issue.identifier]?.session_id ?? null,
					gitStatus: gitStatusOutput,
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
				const [gitStatusOutput, ahead, pr] = await Promise.all([
					getGitStatusAsync(wt.path),
					getCommitsAheadAsync(wt.path, base),
					getPRInfoAsync(wt.branch),
				]);

				let checksInfo: PRCheck[] | null = null;
				let reviewsInfo: PRReview[] | null = null;
				if (pr) {
					[checksInfo, reviewsInfo] = await Promise.all([
						getPRChecksAsync(pr.number),
						getPRReviewsAsync(pr.number),
					]);
				}

				// Derive a readable title from branch name: strip prefix and ticket ID
				const titleFromBranch =
					wt.branch
						.replace(/^[^/]+\//, "") // strip prefix (e.g. "feature/")
						.replace(/^[A-Z]+-\d+-?/, "") // strip ticket ID
						.replace(/-/g, " ")
						.trim() || tid;

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
					},
					pr,
					checks: checksInfo,
					reviews: reviewsInfo,
				};
			}),
	);

	// Group by project
	const groupMap = new Map<string, DashboardIssue[]>();
	for (const di of enriched) {
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

	// Append orphaned worktrees as a separate group at the bottom
	if (orphans.length > 0) {
		groups.push({
			name: "Orphaned Worktrees",
			id: null,
			statusGroups: [
				{
					name: "Orphaned",
					type: "orphaned",
					issues: orphans,
				},
			],
		});
	}

	const flatIssues = groups.flatMap((g) => g.statusGroups.flatMap((sg) => sg.issues));
	return { groups, flatIssues };
}
