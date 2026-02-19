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
	creatingForTicket: string | null;
	deletingForTicket: string | null;
}

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

function priorityIndicator(priority: number): { text: string; color: string } {
	switch (priority) {
		case 1:
			return { text: "!!!", color: "red" };
		case 2:
			return { text: "!! ", color: "yellow" };
		case 3:
			return { text: "!  ", color: "blue" };
		case 4:
			return { text: "·  ", color: "gray" };
		default:
			return { text: "   ", color: "gray" };
	}
}

function checksIndicator(checks: PRCheck[] | null): { text: string; color: string } {
	if (!checks || checks.length === 0) return { text: "-", color: "gray" };
	if (checks.some((c) => c.bucket === "fail")) return { text: "✗", color: "red" };
	if (checks.every((c) => c.bucket === "pass")) return { text: "✓", color: "green" };
	return { text: "●", color: "yellow" };
}

function prIndicator(pr: DashboardIssue["pr"]): { text: string; color: string } {
	if (!pr) return { text: "-", color: "gray" };
	const label = `#${pr.number}`;
	if (pr.state === "MERGED") return { text: label, color: "magenta" };
	if (pr.state === "CLOSED") return { text: label, color: "red" };
	if (pr.isDraft) return { text: label, color: "gray" };
	return { text: label, color: "green" };
}

function sessionIndicator(
	wt: DashboardIssue["worktree"],
	isCreating: boolean,
	isDeleting: boolean,
): { text: string; color: string } {
	if (isDeleting) return { text: " deleting", color: "red" };
	if (isCreating) return { text: " creating", color: "yellow" };
	if (!wt) return { text: " -", color: "gray" };
	if (wt.sessionId) return { text: " " + wt.sessionId.slice(0, 8), color: "cyan" };
	return { text: " none", color: "red" };
}

type ListRow =
	| { kind: "columns" }
	| { kind: "header"; name: string; count: number }
	| { kind: "issue"; issue: DashboardIssue; flatIndex: number };

function buildRows(groups: ProjectGroup[], flatIssues: DashboardIssue[]): ListRow[] {
	const rows: ListRow[] = [{ kind: "columns" }];
	// Build a map from issue identifier to flat index
	const indexMap = new Map<string, number>();
	flatIssues.forEach((di, i) => indexMap.set(di.issue.identifier, i));

	for (const group of groups) {
		rows.push({ kind: "header", name: group.name, count: group.issues.length });
		for (const di of group.issues) {
			rows.push({ kind: "issue", issue: di, flatIndex: indexMap.get(di.issue.identifier) ?? -1 });
		}
	}
	return rows;
}

const FOOTER_HEIGHT = 2;

export default function IssueList({
	groups,
	flatIssues,
	selectedIndex,
	scrollOffset,
	height,
	width,
	creatingForTicket,
	deletingForTicket,
}: Props) {
	const rows = buildRows(groups, flatIssues);
	const listHeight = height - FOOTER_HEIGHT;
	const visible = rows.slice(scrollOffset, scrollOffset + listHeight);
	// 2 cursor + 2 dot + 4 priority + 11 id + title + 9 session + 1 space + 6 pr + 1 space + 2 checks
	const prColWidth = 6;
	const checksColWidth = 2;
	const sessionColWidth = 9;
	const priorityColWidth = 4;
	const fixedWidth =
		2 + 2 + priorityColWidth + 11 + sessionColWidth + 1 + prColWidth + 1 + checksColWidth;
	const titleMaxWidth = Math.max(width - fixedWidth, 10);
	const footerRule = "─".repeat(width);

	return (
		<Box flexDirection="column" width={width} height={height}>
			{/* List content */}
			<Box flexDirection="column" height={listHeight}>
				{visible.map((row, i) => {
					if (row.kind === "columns") {
						const labelPad = 14 + priorityColWidth + titleMaxWidth;
						return (
							<Box key="col-header">
								<Text dimColor>{"".padEnd(labelPad)}</Text>
								<Text dimColor>{"session".padStart(sessionColWidth)}</Text>
								<Text dimColor> </Text>
								<Text dimColor>{"pr".padStart(prColWidth)}</Text>
								<Text dimColor> </Text>
								<Text dimColor>{"ci".padStart(checksColWidth)}</Text>
							</Box>
						);
					}

					if (row.kind === "header") {
						return (
							<Box key={`h-${i}`}>
								<Text dimColor bold>
									{"── "}
									{row.name} ({row.count}){" ──"}
								</Text>
							</Box>
						);
					}

					const { issue, flatIndex } = row;
					const selected = flatIndex === selectedIndex;
					const di = issue;
					const sc = stateColor(di.issue.state.type);
					const isCreating = di.issue.identifier === creatingForTicket;
					const isDeleting = di.issue.identifier === deletingForTicket;
					const sess = sessionIndicator(di.worktree, isCreating, isDeleting);
					const ci = checksIndicator(di.checks);
					const pr = prIndicator(di.pr);
					const prio = priorityIndicator(di.issue.priority);
					const cursor = selected ? ">" : " ";
					const title =
						di.issue.title.length > titleMaxWidth
							? di.issue.title.slice(0, titleMaxWidth - 1) + "…"
							: di.issue.title;

					const bg = selected ? "#1e3a5f" : undefined;

					return (
						<Box key={di.issue.identifier} width={width}>
							<Text backgroundColor={bg} color={selected ? "cyan" : undefined} bold={selected}>
								{cursor}{" "}
							</Text>
							<Text backgroundColor={bg} color={sc}>
								●
							</Text>
							<Text backgroundColor={bg} color={prio.color}>
								{" "}
								{prio.text}
							</Text>
							<Text backgroundColor={bg} color={selected ? "cyan" : undefined} bold={selected}>
								{di.issue.identifier.padEnd(10)}
							</Text>
							<Text backgroundColor={bg} color={selected ? "white" : undefined} bold={selected}>
								{title.padEnd(titleMaxWidth)}
							</Text>
							<Text
								backgroundColor={bg}
								color={selected ? (sess.color === "gray" ? "gray" : sess.color) : sess.color}
							>
								{sess.text.padStart(sessionColWidth)}
							</Text>
							<Text backgroundColor={bg}> </Text>
							<Text
								backgroundColor={bg}
								color={selected ? (pr.color === "gray" ? "gray" : pr.color) : pr.color}
							>
								{pr.text.padStart(prColWidth)}
							</Text>
							<Text backgroundColor={bg}> </Text>
							<Text
								backgroundColor={bg}
								color={selected ? (ci.color === "gray" ? "gray" : ci.color) : ci.color}
							>
								{ci.text.padStart(checksColWidth)}
							</Text>
						</Box>
					);
				})}
			</Box>

			{/* Fixed footer */}
			<Box flexDirection="column">
				<Text dimColor>{footerRule}</Text>
				<Text>
					{"  "}
					<Text color="cyan" bold>
						j/k
					</Text>
					<Text color="white"> Navigate</Text>
					{"   "}
					<Text color="cyan" bold>
						Shift + ↑↓
					</Text>
					<Text color="white"> Scroll detail</Text>
					{"   "}
					<Text color="cyan" bold>
						E
					</Text>
					<Text color="white"> Workspace</Text>
					{"   "}
					<Text color="cyan" bold>
						R
					</Text>
					<Text color="white"> Refresh</Text>
					{"   "}
					<Text color="cyan" bold>
						q
					</Text>
					<Text color="white"> Quit</Text>
				</Text>
			</Box>
		</Box>
	);
}
