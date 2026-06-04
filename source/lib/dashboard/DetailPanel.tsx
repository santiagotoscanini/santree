import { Box, Text } from "ink";
import type { Comment, DashboardIssue, DashboardTab, DeleteStatus } from "./types.js";
import { formatDueDate } from "./due.js";
import { issueReadiness } from "../trackers/types.js";

interface Props {
	issue: DashboardIssue | null;
	scrollOffset: number;
	height: number;
	width: number;
	creatingForTicket: string | null;
	creationLogs: string;
	/** Deletion progress for the selected worktree, when one is being removed. */
	deleteStatus?: DeleteStatus;
	/** Triage mode: hide worktree/PR/checks sections (they never apply to an
	 * inbox issue) and show the discussion instead. */
	triage?: boolean;
	/** Comments for the selected triage issue. `undefined` = not yet loaded
	 * (shows "loading…"); an array (possibly empty) = loaded. Only consulted in
	 * triage mode. */
	comments?: Comment[];
	/** Compact triage on-call summary, shown as the first line in triage mode. */
	onCall?: {
		currentName: string | null;
		currentIsMe: boolean;
		/** Formatted start of the viewer's next shift (e.g. "Jun 5"), if any. */
		myNext: string | null;
	};
}

type Segment = { text: string; color?: string; bold?: boolean; dim?: boolean };
type LineData = {
	text: string;
	color?: string;
	bold?: boolean;
	dim?: boolean;
	segments?: Segment[];
};
export type IssueActionItem = { key: string; label: string; color: string };

function stateColor(type: string): string {
	switch (type) {
		case "started":
			return "green";
		case "unstarted":
			return "blue";
		case "backlog":
			return "gray";
		case "orphaned":
			return "gray";
		case "main":
			return "magenta";
		default:
			return "yellow";
	}
}

function parseGitStatus(raw: string): {
	staged: number;
	unstaged: number;
	untracked: number;
	files: { xy: string; file: string }[];
} {
	if (!raw) return { staged: 0, unstaged: 0, untracked: 0, files: [] };
	const lines = raw.split("\n").filter(Boolean);
	let staged = 0;
	let unstaged = 0;
	let untracked = 0;
	const files: { xy: string; file: string }[] = [];

	for (const line of lines) {
		if (line.length < 2) continue;
		const x = line[0]!;
		const y = line[1]!;
		const file = line.slice(3);

		if (x === "?") {
			untracked++;
		} else {
			if (x !== " ") staged++;
			if (y !== " ") unstaged++;
		}
		files.push({ xy: line.slice(0, 2), file });
	}

	return { staged, unstaged, untracked, files };
}

function fileColor(xy: string): string | undefined {
	const x = xy[0]!;
	if (x !== " " && x !== "?") return "green";
	if (xy.startsWith("??")) return "gray";
	return "yellow";
}

/** Returns the context-sensitive action key list for the selected issue.
 * Lifted out of the panel so the dashboard can render it on the same row as
 * the global command bar (so left- and right-pane key hints align). The
 * `trackerName` is the active tracker's `displayName` ("Linear" / "GitHub"),
 * surfaced as the open-in-browser action label so the panel doesn't hardcode
 * a vendor name. */
