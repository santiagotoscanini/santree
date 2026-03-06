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
}

function checksIndicator(checks: PRCheck[] | null): { text: string; color: string } {
	if (!checks || checks.length === 0) return { text: "-", color: "gray" };
	if (checks.some((c) => c.bucket === "fail")) return { text: "\u2717", color: "red" };
	if (checks.every((c) => c.bucket === "pass")) return { text: "\u2713", color: "green" };
	return { text: "\u25cf", color: "yellow" };
}

const FOOTER_HEIGHT = 2;
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
}: Props) {
	const listHeight = height - FOOTER_HEIGHT;

	const numColWidth = 6;
	const authorColWidth = 12;
	const changesColWidth = 10;
	const checksColWidth = 2;
	const fixedWidth =
		2 + numColWidth + 1 + authorColWidth + 1 + changesColWidth + 1 + checksColWidth;
	const titleMaxWidth = Math.max(width - fixedWidth, 10);
	const footerRule = "\u2500".repeat(width);

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
					<Text dimColor>{"author".padStart(authorColWidth)}</Text>
					<Text dimColor> </Text>
					<Text dimColor>{"changes".padStart(changesColWidth)}</Text>
					<Text dimColor> </Text>
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
			pr.title.length > titleMaxWidth ? pr.title.slice(0, titleMaxWidth - 1) + "\u2026" : pr.title;
		const author =
			pr.author.login.length > authorColWidth
				? pr.author.login.slice(0, authorColWidth - 1) + "\u2026"
				: pr.author.login;
		const changes = `+${item.additions} -${item.deletions}`;
		const ci = checksIndicator(item.checks);
		const bg = selected ? "#1e3a5f" : undefined;

		rows.push(
			<Box key={`${pr.number}`} width={width}>
				<Text backgroundColor={bg} color={selected ? "cyan" : undefined} bold={selected}>
					{cursor}{" "}
				</Text>
				<Text backgroundColor={bg} color={pr.isDraft ? "gray" : "green"}>
					{num.padEnd(numColWidth)}
				</Text>
				<Text backgroundColor={bg}> </Text>
				<Text backgroundColor={bg} color={selected ? "white" : undefined} bold={selected}>
					{title.padEnd(titleMaxWidth)}
				</Text>
				<Text backgroundColor={bg} dimColor>
					{author.padStart(authorColWidth)}
				</Text>
				<Text backgroundColor={bg}> </Text>
				<Text backgroundColor={bg}>
					<Text color="green">{`+${item.additions}`}</Text>
					<Text dimColor>/</Text>
					<Text color="red">{`-${item.deletions}`}</Text>
					{"".padStart(Math.max(0, changesColWidth - changes.length))}
				</Text>
				<Text backgroundColor={bg}> </Text>
				<Text
					backgroundColor={bg}
					color={selected ? (ci.color === "gray" ? "gray" : ci.color) : ci.color}
				>
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
						Shift + {"\u2191\u2193"}
					</Text>
					<Text color="white"> Scroll detail</Text>
					{"   "}
					<Text color="cyan" bold>
						o
					</Text>
					<Text color="white"> Open PR</Text>
					{"   "}
					<Text color="cyan" bold>
						Tab
					</Text>
					<Text color="white"> Issues</Text>
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
