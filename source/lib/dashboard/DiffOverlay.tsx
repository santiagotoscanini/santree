import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { DiffFile, DiffFileStatus } from "./types.js";

interface Props {
	width: number;
	height: number;
	ticketId: string;
	baseBranch: string;
	files: DiffFile[];
	fileIndex: number;
	fileScrollOffset: number;
	content: string | null;
	contentScrollOffset: number;
	loadingFiles: boolean;
	loadingContent: boolean;
	error: string | null;
	/** Theme-adapted selection background. Falls back to dark navy. */
	selectionBg?: string;
	/**
	 * User-set left pane width (from divider drag). Falls back to the default
	 * formula when undefined. Always clamped against pane minimums.
	 */
	leftWidthOverride?: number;
	/**
	 * When non-null, render a confirmation modal over the body asking the user
	 * to confirm discarding tracked changes or deleting an untracked file.
	 */
	pendingDiscard?: { path: string; isUntracked: boolean } | null;
}

// ── Tree building ─────────────────────────────────────────────────────

interface TreeDir {
	kind: "dir";
	name: string;
	children: TreeNode[];
}
interface TreeFile {
	kind: "file";
	name: string;
	file: DiffFile;
}
type TreeNode = TreeDir | TreeFile;

interface RenderedRow {
	prefix: string;
	label: string;
	color?: string;
	dim?: boolean;
	bold?: boolean;
	fileIndex: number | null; // index into the flat file list, null for directory rows
	// Lazygit-style index/working status chars. When set, the row is rendered as
	// `<X><Y> <name>` with X colored green and Y red (only for files with
	// uncommitted state). Files with only committed changes vs base get the
	// existing single-color status rendering instead.
	xy?: { index: string; working: string };
}

function buildTree(files: DiffFile[]): TreeDir {
	const root: TreeDir = { kind: "dir", name: "", children: [] };
	for (const file of files) {
		const parts = file.path.split("/");
		let cursor: TreeDir = root;
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i]!;
			const isLeaf = i === parts.length - 1;
			if (isLeaf) {
				cursor.children.push({ kind: "file", name: part, file });
			} else {
				let next = cursor.children.find((c): c is TreeDir => c.kind === "dir" && c.name === part);
				if (!next) {
					next = { kind: "dir", name: part, children: [] };
					cursor.children.push(next);
				}
				cursor = next;
			}
		}
	}
	// Collapse single-child directory chains for compactness.
	collapseChains(root);
	return root;
}

function collapseChains(dir: TreeDir): void {
	for (const child of dir.children) {
		if (child.kind !== "dir") continue;
		while (child.children.length === 1 && child.children[0]!.kind === "dir") {
			const only = child.children[0] as TreeDir;
			child.name = `${child.name}/${only.name}`;
			child.children = only.children;
		}
		collapseChains(child);
	}
}

function statusColor(status: DiffFileStatus): string {
	switch (status) {
		case "A":
			return "green";
		case "D":
			return "red";
		case "M":
			return "yellow";
		case "R":
			return "magenta";
		case "C":
			return "blue";
		default:
			return "gray";
	}
}

