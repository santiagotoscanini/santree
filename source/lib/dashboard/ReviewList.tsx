import React from "react";
import { Box, Text } from "ink";
import type { EnrichedReviewPR } from "./types.js";
import type { PRCheck } from "../github.js";

interface Props {
	flatReviews: EnrichedReviewPR[];
	selectedIndex: number;
	scrollOffset: number;
	height: number;
	width: number;
	/** Theme-adapted selection background. Falls back to dark navy. */
	selectionBg?: string;
}

function checksIndicator(checks: PRCheck[] | null): { text: string; color: string } {
	if (!checks || checks.length === 0) return { text: "-", color: "gray" };
	if (checks.some((c) => c.bucket === "fail")) return { text: "✗", color: "red" };
	if (checks.every((c) => c.bucket === "pass")) return { text: "✓", color: "green" };
	return { text: "●", color: "yellow" };
}

const HEADER_ROWS = 1;

export function getReviewListRowCount(flatReviews: EnrichedReviewPR[]): number {
	return HEADER_ROWS + flatReviews.length;
}

export default function ReviewList({
	flatReviews,
	selectedIndex,
	scrollOffset,
	height,
	width,
	selectionBg = "#1e3a5f",
}: Props) {
	// Keymap footer lives in the dashboard's global CommandBar — use the full
	// pane height for the list so we don't render two stacked keymap rows.
	const listHeight = height;

	// Per the user request, the list keeps only the columns that aid
	// navigation: PR number, title, CI. Author + lines-changed live in the
	// detail panel where they have room to be readable.
	const numColWidth = 6;
	const checksColWidth = 2;
	const fixedWidth = 2 + numColWidth + 1 + checksColWidth;
	const titleMaxWidth = Math.max(width - fixedWidth - 1, 10);

	const totalRows = HEADER_ROWS + flatReviews.length;
	const visibleStart = scrollOffset;
	const visibleEnd = Math.min(visibleStart + listHeight, totalRows);

	const rows: React.ReactNode[] = [];

	for (let rowIdx = visibleStart; rowIdx < visibleEnd; rowIdx++) {
		if (rowIdx === 0) {
			rows.push(
				<Box key="col-header">
					<Text dimColor>{"  "}</Text>
					<Text dimColor>{"#".padEnd(numColWidth)}</Text>
					<Text dimColor> </Text>
					<Text dimColor>{"".padEnd(titleMaxWidth)}</Text>
					<Text dimColor>{"ci".padStart(checksColWidth)}</Text>
				</Box>,
			);
			continue;
		}

		const flatIndex = rowIdx - HEADER_ROWS;
		const item = flatReviews[flatIndex];
		if (!item) continue;

		const { pr } = item;
		const selected = flatIndex === selectedIndex;
		const cursor = selected ? ">" : " ";
		const num = `#${pr.number}`;
		const title =
			pr.title.length > titleMaxWidth ? pr.title.slice(0, titleMaxWidth - 1) + "…" : pr.title;
		const ci = checksIndicator(item.checks);
		const bg = selected ? selectionBg : undefined;

		rows.push(
			<Box key={`${pr.number}`} width={width}>
				<Text backgroundColor={bg} bold={selected}>
					{cursor}{" "}
				</Text>
				<Text backgroundColor={bg} color={pr.isDraft ? "gray" : "green"}>
					{num.padEnd(numColWidth)}
				</Text>
				<Text backgroundColor={bg}> </Text>
				<Text backgroundColor={bg} bold={selected}>
					{title.padEnd(titleMaxWidth)}
				</Text>
				<Text backgroundColor={bg} color={ci.color}>
					{ci.text.padStart(checksColWidth)}
				</Text>
			</Box>,
		);
	}

	return (
		<Box flexDirection="column" width={width} height={height}>
			<Box flexDirection="column" height={listHeight}>
				{rows}
			</Box>
		</Box>
	);
}
