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
import type { DashboardIssue, ProjectGroup } from "./types.js";

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

	// Enrich issues in parallel
	const enriched: DashboardIssue[] = await Promise.all(
		issues.map(async (issue) => {
			const wt = wtMap.get(issue.identifier);
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

	// Group by project
	const groupMap = new Map<string, DashboardIssue[]>();
	for (const di of enriched) {
		const key = di.issue.projectName ?? "No Project";
		const list = groupMap.get(key) ?? [];
		list.push(di);
		groupMap.set(key, list);
	}

	const groups: ProjectGroup[] = [...groupMap.entries()].map(([name, issues]) => ({
		name,
		id: issues[0]?.issue.projectId ?? null,
		issues,
	}));

	return { groups, flatIssues: groups.flatMap((g) => g.issues) };
}
