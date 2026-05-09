import { Box, Text } from "ink";
import type { EnrichedReviewPR } from "./types.js";

interface Props {
	item: EnrichedReviewPR | null;
	scrollOffset: number;
	height: number;
	width: number;
}

type Segment = { text: string; color?: string; bold?: boolean; dim?: boolean };
type LineData = {
	text: string;
	color?: string;
	bold?: boolean;
	dim?: boolean;
	segments?: Segment[];
};
export type ReviewActionItem = { key: string; label: string; color: string };

function relativeTime(dateStr: string): string {
	const now = Date.now();
	const then = new Date(dateStr).getTime();
	const diffMs = now - then;
	const minutes = Math.floor(diffMs / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	const months = Math.floor(days / 30);
	return `${months}mo ago`;
}

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
		default:
			return "yellow";
	}
}

/**
 * Action footer for the reviews tab. The factory mirrors `buildIssueActions`
 * over in DetailPanel — same shape so the dashboard's action-row renderer
 * doesn't need a per-tab branch. Disabled-state semantics: when an action
 * doesn't apply (no ticket, no worktree), we omit the entry rather than
 * dimming it, matching the issues tab's convention.
 */
export function buildReviewActions(item: EnrichedReviewPR): ReviewActionItem[] {
	const items: ReviewActionItem[] = [];

	if (item.worktree) {
		items.push({ key: "r", label: "AI Review", color: "cyan" });
		items.push({ key: "e", label: "Editor", color: "cyan" });
	} else {
		items.push({ key: "w", label: "Checkout", color: "cyan" });
	}

	items.push({ key: "v", label: "View diff", color: "cyan" });

	if (item.ticket) {
		items.push({ key: "o", label: "Open ticket", color: "gray" });
	}
	items.push({ key: "p", label: "Open PR", color: "gray" });

	if (item.worktree) {
		items.push({ key: "d", label: "Remove", color: "red" });
	}

	return items;
}

