import { Box, Text } from "ink";
import type { PRCheck } from "../github.js";
import type { FixLoopRuntime } from "../fix-loop.js";
import type { ProjectGroup, DashboardIssue } from "./types.js";
import { formatSla, isSnoozed } from "./sla.js";
import { issueReadiness } from "../trackers/types.js";

interface Props {
	groups: ProjectGroup[];
	flatIssues: DashboardIssue[];
	selectedIndex: number;
	scrollOffset: number;
	height: number;
	width: number;
	/** Theme-adapted selection background (light/dark). Falls back to dark navy. */
	selectionBg?: string;
	/** Right-column variant (row structure — and click→row mapping — is identical):
	 *   "default" — WT + CI status columns (Trees tab)
	 *   "triage"  — a colored SLA-countdown badge
	 *   "issues"  — a readiness glyph (ready / blocked by dependencies) */
	variant?: "default" | "triage" | "issues";
	/** Ticket ids whose worktree is currently being removed — shown with a
	 * distinct WT-column glyph so concurrent deletions are visible in the list. */
	deletingIds?: Set<string>;
	/** Active/recent auto-fix loops by ticket id — a running/stalled loop shows a
	 * ⟳ in place of the CI glyph (the loop is the CI story while it runs). */
	fixLoops?: Record<string, FixLoopRuntime>;
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
	// `gh` buckets: pass | fail | pending | skipping | cancel. Only `fail` blocks
	// (red) and only `pending` is genuinely still running (yellow). `skipping` /
	// `cancel` don't run under the current conditions and don't block — GitHub
	// reports them as "skipped" and still shows "all checks passed", so they must
	// not turn the glyph yellow.
	if (checks.some((c) => c.bucket === "fail")) return { glyph: "✗", color: "red" };
	if (checks.some((c) => c.bucket === "pending")) return { glyph: "●", color: "yellow" };
	return { glyph: "✓", color: "green" };
}

/**
 * While a fix loop is actively running (or stalled), it owns the CI column — a ⟳
 * conveys "being auto-fixed" better than the underlying check state. Stopped loops
 * fall back to the real CI glyph (CI green ≈ stopped clean, CI red ≈ stopped stuck).
 */
function fixLoopOverride(
	loop: FixLoopRuntime | undefined,
): { glyph: string; color: string } | null {
	if (!loop) return null;
	if (loop.phase === "running") return { glyph: "⟳", color: "cyan" };
	if (loop.phase === "stalled") return { glyph: "⟳", color: "yellow" };
	return null;
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
			// A blank status name suppresses the per-status sub-header (used by the
			// Triage tab, where the single group needs no "Triage" header). Both the
			// renderer and the click→row mapper call this builder, so skipping a row
			// here keeps their indices aligned automatically.
			if (sg.name) {
				rows.push({ kind: "status-header", name: sg.name, type: sg.type, count: sg.issues.length });
			}
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
// Triage variant: a single right-aligned SLA-countdown column. Widest badge is
// "breached" (8 chars); pad/clamp everything to this so titles align.
const SLA_COL_WIDTH = 8;
// Issues variant: a single readiness glyph under a "RDY" header.
const READY_COL_WIDTH = 3;
const TITLE_GAP = 2; // minimum spacing between title and the right columns

function readinessGlyph(di: DashboardIssue): { glyph: string; color: string } {
	switch (issueReadiness(di.issue.blockedBy)) {
		case "ready":
			return { glyph: "✓", color: "green" };
		case "blocked":
			return { glyph: "⊘", color: "yellow" };
		default:
			return { glyph: "·", color: "gray" };
	}
}

export default function IssueList({
	groups,
	flatIssues,
	selectedIndex,
	scrollOffset,
	height,
	width,
	selectionBg = "#1e3a5f",
	variant = "default",
	deletingIds,
	fixLoops,
}: Props) {
	const isTriage = variant === "triage";
	const isIssues = variant === "issues";
	const rightFixed = isTriage ? SLA_COL_WIDTH : isIssues ? READY_COL_WIDTH : RIGHT_FIXED;
	const rows = buildIssueListRows(groups, flatIssues);
	const visible = rows.slice(scrollOffset, scrollOffset + height);
	const titleMaxWidth = Math.max(
		width - LEFT_FIXED - 1 /* leading space */ - rightFixed - TITLE_GAP,
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
						const labelText = isTriage ? "SLA" : isIssues ? "RDY" : "WT CI";
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
					// Snoozed triage rows are parked work: grey them out (dot + id +
					// title + SLA) so the active items the user should pick up stand out.
					const snoozed = isTriage && isSnoozed(di.issue.snoozedUntilAt);
					const sc = snoozed ? "gray" : stateColor(di.issue.state.type, di.issue.state.name);
					const prio = snoozed ? { glyph: " ", color: "gray" } : priorityMarker(di.issue.priority);
					const isDeleting = deletingIds?.has(di.issue.identifier) ?? false;
					const work = isDeleting ? { glyph: "⌫", color: "yellow" } : workIndicator(di.worktree);
					const ci = fixLoopOverride(fixLoops?.[di.issue.identifier]) ?? ciIndicator(di.checks);
					const nestPrefix = depth > 0 ? "  ".repeat(depth - 1) + "└ " : "";
					const adjustedTitleWidth = Math.max(titleMaxWidth - nestPrefix.length, 5);
					const title =
						di.issue.title.length > adjustedTitleWidth
							? di.issue.title.slice(0, adjustedTitleWidth - 1) + "…"
							: di.issue.title;

					const bg = selected ? selectionBg : undefined;

					// Pad between title and the right columns so the markers stay
					// pinned to the right edge regardless of title length.
					const trailingPad = Math.max(
						0,
						width - LEFT_FIXED - 1 - nestPrefix.length - title.length - rightFixed,
					);

					// Triage variant: a single right-aligned SLA-countdown badge in
					// place of the WT/CI columns. Snoozed rows show it greyed.
					const sla = isTriage ? formatSla(di.issue.slaBreachesAt) : null;
					const slaColor = snoozed ? "gray" : sla?.color;
					const slaText = (sla?.label ?? "").padStart(SLA_COL_WIDTH).slice(-SLA_COL_WIDTH);
					// Issues variant: a single readiness glyph right-aligned under "RDY".
					const ready = isIssues ? readinessGlyph(di) : null;

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
							<Text backgroundColor={bg} bold={selected} color={snoozed ? "gray" : undefined}>
								{" "}
								{title}
							</Text>
							<Text backgroundColor={bg}>{" ".repeat(trailingPad)}</Text>
							{isTriage ? (
								<Text backgroundColor={bg} color={slaColor} bold={!snoozed && sla?.urgent}>
									{slaText}
								</Text>
							) : isIssues ? (
								<Text backgroundColor={bg} color={ready?.color}>
									{`  ${ready?.glyph ?? " "}`}
								</Text>
							) : (
								<>
									<Text backgroundColor={bg}> </Text>
									<Text backgroundColor={bg} color={work.color}>
										{work.glyph}
									</Text>
									<Text backgroundColor={bg}>{"  "}</Text>
									<Text backgroundColor={bg}> </Text>
									<Text backgroundColor={bg} color={ci.color}>
										{ci.glyph}
									</Text>
								</>
							)}
						</Box>
					);
				})}
			</Box>
		</Box>
	);
}
