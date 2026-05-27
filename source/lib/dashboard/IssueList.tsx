import { Box, Text } from "ink";
import type { PRCheck } from "../github.js";
import type { ProjectGroup, DashboardIssue } from "./types.js";

interface Props {
	groups: ProjectGroup[];
	flatIssues: DashboardIssue[];
	selectedIndex: number;
	scrollOffset: number;
	height: number;
	width: number;
	/** Theme-adapted selection background (light/dark). Falls back to dark navy. */
	selectionBg?: string;
}

function stateColor(type: string, name?: string): string {
	const n = name?.toLowerCase();
	if (n === "blocked") return "red";
	if (n === "in review") return "green";
	if (n === "in progress") return "yellow";
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

/**
 * One-character priority marker, only rendered for urgent (P1) and high (P2)
 * — everything else is a single space so columns still align. This is one of
 * the few places we use color, so it stands out without shouting.
 */
function priorityMarker(priority: number): { glyph: string; color: string } {
	if (priority === 1) return { glyph: "▎", color: "red" };
	if (priority === 2) return { glyph: "▎", color: "yellow" };
	return { glyph: " ", color: "gray" };
}

function workIndicator(wt: DashboardIssue["worktree"]): { glyph: string; color: string } {
	if (!wt) return { glyph: "·", color: "gray" };
	return { glyph: "✓", color: "green" };
}

function ciIndicator(checks: PRCheck[] | null): { glyph: string; color: string } {
	if (!checks || checks.length === 0) return { glyph: "·", color: "gray" };
	if (checks.some((c) => c.bucket === "fail")) return { glyph: "✗", color: "red" };
	if (checks.every((c) => c.bucket === "pass")) return { glyph: "✓", color: "green" };
	return { glyph: "●", color: "yellow" };
}

export type ListRow =
	| { kind: "spacer" }
	| { kind: "header"; name: string; count: number; isFirst: boolean }
	| { kind: "status-header"; name: string; type: string; count: number }
	| { kind: "issue"; issue: DashboardIssue; flatIndex: number; depth: number };

export function buildIssueListRows(
	groups: ProjectGroup[],
	flatIssues: DashboardIssue[],
): ListRow[] {
	const rows: ListRow[] = [];
	const indexMap = new Map<string, number>();
	flatIssues.forEach((di, i) => indexMap.set(di.issue.identifier, i));

	function pushIssueWithChildren(di: DashboardIssue, depth: number) {
		const flatIndex = indexMap.get(di.issue.identifier) ?? -1;
		rows.push({ kind: "issue", issue: di, flatIndex, depth });
		if (di.children) {
			for (const child of di.children) {
				pushIssueWithChildren(child, depth + 1);
			}
		}
	}

	groups.forEach((group, gi) => {
		const totalIssues = group.statusGroups.reduce((sum, sg) => sum + sg.issues.length, 0);
		// Blank line between projects. Modelled as a real row (not a render-only
		// `marginTop`) so `rows[]` indices line up 1:1 with rendered rows —
		// otherwise the dashboard's click→row mapping drifts by one per project.
		if (gi > 0) rows.push({ kind: "spacer" });
		rows.push({ kind: "header", name: group.name, count: totalIssues, isFirst: gi === 0 });
		for (const sg of group.statusGroups) {
			rows.push({ kind: "status-header", name: sg.name, type: sg.type, count: sg.issues.length });
			for (const di of sg.issues) {
				pushIssueWithChildren(di, 0);
			}
		}
	});
	return rows;
}

// Issue row anatomy:
//   priority(1) │ space(1) │ dot(1) │ space(2) │ id(11) │ space(1) │ title(rest) │ pad │ WT(2) │ space(2) │ CI(2)
// Each right-side column is 2 chars wide (matching the 2-char header label).
// Glyphs are 1 char and rendered right-aligned within their column.
const LEFT_FIXED = 1 + 1 + 1 + 2 + 11; // 16 — left-aligned columns
const RIGHT_FIXED = 2 + 2 + 2; // 6 — WT + 2 spaces + CI
const TITLE_GAP = 2; // minimum spacing between title and the right columns

export default function IssueList({
	groups,
	flatIssues,
	selectedIndex,
	scrollOffset,
	height,
	width,
	selectionBg = "#1e3a5f",
}: Props) {
	const rows = buildIssueListRows(groups, flatIssues);
	const visible = rows.slice(scrollOffset, scrollOffset + height);
	const titleMaxWidth = Math.max(
		width - LEFT_FIXED - 1 /* leading space */ - RIGHT_FIXED - TITLE_GAP,
		10,
	);

	return (
		<Box flexDirection="column" width={width} height={height}>
			{/* List content */}
			<Box flexDirection="column" height={height}>
				{visible.map((row, i) => {
					if (row.kind === "spacer") {
						return <Box key={`sp-${i}`} height={1} />;
					}

					if (row.kind === "header") {
						// On the first project header, also render the WT/CI column
						// labels right-aligned to the worktree/CI glyph columns —
						// keeps the labels discoverable without burning a row.
						// Label "WT CI" is 5 chars; the "W" lines up with the WT
						// glyph at column (width - RIGHT_FIXED + 1).
						const namePart = `${row.name}  ${row.count}`;
						const labelText = "WT CI";
						const labelPad = row.isFirst
							? Math.max(2, width - namePart.length - labelText.length)
							: 0;
						return (
							<Box key={`h-${i}`}>
								<Text bold>{row.name}</Text>
								<Text dimColor>
									{"  "}
									{row.count}
								</Text>
								{row.isFirst && <Text dimColor>{`${" ".repeat(labelPad)}${labelText}`}</Text>}
							</Box>
						);
					}

					if (row.kind === "status-header") {
						return (
							<Box key={`sh-${i}`}>
								<Text color={stateColor(row.type, row.name)}>
									{"  "}
									{row.name}
								</Text>
								<Text dimColor>
									{"  "}
									{row.count}
								</Text>
							</Box>
						);
					}

					const { issue, flatIndex, depth } = row;
					const selected = flatIndex === selectedIndex;
					const di = issue;
					const sc = stateColor(di.issue.state.type, di.issue.state.name);
					const prio = priorityMarker(di.issue.priority);
					const work = workIndicator(di.worktree);
					const ci = ciIndicator(di.checks);
					const nestPrefix = depth > 0 ? "  ".repeat(depth - 1) + "└ " : "";
					const adjustedTitleWidth = Math.max(titleMaxWidth - nestPrefix.length, 5);
					const title =
						di.issue.title.length > adjustedTitleWidth
							? di.issue.title.slice(0, adjustedTitleWidth - 1) + "…"
							: di.issue.title;

					const bg = selected ? selectionBg : undefined;

					// Pad between title and the right columns so the W/CI markers stay
					// pinned to the right edge regardless of title length.
					const trailingPad = Math.max(
						0,
						width - LEFT_FIXED - 1 - nestPrefix.length - title.length - RIGHT_FIXED,
					);

					return (
						<Box key={di.issue.identifier} width={width}>
							<Text backgroundColor={bg} color={prio.color}>
								{prio.glyph}
							</Text>
							<Text backgroundColor={bg}> </Text>
							<Text backgroundColor={bg} color={sc}>
								●
							</Text>
							<Text backgroundColor={bg}>{"  "}</Text>
							<Text backgroundColor={bg} dimColor>
								{nestPrefix}
								{di.issue.identifier.padEnd(10)}
							</Text>
							<Text backgroundColor={bg} bold={selected}>
								{" "}
								{title}
							</Text>
							<Text backgroundColor={bg}>{" ".repeat(trailingPad)}</Text>
							<Text backgroundColor={bg}> </Text>
							<Text backgroundColor={bg} color={work.color}>
								{work.glyph}
							</Text>
							<Text backgroundColor={bg}>{"  "}</Text>
							<Text backgroundColor={bg}> </Text>
							<Text backgroundColor={bg} color={ci.color}>
								{ci.glyph}
							</Text>
						</Box>
					);
				})}
			</Box>
		</Box>
	);
}
