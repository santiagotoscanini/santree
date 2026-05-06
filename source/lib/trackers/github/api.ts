import { exec } from "child_process";
import { promisify } from "util";
import type { AssignedIssue, Comment, Issue, State } from "../types.js";

const execAsync = promisify(exec);

interface GhSearchIssue {
	number: number;
	title: string;
	body?: string | null;
	url: string;
	state: string;
	labels?: { name: string }[];
	repository?: { nameWithOwner?: string };
}

interface GhIssue {
	number: number;
	title: string;
	body?: string | null;
	html_url: string;
	state: "open" | "closed";
	state_reason?: string | null;
	labels: { name: string }[];
	milestone?: { title?: string; number?: number } | null;
}

interface GhIssueComment {
	user: { login: string };
	body: string;
	created_at: string;
}

const PRIORITY_PATTERNS: { regex: RegExp; rank: number; label: string }[] = [
	{ regex: /^p0(?:\b|:|-)|urgent|critical/i, rank: 1, label: "Urgent" },
	{ regex: /^p1(?:\b|:|-)|high(?:[ -]priority)?/i, rank: 2, label: "High" },
	{ regex: /^p2(?:\b|:|-)|medium(?:[ -]priority)?/i, rank: 3, label: "Medium" },
	{ regex: /^p3(?:\b|:|-)|low(?:[ -]priority)?/i, rank: 4, label: "Low" },
];

function priorityFromLabels(labels: string[]): { priority: number; priorityLabel: string } {
	for (const label of labels) {
		for (const pat of PRIORITY_PATTERNS) {
			if (pat.regex.test(label)) {
				return { priority: pat.rank, priorityLabel: pat.label };
			}
		}
	}
	return { priority: 0, priorityLabel: "No priority" };
}

function deriveState(state: string, stateReason?: string | null): State {
	if (state === "closed") {
		const completed = !stateReason || stateReason === "completed";
		return { name: completed ? "Done" : "Cancelled", type: completed ? "completed" : "canceled" };
	}
	return { name: "Open", type: "started" };
}

function ghJsonRun<T>(cmd: string): Promise<T | null> {
	return execAsync(cmd, { maxBuffer: 10 * 1024 * 1024 })
		.then(({ stdout }) => {
			try {
				return JSON.parse(stdout) as T;
			} catch {
				return null;
			}
		})
		.catch(() => null);
}

export async function fetchAssignedIssues(repoNwo: string): Promise<AssignedIssue[] | null> {
	const cmd = `gh search issues --assignee=@me --state=open --repo ${repoNwo} --limit 100 --json number,title,body,url,state,labels,repository`;
	const result = await ghJsonRun<GhSearchIssue[]>(cmd);
	if (!result) return null;
	return result.map((row) => {
		const labels = (row.labels ?? []).map((l) => l.name);
		const { priority, priorityLabel } = priorityFromLabels(labels);
		return {
			identifier: String(row.number),
			title: row.title,
			description: row.body ?? null,
			url: row.url,
			priority,
			priorityLabel,
			state: deriveState(row.state.toLowerCase()),
			labels,
			projectId: null,
			projectName: row.repository?.nameWithOwner ?? null,
		};
	});
}

export async function fetchIssue(repoNwo: string, identifier: string): Promise<Issue | null> {
	const number = identifier.replace(/^#/, "");
	if (!/^\d+$/.test(number)) return null;
	const issue = await ghJsonRun<GhIssue>(`gh api repos/${repoNwo}/issues/${number}`);
	if (!issue) return null;
	const commentsRaw = await ghJsonRun<GhIssueComment[]>(
		`gh api repos/${repoNwo}/issues/${number}/comments --paginate`,
	);
	const labels = issue.labels.map((l) => l.name);
	const { priority, priorityLabel } = priorityFromLabels(labels);
	const comments: Comment[] = (commentsRaw ?? []).map((c) => ({
		author: c.user.login,
		body: c.body,
		createdAt: c.created_at,
		children: [],
	}));
	return {
		identifier: String(issue.number),
		title: issue.title,
		description: issue.body ?? null,
		url: issue.html_url,
		priority,
		priorityLabel,
		state: deriveState(issue.state, issue.state_reason ?? null),
		labels,
		projectId: issue.milestone?.number ? String(issue.milestone.number) : null,
		projectName: issue.milestone?.title ?? repoNwo,
		comments,
	};
}
