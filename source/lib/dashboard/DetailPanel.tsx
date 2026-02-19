import { Box, Text } from "ink";
import type { DashboardIssue, WorktreeInfo } from "./types.js";
import type { PRInfo } from "../github.js";

interface Props {
	issue: DashboardIssue | null;
	scrollOffset: number;
	height: number;
	width: number;
	creatingForTicket: string | null;
	creationLogs: string;
}

type LineData = { text: string; color?: string; bold?: boolean; dim?: boolean };
type ActionItem = { key: string; label: string; color: string };
type ActionRow = ActionItem[];

function stateColor(type: string): string {
	switch (type) {
		case "started":
			return "green";
		case "unstarted":
			return "blue";
		case "backlog":
			return "gray";
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

function buildActions(worktree: WorktreeInfo | null, pr: PRInfo | null): ActionRow[] {
	const items: ActionItem[] = [];

	// Work/Resume
	if (worktree?.sessionId) {
		items.push({ key: "↵", label: "Resume", color: "cyan" });
	} else if (worktree) {
		items.push({ key: "w", label: "Work", color: "cyan" });
		items.push({ key: "↵", label: "Switch", color: "cyan" });
	} else {
		items.push({ key: "w", label: "Work", color: "cyan" });
	}

	// Editor
	if (worktree) {
		items.push({ key: "e", label: "Editor", color: "cyan" });
	}

	// Commit
	if (worktree?.dirty) {
		items.push({ key: "C", label: "Commit", color: "cyan" });
	}

	// PR actions
	if (worktree && !pr) {
		items.push({ key: "c", label: "Create PR", color: "cyan" });
	}
	if (pr) {
		items.push({ key: "f", label: "Fix PR", color: "cyan" });
		items.push({ key: "r", label: "Review", color: "cyan" });
	}

	// Links
	items.push({ key: "o", label: "Linear", color: "gray" });
	if (pr) items.push({ key: "p", label: "Open PR", color: "gray" });

	// Destructive
	if (worktree) {
		items.push({ key: "d", label: "Remove", color: "red" });
	}

	return [items];
}

export default function DetailPanel({
	issue,
	scrollOffset,
	height,
	width,
	creatingForTicket,
	creationLogs,
}: Props) {
	// Show creation logs when selected issue is being created
	if (issue && issue.issue.identifier === creatingForTicket) {
		const logLines = creationLogs.split("\n");
		const contentRows = height - 1;
		const startIdx = Math.max(0, logLines.length - contentRows);
		const visible = logLines.slice(startIdx, startIdx + contentRows);

		return (
			<Box flexDirection="column" width={width} height={height}>
				<Text color="yellow" bold>
					Setting up worktree for {creatingForTicket}...
				</Text>
				{visible.map((line, i) => (
					<Box key={i}>
						<Text dimColor>{line}</Text>
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

	// ── Hero: identifier + title ──────────────────────────────────────
	lines.push({ text: `${li.identifier}  ${li.title}`, bold: true });
	const meta: string[] = [];
	meta.push(li.state.name);
	meta.push(li.priorityLabel);
	if (li.labels.length > 0) meta.push(li.labels.join(", "));
	lines.push({ text: meta.join(" · "), color: stateColor(li.state.type) });

	// ── Description ───────────────────────────────────────────────────
	if (li.description) {
		lines.push({ text: rule, dim: true });
		lines.push({ text: "" });
		for (const dLine of li.description.trimEnd().split("\n")) {
			lines.push({ text: dLine });
		}
		lines.push({ text: "" });
	}

	// ── Worktree (enhanced) ───────────────────────────────────────────
	lines.push({ text: rule, dim: true });
	lines.push({ text: "WORKTREE", dim: true });
	if (worktree) {
		lines.push({ text: `  ${worktree.branch}` });
		lines.push({ text: `  ${worktree.path}`, dim: true });

		const gs = parseGitStatus(worktree.gitStatus);
		const statusParts: string[] = [];
		if (gs.staged > 0) statusParts.push(`+${gs.staged} staged`);
		if (gs.unstaged > 0) statusParts.push(`~${gs.unstaged} unstaged`);
		if (gs.untracked > 0) statusParts.push(`?${gs.untracked} untracked`);
		if (worktree.commitsAhead > 0) statusParts.push(`+${worktree.commitsAhead} ahead`);

		if (statusParts.length > 0) {
			lines.push({
				text: `  ${statusParts.join("  ")}`,
				color: worktree.dirty ? "yellow" : "green",
			});
		} else {
			lines.push({ text: "  ✓ clean", color: "green" });
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

		if (worktree.sessionId) {
			lines.push({ text: `  session: ${worktree.sessionId}`, color: "cyan" });
		} else {
			lines.push({ text: "  session: none", color: "red" });
		}
	} else {
		lines.push({ text: "  –", dim: true });
	}

	// ── Pull Request ──────────────────────────────────────────────────
	const { checks, reviews } = issue;
	lines.push({ text: rule, dim: true });
	lines.push({ text: "PULL REQUEST", dim: true });
	if (pr) {
		const sc = pr.state === "MERGED" ? "magenta" : pr.state === "OPEN" ? "green" : "red";
		const draft = pr.isDraft ? " draft" : "";
		lines.push({ text: `  #${pr.number} ${pr.state}${draft}`, color: sc });
		if (pr.url) {
			lines.push({ text: `  ${pr.url}`, dim: true });
		}
	} else {
		lines.push({ text: "  –", dim: true });
	}

	// ── Checks ────────────────────────────────────────────────────────
	if (checks && checks.length > 0) {
		const passCount = checks.filter((c) => c.bucket === "pass").length;
		lines.push({ text: rule, dim: true });
		lines.push({ text: `CHECKS  ${passCount}/${checks.length} passing`, dim: true });
		for (const check of checks) {
			if (check.bucket === "pass") {
				lines.push({ text: `  ✓ ${check.name}`, color: "green" });
			} else if (check.bucket === "fail") {
				const desc = check.description ? ` — ${check.description}` : "";
				lines.push({ text: `  ✗ ${check.name}${desc}`, color: "red" });
			} else {
				lines.push({ text: `  ● ${check.name} (pending)`, color: "yellow" });
			}
		}
	}

	// ── Reviews ───────────────────────────────────────────────────────
	if (reviews && reviews.length > 0) {
		lines.push({ text: rule, dim: true });
		lines.push({ text: "REVIEWS", dim: true });
		for (const review of reviews) {
			const author = review.author.login;
			const rc =
				review.state === "APPROVED"
					? "green"
					: review.state === "CHANGES_REQUESTED"
						? "red"
						: "yellow";
			lines.push({ text: `  ${author}  ${review.state}`, color: rc });
		}
	}

	// ── Build actions footer ──────────────────────────────────────────
	const actionRows = buildActions(worktree, pr);
	// +1 for the separator line
	const actionsHeight = actionRows.length + 1;
	const scrollableHeight = height - actionsHeight;

	// ── Render scrollable content ─────────────────────────────────────
	const totalLines = lines.length;
	const canScroll = totalLines > scrollableHeight;
	const contentRows = canScroll ? scrollableHeight - 2 : scrollableHeight;
	const clampedOffset = Math.min(scrollOffset, Math.max(0, totalLines - contentRows));
	const visible = lines.slice(clampedOffset, clampedOffset + contentRows);

	let scrollArrow: string | null = null;
	if (canScroll) {
		const atTop = clampedOffset === 0;
		const atBottom = clampedOffset + contentRows >= totalLines;
		scrollArrow = atTop ? "↓ scroll" : atBottom ? "↑ scroll" : "↑↓ scroll";
	}

	return (
		<Box flexDirection="column" width={width} height={height}>
			{/* Scrollable content */}
			{visible.map((line, i) => (
				<Box key={i}>
					<Text color={line.color as any} bold={line.bold} dimColor={line.dim}>
						{line.text || " "}
					</Text>
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

			{/* Spacer pushes actions to bottom */}
			<Box flexGrow={1} />

			{/* Fixed actions footer */}
			<Box>
				<Text dimColor>{rule}</Text>
			</Box>
			{actionRows.map((row, i) => (
				<Box key={`a-${i}`}>
					{row.map((item, j) => (
						<Text key={j}>
							{"  "}
							<Text color={item.color} bold>
								{item.key}
							</Text>
							<Text color={item.color === "gray" ? "gray" : "white"}> {item.label}</Text>
						</Text>
					))}
				</Box>
			))}
		</Box>
	);
}
