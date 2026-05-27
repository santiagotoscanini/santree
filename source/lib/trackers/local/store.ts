import fs from "node:fs";
import path from "node:path";
import { getSantreeDir, readAllMetadata, writeAllMetadata } from "../../metadata.js";
import type { Issue } from "../types.js";
import { parseFrontmatter, serializeFrontmatter, type FrontmatterValue } from "./frontmatter.js";

// On-disk layout: one Markdown file per issue under `.santree/issues/`,
// named `<ID>.md` (e.g. `LOCAL-1.md`). `.santree/issues/` is NOT in
// .gitignore (which only excludes worktrees/metadata.json/session-states),
// so issue files are version-controlled by default — the whole point of the
// built-in tracker.
//
// Comments are intentionally not modeled in v1: Local issues always carry
// `comments: []`. The Issue type already permits an empty array.

export const ID_PREFIX = "LOCAL";
const FILE_RE = /^LOCAL-(\d+)\.md$/;

export function getIssuesDir(repoRoot: string): string {
	return path.join(getSantreeDir(repoRoot), "issues");
}

export function ensureIssuesDir(repoRoot: string): string {
	const dir = getIssuesDir(repoRoot);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	return dir;
}

function issueFilePath(repoRoot: string, identifier: string): string {
	return path.join(getIssuesDir(repoRoot), `${identifier}.md`);
}

/** Map a Linear-style numeric priority to a human label. 0 == no priority. */
export function priorityLabel(priority: number): string {
	switch (priority) {
		case 1:
			return "Urgent";
		case 2:
			return "High";
		case 3:
			return "Medium";
		case 4:
			return "Low";
		default:
			return "None";
	}
}

function recordToIssue(data: Record<string, FrontmatterValue>, body: string): Issue | null {
	const identifier = typeof data["id"] === "string" ? data["id"] : null;
	if (!identifier || !FILE_RE.test(`${identifier}.md`)) return null;
	const title = typeof data["title"] === "string" ? data["title"] : String(data["title"] ?? "");
	const priority = typeof data["priority"] === "number" ? data["priority"] : 0;
	const labels = Array.isArray(data["labels"]) ? data["labels"] : [];
	const stateName = typeof data["state"] === "string" ? data["state"] : "Todo";
	const stateType = typeof data["stateType"] === "string" ? data["stateType"] : "unstarted";
	const description = body.trim() === "" ? null : body;
	return {
		identifier,
		title,
		description,
		url: "", // Local issues have no web URL — the dashboard hides the [o] action.
		priority,
		priorityLabel:
			typeof data["priorityLabel"] === "string" ? data["priorityLabel"] : priorityLabel(priority),
		state: { name: stateName, type: stateType },
		labels,
		projectId: null,
		projectName: null,
		comments: [],
	};
}

function issueToRecord(
	issue: Issue,
	createdAt: string,
): { data: Record<string, FrontmatterValue>; body: string } {
	return {
		data: {
			id: issue.identifier,
			title: issue.title,
			state: issue.state.name,
			stateType: issue.state.type,
			priority: issue.priority,
			priorityLabel: issue.priorityLabel,
			labels: issue.labels,
			createdAt,
		},
		body: issue.description ?? "",
	};
}

/** Read every well-formed issue file. Malformed files are skipped, never
 * fatal. Returned newest-first by creation time (falling back to numeric ID). */
export function listIssues(repoRoot: string): Issue[] {
	const dir = getIssuesDir(repoRoot);
	if (!fs.existsSync(dir)) return [];
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const out: { issue: Issue; createdAt: string; num: number }[] = [];
	for (const name of names) {
		const m = name.match(FILE_RE);
		if (!m) continue;
		try {
			const raw = fs.readFileSync(path.join(dir, name), "utf-8");
			const { data, body } = parseFrontmatter(raw);
			const issue = recordToIssue(data, body);
			if (!issue) continue;
			const createdAt = typeof data["createdAt"] === "string" ? data["createdAt"] : "";
			out.push({ issue, createdAt, num: Number(m[1]) });
		} catch {
			// Skip unreadable / corrupt file.
		}
	}
	out.sort((a, b) => {
		if (a.createdAt && b.createdAt && a.createdAt !== b.createdAt) {
			return b.createdAt.localeCompare(a.createdAt);
		}
		return b.num - a.num;
	});
	return out.map((o) => o.issue);
}

export function readIssue(repoRoot: string, identifier: string): Issue | null {
	const file = issueFilePath(repoRoot, identifier);
	if (!fs.existsSync(file)) return null;
	try {
		const { data, body } = parseFrontmatter(fs.readFileSync(file, "utf-8"));
		return recordToIssue(data, body);
	} catch {
		return null;
	}
}

/** Write (create or overwrite) an issue file. `createdAt` preserves the
 * original timestamp on edits; pass a fresh ISO string when creating. */
export function writeIssue(repoRoot: string, issue: Issue, createdAt: string): void {
	ensureIssuesDir(repoRoot);
	const { data, body } = issueToRecord(issue, createdAt);
	fs.writeFileSync(issueFilePath(repoRoot, issue.identifier), serializeFrontmatter(data, body));
}

/** Return the original `createdAt` for an existing issue, or "" if unknown. */
export function readCreatedAt(repoRoot: string, identifier: string): string {
	const file = issueFilePath(repoRoot, identifier);
	if (!fs.existsSync(file)) return "";
	try {
		const { data } = parseFrontmatter(fs.readFileSync(file, "utf-8"));
		return typeof data["createdAt"] === "string" ? data["createdAt"] : "";
	} catch {
		return "";
	}
}

export function deleteIssueFile(repoRoot: string, identifier: string): boolean {
	const file = issueFilePath(repoRoot, identifier);
	if (!fs.existsSync(file)) return false;
	try {
		fs.unlinkSync(file);
		return true;
	} catch {
		return false;
	}
}

function maxExistingNum(repoRoot: string): number {
	const dir = getIssuesDir(repoRoot);
	let max = 0;
	if (fs.existsSync(dir)) {
		try {
			for (const name of fs.readdirSync(dir)) {
				const m = name.match(FILE_RE);
				if (m) max = Math.max(max, Number(m[1]));
			}
		} catch {
			// fall through with max = 0
		}
	}
	return max;
}

/**
 * Allocate the next issue ID and persist the high-water mark so numbers are
 * monotonic and never recycled: deleting LOCAL-3 then creating again yields
 * LOCAL-4, not LOCAL-3 — a stale local `feature/LOCAL-3-*` branch/worktree
 * can't collide with a reused ID.
 *
 * The counter lives in `.santree/metadata.json` (`_local.lastId`), which is
 * git-ignored and therefore per-machine. That's exactly the right scope: the
 * collision we're avoiding is with *local* worktrees/branches. On a fresh
 * clone metadata.json is absent, so the counter rebuilds from the committed
 * issue files (max existing) — correct, since a fresh clone has no stale
 * local worktrees.
 */
export function allocateId(repoRoot: string): string {
	const all = readAllMetadata(repoRoot);
	const local = (all["_local"] as { lastId?: number } | undefined) ?? {};
	const last = typeof local.lastId === "number" ? local.lastId : 0;
	const next = Math.max(last, maxExistingNum(repoRoot)) + 1;
	all["_local"] = { ...local, lastId: next };
	writeAllMetadata(repoRoot, all);
	return `${ID_PREFIX}-${next}`;
}