function renderTree(
	dir: TreeDir,
	depth: number,
	rows: RenderedRow[],
	fileCounter: { value: number },
): void {
	const sorted = [...dir.children].sort((a, b) => {
		// Directories first, then files
		if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
	const indent = "  ".repeat(depth);
	for (const child of sorted) {
		if (child.kind === "dir") {
			rows.push({
				prefix: indent,
				label: `${child.name}/`,
				color: "blue",
				bold: true,
				fileIndex: null,
			});
			renderTree(child, depth + 1, rows, fileCounter);
		} else {
			const idx = fileCounter.value++;
			const file = child.file;
			const hasUncommitted = file.indexStatus !== undefined || file.workingStatus !== undefined;
			if (hasUncommitted) {
				// Lazygit-style XY display — XY conveys the staged/unstaged state,
				// so we drop the merge-base status letter from the label to avoid
				// redundant "M  M foo.ts"-style rows. The XY chars are colored at
				// render time (green for index, red for working).
				rows.push({
					prefix: indent,
					label: child.name,
					fileIndex: idx,
					xy: {
						index: file.indexStatus ?? " ",
						working: file.workingStatus ?? " ",
					},
				});
			} else {
				// Committed-only files (no working-tree state vs HEAD). Dimmed
				// so the user can tell at a glance that stage/unstage/discard
				// don't apply — only files showing a colored XY column are
				// actionable. The merge-base status letter still tells the
				// reviewer what changed vs base.
				rows.push({
					prefix: indent,
					label: `${file.status} ${child.name}`,
					color: statusColor(file.status),
					dim: true,
					fileIndex: idx,
				});
			}
		}
	}
}

// Flatten files in the same order as the rendered tree, so fileIndex matches
// the order users see when navigating with j/k.
export function flattenTreeFiles(files: DiffFile[]): DiffFile[] {
	const tree = buildTree(files);
	const ordered: DiffFile[] = [];
	const walk = (dir: TreeDir) => {
		const sorted = [...dir.children].sort((a, b) => {
			if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
		for (const c of sorted) {
			if (c.kind === "dir") walk(c);
			else ordered.push(c.file);
		}
	};
	walk(tree);
	return ordered;
}

export interface DiffLayout {
	bodyHeight: number;
	leftWidth: number;
	rightWidth: number;
	rows: RenderedRow[];
	effectiveScroll: number;
	selectedRowIdx: number;
}

/**
 * Computes the diff overlay layout — body height, pane widths, rendered tree
 * rows, and the effective scroll offset (clamped to keep selection visible).
 *
 * Shared between DiffOverlay (rendering) and the dashboard mouse handler
 * (mapping click coords back to file indices).
 */
export const DIFF_LEFT_MIN = 20;
export const DIFF_RIGHT_MIN = 20;
export const DIFF_DIVIDER_WIDTH = 1;

export function defaultDiffLeftWidth(width: number): number {
	return Math.min(48, Math.max(24, Math.floor(width * 0.32)));
}

export function clampDiffLeftWidth(leftWidth: number, width: number): number {
	const max = Math.max(DIFF_LEFT_MIN, width - DIFF_DIVIDER_WIDTH - DIFF_RIGHT_MIN);
	return Math.max(DIFF_LEFT_MIN, Math.min(leftWidth, max));
}

export function computeDiffLayout(opts: {
	width: number;
	height: number;
	files: DiffFile[];
	fileIndex: number;
	fileScrollOffset: number;
	leftWidthOverride?: number;
}): DiffLayout {
	const headerHeight = 2;
	// Keymap footer lives in the dashboard's global CommandBar — don't reserve
	// a row here or we'd render two stacked keymap rows.
	const bodyHeight = Math.max(3, opts.height - headerHeight);
	const requestedLeft = opts.leftWidthOverride ?? defaultDiffLeftWidth(opts.width);
	const leftWidth = clampDiffLeftWidth(requestedLeft, opts.width);
	const rightWidth = Math.max(DIFF_RIGHT_MIN, opts.width - leftWidth - DIFF_DIVIDER_WIDTH);

	const rows: RenderedRow[] = [];
	const tree = buildTree(opts.files);
	renderTree(tree, 0, rows, { value: 0 });

	const selectedRowIdx = rows.findIndex((r) => r.fileIndex === opts.fileIndex);
	const totalRows = rows.length;
	const maxScroll = Math.max(0, totalRows - bodyHeight);
	let effectiveScroll = Math.min(opts.fileScrollOffset, maxScroll);
	if (selectedRowIdx >= 0) {
		if (selectedRowIdx < effectiveScroll) {
			effectiveScroll = selectedRowIdx;
		} else if (selectedRowIdx >= effectiveScroll + bodyHeight) {
			effectiveScroll = selectedRowIdx - bodyHeight + 1;
		}
	}

	return { bodyHeight, leftWidth, rightWidth, rows, effectiveScroll, selectedRowIdx };
}

// ── Diff content rendering ────────────────────────────────────────────

interface DiffLine {
	text: string;
	color?: string;
	bold?: boolean;
	dim?: boolean;
}

function colorizeDiffLine(line: string): DiffLine {
	if (line.startsWith("diff --git") || line.startsWith("index ")) {
		return { text: line, color: "yellow", bold: true };
	}
	if (line.startsWith("+++") || line.startsWith("---")) {
		return { text: line, color: "yellow", dim: true };
	}
	if (line.startsWith("@@")) {
		return { text: line, color: "cyan" };
	}
	if (line.startsWith("+")) {
		return { text: line, color: "green" };
	}
	if (line.startsWith("-")) {
		return { text: line, color: "red" };
	}
	return { text: line };
}

// Content from external diff tools (delta, diff-so-fancy, etc.) ships its own
// ANSI escapes. Detecting them lets us skip our manual colorize and render the
// raw text — Ink passes ANSI through to the terminal natively.
function looksLikeAnsi(text: string): boolean {
	return /\x1b\[[0-9;]*[A-Za-z]/.test(text);
}

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * Truncate a line to `max` visible columns, preserving any ANSI escape
 * sequences along the way. Ink's built-in `wrap="truncate"` measures by string
 * length (counting escapes as visible chars) and stops short or, with very long
 * lines, lets content bleed past the box's right edge — which on the diff
 * pane caused lines to spill into the column to the right. Doing the math
 * ourselves avoids both bugs.
 */
function truncateVisible(s: string, max: number): string {
	if (max <= 0) return "";
	if (s.replace(ANSI_RE, "").length <= max) return s;

	let out = "";
	let visible = 0;
	let i = 0;
	while (i < s.length && visible < max - 1) {
		const ch = s[i]!;
		if (ch === "\x1b" && s[i + 1] === "[") {
			ANSI_RE.lastIndex = i;
			const m = ANSI_RE.exec(s);
			if (m && m.index === i) {
				out += m[0];
				i += m[0].length;
				continue;
			}
		}
		out += ch;
		visible++;
		i++;
	}
	return out + "…";
}

// ── Component ─────────────────────────────────────────────────────────

export default function DiffOverlay({
	width,
	height,
	ticketId,
	baseBranch,
	files,
	fileIndex,
	fileScrollOffset,
	content,
	contentScrollOffset,
	loadingFiles,
	loadingContent,
	error,
	selectionBg = "#1e3a5f",
	leftWidthOverride,
	pendingDiscard = null,
}: Props) {
	const layout = computeDiffLayout({
		width,
		height,
		files,
		fileIndex,
		fileScrollOffset,
		leftWidthOverride,
	});
	const { bodyHeight, leftWidth, rightWidth, rows, effectiveScroll, selectedRowIdx } = layout;
	const visibleRows = rows.slice(effectiveScroll, effectiveScroll + bodyHeight);

	// Right pane: split content into lines and slice for scroll. If the content
	// already carries ANSI escapes (from an external diff tool), pass them
	// through as-is; otherwise apply our built-in line-prefix colorization.
	// Clamp scroll so the deepest position lands the last line at the bottom.
	const isExternalContent = content ? looksLikeAnsi(content) : false;
	const rawLines = content ? content.split("\n") : [];
	const allLines: DiffLine[] = isExternalContent
		? rawLines.map((text) => ({ text }))
		: rawLines.map(colorizeDiffLine);
	const maxContentScroll = Math.max(0, allLines.length - bodyHeight);
	const effectiveContentScroll = Math.min(Math.max(0, contentScrollOffset), maxContentScroll);
	const visibleLines = allLines.slice(effectiveContentScroll, effectiveContentScroll + bodyHeight);

	const totalFiles = files.length;
	const currentFile = files[fileIndex];

	// Pre-compute path truncation. Letting each <Text> rely on wrap="truncate"
	// inside a flex row caused the path to wrap onto a new line when the row
	// overflowed — pushing the tabs above off-screen. Manual truncation on the
	// only variable-length segment keeps the header strictly one line.
	const filesLabel = `(${totalFiles} ${totalFiles === 1 ? "file" : "files"})`;
	const meta = `  ${ticketId} vs ${baseBranch}  ${filesLabel}`;
	const sep = "  •  ";
	const consumed = "Diff".length + meta.length;
	const pathRoom = Math.max(0, width - consumed - sep.length);
	let truncatedPath = "";
	if (currentFile) {
		const p = currentFile.path;
		truncatedPath = p.length > pathRoom ? "…" + p.slice(-Math.max(0, pathRoom - 1)) : p;
	}

	return (
		<Box flexDirection="column" width={width} height={height} overflow="hidden">
			{/* Header */}
			<Box flexShrink={0} width={width}>
				<Text bold color="cyan">
					Diff
				</Text>
				<Text dimColor>{meta}</Text>
				{currentFile && pathRoom > 0 && <Text dimColor>{sep}</Text>}
				{currentFile && pathRoom > 0 && <Text>{truncatedPath}</Text>}
			</Box>
			<Box flexShrink={0} width={width}>
				<Text dimColor wrap="truncate">
					{"─".repeat(width)}
				</Text>
			</Box>

			{/* Body — replaced by the discard-confirmation modal when one is
			    pending. Ink doesn't have absolute positioning, so we swap the
			    body for the modal rather than overlaying it. */}
			{pendingDiscard ? (
				<Box height={bodyHeight} flexShrink={0} justifyContent="center" alignItems="center">
					<Box
						flexDirection="column"
						borderStyle="round"
						borderColor="red"
						paddingX={3}
						paddingY={1}
					>
						<Text bold color="red">
							{pendingDiscard.isUntracked ? "Delete file?" : "Discard changes?"}
						</Text>
						<Text> </Text>
						<Text>{pendingDiscard.path}</Text>
						{pendingDiscard.isUntracked && (
							<Text color="yellow">Warning: untracked file will be permanently deleted</Text>
						)}
						{!pendingDiscard.isUntracked && (
							<Text color="yellow">Warning: uncommitted changes will be lost</Text>
						)}
						<Text> </Text>
						<Text>
							<Text color="red" bold>
								y
							</Text>
							{"  Confirm"}
						</Text>
						<Text>
							<Text color="cyan" bold>
								n
							</Text>
							{"  Cancel"}
						</Text>
					</Box>
				</Box>
			) : (
				<Box height={bodyHeight} flexShrink={0} overflow="hidden">
					{/* Left pane: file tree */}
					<Box
						flexDirection="column"
						width={leftWidth}
						height={bodyHeight}
						overflow="hidden"
						paddingRight={1}
					>
						{loadingFiles ? (
							<Box>
								<Text color="cyan">
									<Spinner type="dots" />
								</Text>
								<Text dimColor> Loading files...</Text>
							</Box>
						) : error ? (
							<Text color="red">{error}</Text>
						) : files.length === 0 ? (
							<Text dimColor>No changes</Text>
						) : (
							visibleRows.map((row, i) => {
								const absIdx = effectiveScroll + i;
								const isSelected = absIdx === selectedRowIdx;
								const bg = isSelected ? selectionBg : undefined;
								// Lazygit-style XY rendering — index char (green) + working
								// char (red), then a separator and the file name. Each
								// nested <Text> gets the same backgroundColor so the
								// selection highlight covers the whole row uniformly.
								if (row.xy) {
									const x = row.xy.index || " ";
									const y = row.xy.working || " ";
									const xColor = x.trim() ? "green" : "gray";
									const yColor = y.trim() ? "red" : "gray";
									return (
										<Text
											key={i}
											backgroundColor={bg}
											bold={row.bold || isSelected}
											wrap="truncate"
										>
											<Text backgroundColor={bg}>{row.prefix}</Text>
											<Text color={xColor} backgroundColor={bg} bold>
												{x}
											</Text>
											<Text color={yColor} backgroundColor={bg} bold>
												{y}
											</Text>
											<Text backgroundColor={bg}>{` ${row.label}`}</Text>
										</Text>
									);
								}
								const text = `${row.prefix}${row.label}`;
								// Selected row keeps its own color (file-status hue or directory
								// blue) but gets the theme-aware selection bg + bold so it stays
								// readable in light and dark modes alike.
								return (
									<Text
										key={i}
										color={row.color}
										backgroundColor={bg}
										bold={row.bold || isSelected}
										dimColor={row.dim}
										wrap="truncate"
									>
										{text}
									</Text>
								);
							})
						)}
					</Box>

					{/* Vertical divider */}
					<Box flexDirection="column" height={bodyHeight}>
						{Array.from({ length: bodyHeight }).map((_, i) => (
							<Text key={i} dimColor>
								│
							</Text>
						))}
					</Box>

					{/* Right pane: diff content */}
					<Box
						flexDirection="column"
						width={rightWidth}
						height={bodyHeight}
						overflow="hidden"
						paddingLeft={1}
					>
						{loadingContent ? (
							<Box>
								<Text color="cyan">
									<Spinner type="dots" />
								</Text>
								<Text dimColor> Loading diff...</Text>
							</Box>
						) : !currentFile ? (
							<Text dimColor>Select a file</Text>
						) : visibleLines.length === 0 ? (
							<Text dimColor>(empty diff)</Text>
						) : (
							visibleLines.map((line, i) => {
								// rightWidth includes the paddingLeft={1} of the wrapper Box,
								// so usable column count is rightWidth - 1.
								const cell = truncateVisible(line.text || " ", Math.max(1, rightWidth - 1));
								// wrap="truncate" prevents Ink from soft-wrapping. Default
								// `wrap` mode measures byte length (counting ANSI escape
								// bytes as visible chars), which makes color-heavy lines
								// like syntax-highlighted code wrap *very* early — visible
								// content gets clobbered by the next row. truncateVisible
								// has already sized the cell, so `truncate` is a no-op for
								// already-fitting lines.
								return (
									<Text
										key={i}
										color={line.color}
										bold={line.bold}
										dimColor={line.dim}
										wrap="truncate"
									>
										{cell}
									</Text>
								);
							})
						)}
					</Box>
				</Box>
			)}
		</Box>
	);
}