export default function ReviewDetailPanel({ item, scrollOffset, height, width }: Props) {
	if (!item) {
		return (
			<Box width={width} height={height} justifyContent="center" alignItems="center">
				<Text dimColor>No PR selected</Text>
			</Box>
		);
	}

	const { pr, ticket, worktree, checks, reviews, comments } = item;
	const lines: LineData[] = [];
	const rule = "─".repeat(width);
	const ruleLine: LineData = { text: rule, dim: true };

	// ── Hero ──────────────────────────────────────────────────────────
	lines.push({ text: `#${pr.number}  ${pr.title}`, bold: true });

	// Labeled metadata block — author + lines changed live here (the list
	// strips them to keep navigation tight). Two-column "label  value" rows
	// keep the eye scannable.
	const labelWidth = 9;
	const lbl = (s: string) => s.padEnd(labelWidth);
	// Display name first; login is the unique handle, parenthesized so the
	// reviewer can still recognize someone they only know by username.
	const authorSegs: Segment[] = [
		{ text: "  " },
		{ text: lbl("Author"), dim: true },
		{ text: item.authorName ?? pr.author.login, color: "cyan" },
	];
	if (item.authorName) {
		authorSegs.push({ text: "  " });
		authorSegs.push({ text: `@${pr.author.login}`, dim: true });
	}
	if (pr.isDraft) {
		authorSegs.push({ text: "  " });
		authorSegs.push({ text: "draft", color: "yellow" });
	}
	lines.push({ text: "", segments: authorSegs });

	const changeSegs: Segment[] = [{ text: "  " }, { text: lbl("Changed"), dim: true }];
	if (item.additions > 0 || item.deletions > 0 || item.changedFiles > 0) {
		changeSegs.push({ text: `+${item.additions}`, color: "green" });
		changeSegs.push({ text: " " });
		changeSegs.push({ text: `−${item.deletions}`, color: "red" });
		changeSegs.push({ text: "   " });
		changeSegs.push({
			text: `${item.changedFiles} file${item.changedFiles === 1 ? "" : "s"}`,
			dim: true,
		});
	} else {
		changeSegs.push({ text: "—", dim: true });
	}
	lines.push({ text: "", segments: changeSegs });

	lines.push({
		text: "",
		segments: [
			{ text: "  " },
			{ text: lbl("Updated"), dim: true },
			{ text: relativeTime(pr.updatedAt) },
		],
	});

	// ── Linked Ticket ─────────────────────────────────────────────────
	// Only rendered when the active tracker resolved an issue from the PR's
	// branch — gives the reviewer the same "why does this PR exist" context
	// the issues tab has always had.
	if (ticket) {
		lines.push(ruleLine);
		const tc = stateColor(ticket.state.type);
		const ticketHeader: Segment[] = [
			{ text: "◎ ", color: "cyan", bold: true },
			{ text: ticket.identifier, bold: true },
			{ text: "  " },
			{ text: ticket.title },
		];
		lines.push({ text: "", segments: ticketHeader });
		const ticketStatus: Segment[] = [
			{ text: "  ● ", color: tc },
			{ text: ticket.state.name, color: tc },
			{ text: "  ·  ", dim: true },
			{ text: ticket.priorityLabel },
		];
		if (ticket.labels.length > 0) {
			ticketStatus.push({ text: "  ·  ", dim: true });
			ticketStatus.push({ text: ticket.labels.join(", "), dim: true });
		}
		lines.push({ text: "", segments: ticketStatus });
		if (ticket.description) {
			lines.push({ text: "" });
			for (const dLine of ticket.description.trimEnd().split("\n")) {
				lines.push({ text: dLine });
			}
		}
	}

	// ── Pull Request ──────────────────────────────────────────────────
	lines.push(ruleLine);
	const prDraft = pr.isDraft ? " · draft" : "";
	lines.push({
		text: "",
		segments: [
			{ text: "◉ ", color: "cyan", bold: true },
			{ text: "Pull Request", bold: true },
			{ text: "   " },
			{ text: `#${pr.number}`, color: "green", bold: true },
			{ text: "  " },
			{ text: "OPEN", color: "green" },
			{ text: prDraft, dim: true },
		],
	});
	if (pr.url) {
		lines.push({ text: `  ${pr.url}`, dim: true });
	}

	// ── Branch ────────────────────────────────────────────────────────
	if (item.branch) {
		lines.push(ruleLine);
		lines.push({
			text: "",
			segments: [
				{ text: "⎇ ", color: "cyan", bold: true },
				{ text: "Branch", bold: true },
				{ text: "   " },
				{ text: item.branch },
				...(item.baseBranch
					? ([
							{ text: "  " },
							{ text: "→", dim: true },
							{ text: " " },
							{ text: item.baseBranch, dim: true },
						] as Segment[])
					: ([] as Segment[])),
			],
		});
	}

	// ── Worktree ──────────────────────────────────────────────────────
	if (worktree) {
		lines.push(ruleLine);
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
		lines.push({ text: `  ${worktree.path}`, dim: true });
		if (worktree.commitsAhead > 0) {
			lines.push({
				text: "",
				segments: [{ text: "  " }, { text: `↑ ${worktree.commitsAhead} ahead`, color: "cyan" }],
			});
		}
	}

	// ── Description (PR body) ─────────────────────────────────────────
	if (item.body) {
		lines.push(ruleLine);
		lines.push({
			text: "",
			segments: [
				{ text: "✎ ", color: "cyan", bold: true },
				{ text: "Description", bold: true },
			],
		});
		for (const line of item.body.trimEnd().split("\n")) {
			lines.push({ text: line });
		}
	}

	// ── Checks ────────────────────────────────────────────────────────
	if (checks && checks.length > 0) {
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
	if (reviews && reviews.length > 0) {
		lines.push(ruleLine);
		lines.push({
			text: "",
			segments: [
				{ text: "★ ", color: "cyan", bold: true },
				{ text: "Reviews", bold: true },
			],
		});
		for (const review of reviews) {
			const rc =
				review.state === "APPROVED"
					? "green"
					: review.state === "CHANGES_REQUESTED"
						? "red"
						: "yellow";
			lines.push({
				text: "",
				segments: [
					{ text: `  ${review.author.login}` },
					{ text: "   " },
					{ text: review.state, color: rc },
				],
			});
		}
	}

	// ── Comments ──────────────────────────────────────────────────────
	if (comments && comments.length > 0) {
		lines.push(ruleLine);
		lines.push({
			text: "",
			segments: [
				{ text: "● ", color: "cyan", bold: true },
				{ text: "Comments", bold: true },
				{ text: "   " },
				{ text: `${comments.length}`, dim: true },
			],
		});
		// Show last 5 comments
		const recent = comments.slice(-5);
		for (const comment of recent) {
			lines.push({ text: "" });
			lines.push({
				text: "",
				segments: [
					{ text: `  ${comment.author}`, color: "cyan" },
					{ text: "   " },
					{ text: relativeTime(comment.createdAt), dim: true },
				],
			});
			const bodyLines = comment.body.trimEnd().split("\n");
			const maxLines = 4;
			for (let i = 0; i < Math.min(bodyLines.length, maxLines); i++) {
				lines.push({ text: `  ${bodyLines[i]}` });
			}
			if (bodyLines.length > maxLines) {
				lines.push({ text: `  +${bodyLines.length - maxLines} more lines`, dim: true });
			}
		}
	}

	// ── Render with scroll handling ───────────────────────────────────
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

	// Pre-truncate to the panel width — Ink's `wrap="truncate"` on segments
	// inside flex rows is unreliable and lets long URLs/branch names spill onto
	// the next row, shifting everything down. Mirrors DetailPanel's clampers.
	const clamp = (text: string) =>
		text.length > width ? text.slice(0, Math.max(0, width - 1)) + "…" : text;
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
		<Box flexDirection="column" width={width} height={height} overflowX="hidden">
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