export function buildIssueActions(
	di: DashboardIssue,
	trackerName: string,
	opts?: { tab?: DashboardTab; canMutate?: boolean },
): IssueActionItem[] {
	const { worktree, pr, issue } = di;
	const items: IssueActionItem[] = [];

	// Issues tab = backlog/planning. No worktree actions here (commit / PR /
	// diff / fix live on the Trees tab). Offer Work (start → creates a
	// worktree, moving the row to Trees) plus issue CRUD when the active
	// tracker supports mutation (built-in Local only — feature-detected via
	// `canMutate`, never a kind string check).
	if (opts?.tab === "issues") {
		items.push({ key: "w", label: "Work", color: "cyan" });
		if (opts.canMutate) {
			items.push({ key: "n", label: "New", color: "cyan" });
			items.push({ key: "e", label: "Edit", color: "cyan" });
			items.push({ key: "d", label: "Delete", color: "red" });
		}
		if (issue.url) {
			items.push({ key: "o", label: trackerName, color: "gray" });
		}
		return items;
	}

	// Triage tab = the incoming inbox. Read the discussion, ask Claude a
	// clarifying question, and — once it looks fixable — send it to a tree
	// (`w`, same worktree-creation flow as the Issues tab).
	if (opts?.tab === "triage") {
		items.push({ key: "w", label: "Send to tree", color: "cyan" });
		items.push({ key: "a", label: "Ask", color: "cyan" });
		items.push({ key: "s", label: "Schedule", color: "cyan" });
		if (issue.url) {
			items.push({ key: "o", label: trackerName, color: "gray" });
		}
		return items;
	}

	// The synthetic "Main repo" row is special: no PR/Switch/Resume/Remove,
	// no work-launching (you're already on it). Only commit / diff /
	// editor — the actions that make sense for "I have changes in main and
	// want to review or land them".
	if (issue.state.type === "main") {
		if (worktree) {
			items.push({ key: "e", label: "Editor", color: "cyan" });
			if (worktree.dirty) items.push({ key: "C", label: "Commit", color: "cyan" });
			items.push({ key: "v", label: "View diff", color: "cyan" });
		}
		return items;
	}

	if (worktree?.sessionId) {
		items.push({ key: "↵", label: "Resume", color: "cyan" });
	} else if (worktree) {
		items.push({ key: "w", label: "Work", color: "cyan" });
		items.push({ key: "↵", label: "Switch", color: "cyan" });
	} else {
		items.push({ key: "w", label: "Work", color: "cyan" });
	}

	if (worktree) {
		items.push({ key: "e", label: "Editor", color: "cyan" });
	}

	if (worktree?.dirty) {
		items.push({ key: "C", label: "Commit", color: "cyan" });
	}

	if (worktree) {
		items.push({ key: "v", label: "View diff", color: "cyan" });
	}

	if (worktree && !pr) {
		items.push({ key: "c", label: "Create PR", color: "cyan" });
	}
	if (pr) {
		items.push({ key: "f", label: "Fix PR", color: "cyan" });
		items.push({ key: "r", label: "Review", color: "cyan" });
	}

	if (issue.url) {
		items.push({ key: "o", label: trackerName, color: "gray" });
	}
	if (pr) items.push({ key: "p", label: "Open PR", color: "gray" });

	if (worktree) {
		items.push({ key: "d", label: "Remove", color: "red" });
	}

	return items;
}

/** Section title with a colored leading icon and a bold name. Kept consistent
 * across all sections so the eye can immediately find the next block. */
function sectionHeader(icon: string, label: string, iconColor = "cyan"): LineData {
	return {
		text: "",
		segments: [
			{ text: `${icon} `, color: iconColor, bold: true },
			{ text: label, bold: true },
		],
	};
}

