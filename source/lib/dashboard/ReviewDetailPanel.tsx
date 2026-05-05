import { Box, Text } from "ink";
import type { EnrichedReviewPR } from "./types.js";

interface Props {
	item: EnrichedReviewPR | null;
	scrollOffset: number;
	height: number;
	width: number;
}

type LineData = { text: string; color?: string; bold?: boolean; dim?: boolean };
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

export function buildReviewActions(item: EnrichedReviewPR): ReviewActionItem[] {
	const items: ReviewActionItem[] = [];

	if (item.worktree) {
		items.push({ key: "r", label: "AI Review", color: "cyan" });
		items.push({ key: "e", label: "Editor", color: "cyan" });
	} else {
		items.push({ key: "w", label: "Checkout", color: "cyan" });
	}

	items.push({ key: "o", label: "Open PR", color: "gray" });

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

	const { pr } = item;
	const lines: LineData[] = [];
	const rule = "\u2500".repeat(width);

	// ── Hero ──────────────────────────────────────────────────────────
	lines.push({ text: `#${pr.number}  ${pr.title}`, bold: true });
	const meta: string[] = [`by ${pr.author.login}`];
	if (pr.isDraft) meta.push("draft");
	meta.push(relativeTime(pr.updatedAt));
	lines.push({ text: meta.join(" \u00b7 "), color: "cyan" });

	// ── Changes ──────────────────────────────────────────────────────
	if (item.changedFiles > 0) {
		lines.push({
			text: `${item.changedFiles} files  +${item.additions} -${item.deletions}`,
			color: "green",
		});
	}

	// ── Branch ───────────────────────────────────────────────────────
	if (item.branch) {
		lines.push({ text: rule, dim: true });
		lines.push({ text: "BRANCH", dim: true });
		lines.push({ text: `  ${item.branch}` });
		if (item.baseBranch) {
			lines.push({ text: `  base: ${item.baseBranch}`, dim: true });
		}
	}

	// ── Worktree ─────────────────────────────────────────────────────
	if (item.worktree) {
		lines.push({ text: rule, dim: true });
		lines.push({ text: "WORKTREE", dim: true });
		lines.push({ text: `  ${item.worktree.path}`, dim: true });
		const statusParts: string[] = [];
		if (item.worktree.dirty) statusParts.push("dirty");
		if (item.worktree.commitsAhead > 0) statusParts.push(`+${item.worktree.commitsAhead} ahead`);
		if (statusParts.length > 0) {
			lines.push({ text: `  ${statusParts.join("  ")}`, color: "yellow" });
		} else {
			lines.push({ text: "  \u2713 clean", color: "green" });
		}
	}

	// ── Description ──────────────────────────────────────────────────
	if (item.body) {
		lines.push({ text: rule, dim: true });
		lines.push({ text: "DESCRIPTION", dim: true });
		lines.push({ text: "" });
		for (const line of item.body.trimEnd().split("\n")) {
			lines.push({ text: line });
		}
		lines.push({ text: "" });
	}

	// ── Checks ───────────────────────────────────────────────────────
	if (item.checks && item.checks.length > 0) {
		const passCount = item.checks.filter((c) => c.bucket === "pass").length;
		lines.push({ text: rule, dim: true });
		lines.push({ text: `CHECKS  ${passCount}/${item.checks.length} passing`, dim: true });
		for (const check of item.checks) {
			if (check.bucket === "pass") {
				lines.push({ text: `  \u2713 ${check.name}`, color: "green" });
			} else if (check.bucket === "fail") {
				const desc = check.description ? ` \u2014 ${check.description}` : "";
				lines.push({ text: `  \u2717 ${check.name}${desc}`, color: "red" });
			} else {
				lines.push({ text: `  \u25cf ${check.name} (pending)`, color: "yellow" });
			}
		}
	}

	// ── Reviews ──────────────────────────────────────────────────────
	if (item.reviews && item.reviews.length > 0) {
		lines.push({ text: rule, dim: true });
		lines.push({ text: "REVIEWS", dim: true });
		for (const review of item.reviews) {
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

	// ── Comments ─────────────────────────────────────────────────────
	if (item.comments && item.comments.length > 0) {
		lines.push({ text: rule, dim: true });
		lines.push({ text: `COMMENTS  ${item.comments.length}`, dim: true });
		// Show last 5 comments
		const recent = item.comments.slice(-5);
		for (const comment of recent) {
			lines.push({ text: "" });
			lines.push({
				text: `  ${comment.author}  ${relativeTime(comment.createdAt)}`,
				color: "cyan",
			});
			// Truncate long comments to ~4 lines
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

	// ── Build actions footer ─────────────────────────────────────────
	const totalLines = lines.length;
	const canScroll = totalLines > height;
	const contentRows = canScroll ? height - 2 : height;
	const clampedOffset = Math.min(scrollOffset, Math.max(0, totalLines - contentRows));
	const visible = lines.slice(clampedOffset, clampedOffset + contentRows);

	let scrollArrow: string | null = null;
	if (canScroll) {
		const atTop = clampedOffset === 0;
		const atBottom = clampedOffset + contentRows >= totalLines;
		scrollArrow = atTop ? "\u2193 scroll" : atBottom ? "\u2191 scroll" : "\u2191\u2193 scroll";
	}

	// Truncate lines to panel width to prevent overflow into left pane
	const clamp = (text: string) =>
		text.length > width ? text.slice(0, width - 1) + "\u2026" : text;

	return (
		<Box flexDirection="column" width={width} height={height} overflowX="hidden">
			{visible.map((line, i) => (
				<Box key={i}>
					<Text color={line.color as any} bold={line.bold} dimColor={line.dim}>
						{line.text ? clamp(line.text) : " "}
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
		</Box>
	);
}