export default function DetailPanel({
	issue,
	scrollOffset,
	height,
	width,
	creatingForTicket,
	creationLogs,
	deleteStatus,
	triage = false,
	comments,
	onCall,
}: Props) {
	// Show deletion progress when the selected worktree is being removed.
	if (issue && deleteStatus) {
		const logLines = deleteStatus.logs.split("\n");
		const contentRows = height - 1;
		const startIdx = Math.max(0, logLines.length - contentRows);
		const visible = logLines.slice(startIdx, startIdx + contentRows);
		const clampLine = (s: string) =>
			s.length > width ? s.slice(0, Math.max(0, width - 1)) + "…" : s;
		const headerColor = deleteStatus.phase === "error" ? "red" : "yellow";
		const header =
			deleteStatus.phase === "error"
				? `Failed to remove ${issue.issue.identifier}`
				: deleteStatus.phase === "done"
					? `Removed ${issue.issue.identifier}`
					: `Removing worktree for ${issue.issue.identifier}…`;
		return (
			<Box flexDirection="column" width={width} height={height}>
				<Text color={deleteStatus.phase === "done" ? "green" : headerColor} bold>
					{clampLine(header)}
				</Text>
				{visible.map((line, i) => (
					<Box key={i}>
						<Text dimColor>{clampLine(line)}</Text>
					</Box>
				))}
				{deleteStatus.phase === "error" && deleteStatus.error ? (
					<Text color="red">{clampLine(deleteStatus.error)}</Text>
				) : null}
			</Box>
		);
	}

	// Show creation logs when selected issue is being created
	if (issue && issue.issue.identifier === creatingForTicket) {
		const logLines = creationLogs.split("\n");
		const contentRows = height - 1;
		const startIdx = Math.max(0, logLines.length - contentRows);
		const visible = logLines.slice(startIdx, startIdx + contentRows);
		// Setup-script output is arbitrary-length; clamp each line to the pane
		// width so long lines truncate instead of wrapping/overflowing into the
		// left pane. Ink's default soft-wrap would push the box past `height`.
		const clampLine = (s: string) =>
			s.length > width ? s.slice(0, Math.max(0, width - 1)) + "…" : s;

		return (
			<Box flexDirection="column" width={width} height={height}>
				<Text color="yellow" bold>
					{clampLine(`Setting up worktree for ${creatingForTicket}...`)}
				</Text>
				{visible.map((line, i) => (
					<Box key={i}>
						<Text dimColor>{clampLine(line)}</Text>
					</Box>
				))}
			</Box>
		);
	}

	if (!issue) {
		return (
			<Box width={width} height={height} justifyContent="center" alignItems="center">
				<Text dimColor>No issue selected</Text>
			</Box>
		);
	}

	const { issue: li, worktree, pr } = issue;
	const lines: LineData[] = [];
	const rule = "─".repeat(width);
	const ruleLine: LineData = { text: rule, dim: true };

	// ── Triage on-call (compact) ───────────────────────────────────────
	// First line in triage mode: who's on call now + when the viewer is next up.
	// The full rotation lives behind the [s] schedule overlay.
	if (triage && onCall && onCall.currentName) {
		const segs: Segment[] = [
			{ text: "◷ ", color: onCall.currentIsMe ? "cyan" : "green", bold: true },
			{ text: "on call: ", dim: true },
			{
				text: onCall.currentName,
				color: onCall.currentIsMe ? "cyan" : "green",
				bold: true,
			},
		];
		if (onCall.myNext) {
			segs.push({ text: "   ·   you're up ", dim: true });
			segs.push({ text: onCall.myNext, color: "cyan" });
		}
		segs.push({ text: "   ·   [s] schedule", dim: true });
		lines.push({ text: "", segments: segs });
		lines.push(ruleLine);
	}

	// ── Hero: identifier + title, then a status pill row ───────────────
	lines.push({ text: `${li.identifier}  ${li.title}`, bold: true });
	const sc = stateColor(li.state.type);
	const heroSegs: Segment[] = [
		{ text: "● ", color: sc },
		{ text: li.state.name, color: sc },
		{ text: "  ·  ", dim: true },
		{ text: li.priorityLabel },
	];
	if (li.labels.length > 0) {
		heroSegs.push({ text: "  ·  ", dim: true });
		heroSegs.push({ text: li.labels.join(", "), dim: true });
	}
	lines.push({ text: "", segments: heroSegs });

	// ── Due date ──────────────────────────────────────────────────────
	// Urgency-coded; shown whenever the issue carries one (most relevant on the
	// Triage tab, harmless elsewhere).
	const due = formatDueDate(li.dueDate);
	if (due) {
		lines.push({
			text: "",
			segments: [
				{ text: "◷ ", color: due.color, bold: due.urgent },
				{ text: due.label, color: due.color, bold: due.urgent },
			],
		});
	}

	// ── Description ───────────────────────────────────────────────────
	if (li.description) {
		lines.push({ text: "" });
		for (const dLine of li.description.trimEnd().split("\n")) {
			lines.push({ text: dLine });
		}
	}

	// ── Dependencies ──────────────────────────────────────────────────
	// Blocking relations from the tracker. Header carries a readiness badge so
	// the user can tell at a glance whether the issue is startable.
	const blockedBy = li.blockedBy ?? [];
	const blocking = li.blocking ?? [];
	if (!triage && (blockedBy.length > 0 || blocking.length > 0)) {
		const readiness = issueReadiness(li.blockedBy);
		lines.push(ruleLine);
		const headerSegs: Segment[] = [
			{ text: "⇄ ", color: "cyan", bold: true },
			{ text: "Dependencies", bold: true },
			{ text: "   " },
			readiness === "ready"
				? { text: "✓ ready to start", color: "green", bold: true }
				: { text: "⊘ blocked", color: "yellow", bold: true },
		];
		lines.push({ text: "", segments: headerSegs });
		if (blockedBy.length > 0) {
			lines.push({ text: "  blocked by", dim: true });
			for (const b of blockedBy) {
				lines.push({
					text: "",
					segments: [
						{ text: `    ${b.done ? "✓" : "○"} `, color: b.done ? "green" : "yellow" },
						{ text: b.identifier, color: b.done ? undefined : "yellow", dim: b.done },
						...(b.done ? [{ text: "  done", dim: true }] : []),
					],
				});
			}
		}
		if (blocking.length > 0) {
			lines.push({ text: "  blocks", dim: true });
			lines.push({
				text: "",
				segments: [{ text: "    " }, { text: blocking.map((b) => b.identifier).join(", ") }],
			});
		}
	}

	// ── Triage: discussion only ───────────────────────────────────────
	// Triage issues live in the inbox — no worktree/PR/checks apply yet. Show
	// the comment thread (lazily fetched by the dashboard) so the user can read
	// the back-and-forth before deciding to ask a question or send it to a tree.
	if (triage) {
		lines.push(ruleLine);
		lines.push(sectionHeader("≡", "Comments", "cyan"));
		if (comments === undefined) {
			lines.push({ text: "  loading…", dim: true });
		} else if (comments.length === 0) {
			lines.push({ text: "  no comments", dim: true });
		} else {
			const renderComment = (c: Comment, depth: number) => {
				const indent = "  ".repeat(depth + 1);
				lines.push({
					text: "",
					segments: [
						{ text: indent },
						{ text: c.author, color: "cyan", bold: true },
						{ text: `  ${new Date(c.createdAt).toLocaleDateString()}`, dim: true },
					],
				});
				for (const bodyLine of c.body.trimEnd().split("\n")) {
					lines.push({ text: `${indent}${bodyLine}` });
				}
				lines.push({ text: "" });
				for (const child of c.children) renderComment(child, depth + 1);
			};
			for (const c of comments) renderComment(c, 0);
		}

		// Skip the worktree/PR/checks/reviews sections entirely for triage.
		return renderLines(lines, scrollOffset, height, width);
	}

	// ── Worktree ──────────────────────────────────────────────────────
	lines.push(ruleLine);
	if (worktree) {
		// Header carries a quick status badge (clean / dirty) so the user can tell
		// at a glance without reading further.
		const dirty = worktree.dirty;
		lines.push({
			text: "",
			segments: [
				{ text: "⎇ ", color: "cyan", bold: true },
				{ text: "Worktree", bold: true },
				{ text: "   " },
				{
					text: dirty ? "● dirty" : "✓ clean",
					color: dirty ? "yellow" : "green",
				},
			],
		});
		lines.push({ text: `  ${worktree.branch}` });
		lines.push({ text: `  ${worktree.path}`, dim: true });

		// Single metric row: files / +ins / -dels / commits ahead.
		const ds = worktree.diffStats;
		const behind = worktree.commitsBehind ?? 0;
		const hasDiff = ds && (ds.insertions > 0 || ds.deletions > 0 || ds.filesChanged > 0);
		if (hasDiff || worktree.commitsAhead > 0 || behind > 0) {
			const segs: Segment[] = [{ text: "  " }];
			if (ds && ds.filesChanged > 0) {
				segs.push({
					text: `${ds.filesChanged} file${ds.filesChanged === 1 ? "" : "s"}`,
				});
			}
			if (ds && ds.insertions > 0) {
				if (segs.length > 1) segs.push({ text: "   " });
				segs.push({ text: `+${ds.insertions}`, color: "green" });
			}
			if (ds && ds.deletions > 0) {
				if (segs.length > 1) segs.push({ text: "   " });
				segs.push({ text: `−${ds.deletions}`, color: "red" });
			}
			if (worktree.commitsAhead > 0) {
				if (segs.length > 1) segs.push({ text: "   " });
				segs.push({ text: `↑ ${worktree.commitsAhead}`, color: "cyan" });
			}
			if (behind > 0) {
				if (segs.length > 1) segs.push({ text: "   " });
				segs.push({ text: `↓ ${behind} behind`, color: "yellow" });
			}
			lines.push({ text: "", segments: segs });
		}

		// Per-status counts only when there's something dirty — when the tree is
		// clean the badge in the section header already says so.
		const gs = parseGitStatus(worktree.gitStatus);
		if (dirty) {
			const statusSegs: Segment[] = [{ text: "  " }];
			if (gs.staged > 0) {
				if (statusSegs.length > 1) statusSegs.push({ text: "   " });
				statusSegs.push({ text: `+${gs.staged} staged`, color: "green" });
			}
			if (gs.unstaged > 0) {
				if (statusSegs.length > 1) statusSegs.push({ text: "   " });
				statusSegs.push({ text: `~${gs.unstaged} unstaged`, color: "yellow" });
			}
			if (gs.untracked > 0) {
				if (statusSegs.length > 1) statusSegs.push({ text: "   " });
				statusSegs.push({ text: `?${gs.untracked} untracked`, color: "gray" });
			}
			if (statusSegs.length > 1) {
				lines.push({ text: "", segments: statusSegs });
			}

			// Show individual files (up to 8)
			const maxFiles = 8;
			for (let i = 0; i < Math.min(gs.files.length, maxFiles); i++) {
				const f = gs.files[i]!;
				lines.push({ text: `    ${f.xy} ${f.file}`, color: fileColor(f.xy) });
			}
			if (gs.files.length > maxFiles) {
				lines.push({ text: `    +${gs.files.length - maxFiles} more`, dim: true });
			}
		}

		// Session state — single line, color reflects state.
		if (worktree.sessionState === "waiting") {
			const msg = worktree.sessionMessage
				? `NEEDS INPUT: ${worktree.sessionMessage}`
				: "NEEDS INPUT";
			lines.push({
				text: "",
				segments: [
					{ text: "  ◆ ", color: "red" },
					{ text: msg, color: "red", bold: true },
				],
			});
		} else if (worktree.sessionState === "active") {
			lines.push({
				text: "",
				segments: [
					{ text: "  ◆ ", color: "green" },
					{ text: "session active", color: "green" },
				],
			});
		} else if (worktree.sessionState === "idle") {
			lines.push({
				text: "",
				segments: [
					{ text: "  ◆ ", color: "yellow" },
					{ text: "session idle", color: "yellow" },
					{ text: "  (waiting for prompt)", dim: true },
				],
			});
		} else if (worktree.sessionId) {
			lines.push({
				text: "",
				segments: [
					{ text: "  ◇ ", color: "cyan" },
					{ text: "session ", dim: true },
					{ text: worktree.sessionId.slice(0, 8), color: "cyan" },
				],
			});
		} else {
			lines.push({
				text: "",
				segments: [
					{ text: "  ◇ ", dim: true },
					{ text: "no session", dim: true },
				],
			});
		}
	} else {
		lines.push(sectionHeader("⎇", "Worktree"));
		lines.push({ text: "  no worktree for this ticket", dim: true });
	}

	// ── Claude tasks ──────────────────────────────────────────────────
	// Reads `~/.claude/todos/<sessionId>-agent-<sessionId>.json` (main-agent
	// list only — sub-agent todos are noise). Section is hidden when the
	// session has no todos or has exited; the header shows done/total at a
	// glance. Up to 6 rows are rendered before collapsing into "+ N more".
	const todos = worktree?.claudeTodos ?? null;
	if (todos && todos.length > 0) {
		const completed = todos.filter((t) => t.status === "completed").length;
		const inProgress = todos.filter((t) => t.status === "in_progress").length;
		lines.push(ruleLine);
		const headerSegs: Segment[] = [
			{ text: "⎈ ", color: "cyan", bold: true },
			{ text: "Tasks", bold: true },
			{ text: "   " },
			{
				text: `${completed}/${todos.length}`,
				color: completed === todos.length ? "green" : "cyan",
			},
		];
		if (inProgress > 0) {
			headerSegs.push({ text: "  ·  ", dim: true });
			headerSegs.push({ text: `${inProgress} in progress`, color: "yellow" });
		}
		lines.push({ text: "", segments: headerSegs });

		const maxRows = 6;
		// Surface in-progress first so the active task is always visible even
		// when the list is long; pending next; completed last (most likely to
		// be elided when truncating).
		const ordered = [
			...todos.filter((t) => t.status === "in_progress"),
			...todos.filter((t) => t.status === "pending"),
			...todos.filter((t) => t.status === "completed"),
		];
		for (const t of ordered.slice(0, maxRows)) {
			if (t.status === "in_progress") {
				lines.push({
					text: "",
					segments: [
						{ text: "  ◐ ", color: "yellow", bold: true },
						{ text: t.content, color: "yellow" },
					],
				});
			} else if (t.status === "completed") {
				lines.push({
					text: "",
					segments: [
						{ text: "  ✓ ", color: "green" },
						{ text: t.content, dim: true },
					],
				});
			} else {
				lines.push({
					text: "",
					segments: [{ text: "  ◯ ", dim: true }, { text: t.content }],
				});
			}
		}
		if (ordered.length > maxRows) {
			lines.push({ text: `  + ${ordered.length - maxRows} more`, dim: true });
		}
	}

	// ── Pull Request ──────────────────────────────────────────────────
	// Skip PR/Checks/Reviews sections entirely for the synthetic main row
	// — those concepts don't apply to "the user's main checkout".
	const isMain = li.state.type === "main";
	const { checks, reviews } = issue;
	if (!isMain) {
		lines.push(ruleLine);
	}
	if (!isMain && pr) {
		const prColor = pr.state === "MERGED" ? "magenta" : pr.state === "OPEN" ? "green" : "red";
		const draft = pr.isDraft ? " · draft" : "";
		lines.push({
			text: "",
			segments: [
				{ text: "◉ ", color: "cyan", bold: true },
				{ text: "Pull Request", bold: true },
				{ text: "   " },
				{ text: `#${pr.number}`, color: prColor, bold: true },
				{ text: "  " },
				{ text: pr.state, color: prColor },
				{ text: draft, dim: true },
			],
		});
		if (pr.url) {
			lines.push({ text: `  ${pr.url}`, dim: true });
		}
	} else if (!isMain) {
		lines.push(sectionHeader("◉", "Pull Request"));
		lines.push({ text: "  no PR yet", dim: true });
	}

	// ── Checks ────────────────────────────────────────────────────────
	if (!isMain && checks && checks.length > 0) {
		const passing = checks.filter((c) => c.bucket === "pass");
		const failing = checks.filter((c) => c.bucket === "fail");
		const pending = checks.filter((c) => c.bucket !== "pass" && c.bucket !== "fail");
		const headerColor = failing.length > 0 ? "red" : pending.length > 0 ? "yellow" : "green";

		lines.push(ruleLine);
		const headerSegs: Segment[] = [
			{ text: "✓ ", color: "cyan", bold: true },
			{ text: "Checks", bold: true },
			{ text: "   " },
			{ text: `${passing.length}/${checks.length} passing`, color: headerColor },
		];
		if (failing.length > 0) {
			headerSegs.push({ text: "  ·  ", dim: true });
			headerSegs.push({ text: `${failing.length} failing`, color: "red" });
		}
		if (pending.length > 0) {
			headerSegs.push({ text: "  ·  ", dim: true });
			headerSegs.push({ text: `${pending.length} pending`, color: "yellow" });
		}
		lines.push({ text: "", segments: headerSegs });

		// Order: failing first (most important), then pending, then passing.
		for (const check of failing) {
			const desc = check.description ? ` — ${check.description}` : "";
			lines.push({ text: `  ✗ ${check.name}${desc}`, color: "red" });
		}
		for (const check of pending) {
			lines.push({ text: `  ● ${check.name}`, color: "yellow" });
		}
		for (const check of passing) {
			lines.push({ text: `  ✓ ${check.name}`, color: "green" });
		}
	}

	// ── Reviews ───────────────────────────────────────────────────────
	if (!isMain && reviews && reviews.length > 0) {
		lines.push(ruleLine);
		lines.push(sectionHeader("★", "Reviews"));
		for (const review of reviews) {
			const author = review.author.login;
			const rc =
				review.state === "APPROVED"
					? "green"
					: review.state === "CHANGES_REQUESTED"
						? "red"
						: "yellow";
			lines.push({
				text: "",
				segments: [{ text: `  ${author}` }, { text: "   " }, { text: review.state, color: rc }],
			});
		}
	}

	// Action footer is rendered by the dashboard one row outside the panel,
	// alongside the global command bar, so left- and right-pane key hints sit
	// on the same row. The panel itself uses its full height for content.
	return renderLines(lines, scrollOffset, height, width);
}

/** Scroll-clamp a built line list and render it into the panel box. Shared by
 * the full detail view and the triage (discussion-only) view. */
function renderLines(lines: LineData[], scrollOffset: number, height: number, width: number) {
	const totalLines = lines.length;
	const canScroll = totalLines > height;
	const contentRows = canScroll ? height - 2 : height;
	const clampedOffset = Math.min(scrollOffset, Math.max(0, totalLines - contentRows));
	const visible = lines.slice(clampedOffset, clampedOffset + contentRows);

	let scrollArrow: string | null = null;
	if (canScroll) {
		const atTop = clampedOffset === 0;
		const atBottom = clampedOffset + contentRows >= totalLines;
		scrollArrow = atTop ? "↓ scroll" : atBottom ? "↑ scroll" : "↑↓ scroll";
	}

	// Pre-truncate to keep long URLs/paths/descriptions from wrapping into the
	// row below — Ink's Text wrap is unreliable at the box's right edge and was
	// causing content to bleed into the next line and shift everything down.
	const clamp = (s: string) => (s.length > width ? s.slice(0, Math.max(0, width - 1)) + "…" : s);
	const clampSegments = (segs: Segment[]): Segment[] => {
		let remaining = width;
		const out: Segment[] = [];
		for (const seg of segs) {
			if (remaining <= 0) break;
			if (seg.text.length <= remaining) {
				out.push(seg);
				remaining -= seg.text.length;
			} else {
				out.push({
					...seg,
					text: seg.text.slice(0, Math.max(0, remaining - 1)) + "…",
				});
				remaining = 0;
			}
		}
		return out;
	};

	return (
		<Box flexDirection="column" width={width} height={height}>
			{/* Scrollable content */}
			{visible.map((line, i) => (
				<Box key={i}>
					{line.segments ? (
						<Text>
							{clampSegments(line.segments).map((seg, j) => (
								<Text key={j} color={seg.color as any} bold={seg.bold} dimColor={seg.dim}>
									{seg.text}
								</Text>
							))}
						</Text>
					) : (
						<Text color={line.color as any} bold={line.bold} dimColor={line.dim}>
							{line.text ? clamp(line.text) : " "}
						</Text>
					)}
				</Box>
			))}
			{scrollArrow && (
				<Box>
					<Text dimColor> </Text>
				</Box>
			)}
			{scrollArrow && (
				<Box>
					<Text dimColor>{scrollArrow}</Text>
				</Box>
			)}
		</Box>
	);
}
