import { useEffect, useReducer, useCallback, useRef, useState } from "react";
import { Text, Box, useInput, useStdout, useApp } from "ink";
import Spinner from "ink-spinner";
import { exec, execSync, spawn } from "child_process";
import { promisify } from "util";
import { createRequire } from "module";
import * as fs from "fs";
import * as path from "path";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json");
import {
	findMainRepoRoot,
	createWorktree,
	getDefaultBranch,
	getBaseBranch,
	hasInitScript,
	getInitScriptPath,
	removeWorktree,
	getDiffTool,
} from "../lib/git.js";
import { run, spawnAsync } from "../lib/exec.js";
import { resolveAgentBinary } from "../lib/ai.js";
import { getInstalledClaudeVersion } from "../lib/version.js";
import { extractTicketId } from "../lib/git.js";
import { getMultiplexer } from "../lib/multiplexer/index.js";
import { getPRTemplate } from "../lib/github.js";
import { renderPrompt, renderDiff, renderTicket } from "../lib/prompts.js";
import { getTicketContent } from "../lib/linear.js";
import * as os from "os";
import type { DashboardIssue, ProjectGroup } from "../lib/dashboard/types.js";
import { initialState, reducer } from "../lib/dashboard/types.js";
import { loadDashboardData, loadReviewsData } from "../lib/dashboard/data.js";
import IssueList, { buildIssueListRows } from "../lib/dashboard/IssueList.js";
import {
	detectTerminalTheme,
	getThemeForMode,
	type DashboardTheme,
} from "../lib/dashboard/theme.js";
import DetailPanel, { buildIssueActions } from "../lib/dashboard/DetailPanel.js";
import ReviewList from "../lib/dashboard/ReviewList.js";
import ReviewDetailPanel, { buildReviewActions } from "../lib/dashboard/ReviewDetailPanel.js";
import { CommitOverlay, PrCreateOverlay } from "../lib/dashboard/Overlays.js";
import { MultilineTextArea } from "../lib/dashboard/MultilineTextArea.js";
import DiffOverlay, {
	flattenTreeFiles,
	computeDiffLayout,
	clampDiffLeftWidth,
	DIFF_DIVIDER_WIDTH,
} from "../lib/dashboard/DiffOverlay.js";
import type { DiffFile, DiffFileStatus } from "../lib/dashboard/types.js";
import {
	CURRENT_VERSION,
	CLAUDE_CODE_PACKAGE,
	getLatestVersion,
	getCachedLatestVersion,
	getLatestVersionFor,
	getCachedLatestVersionFor,
	isUpdateAvailable,
} from "../lib/version.js";

export const description = "Interactive dashboard of your Linear issues";

const execAsync = promisify(exec);

// Resolved at module load — cheap. Honors cmux's bundled binary when running
// inside cmux so the header reflects the binary santree will actually use.
const CLAUDE_VERSION = getInstalledClaudeVersion() ?? "";

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Parse `git diff --name-status` output. Each line is a tab-separated record:
 *   M\tpath/to/file.ts
 *   R100\told/path\tnew/path
 * For renames/copies, the status code has a similarity suffix we strip.
 */
/**
 * Pipe `git diff` output through an external tool (e.g. delta) and return the
 * combined ANSI output. Uses spawn pipes — no shell — so the tool name is safe
 * even though we already validate it in getDiffTool().
 */
function runPipedDiff(
	cwd: string,
	mergeBase: string,
	filePath: string,
	tool: string,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const git = spawn("git", ["-C", cwd, "diff", "--color=always", mergeBase, "--", filePath], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const pager = spawn(tool, [], { stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		let err = "";
		git.stdout.pipe(pager.stdin);
		git.stderr.on("data", (d) => {
			err += d.toString();
		});
		pager.stdout.on("data", (d) => {
			out += d.toString();
		});
		pager.stderr.on("data", (d) => {
			err += d.toString();
		});
		pager.on("error", reject);
		git.on("error", reject);
		pager.on("close", (code) => {
			if (code !== 0 && !out) {
				reject(new Error(err || `${tool} exited with code ${code}`));
			} else {
				resolve(out);
			}
		});
	});
}

function parseNameStatus(raw: string): DiffFile[] {
	const files: DiffFile[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		const parts = line.split("\t");
		if (parts.length < 2) continue;
		const code = parts[0]!.charAt(0).toUpperCase();
		const status: DiffFileStatus =
			code === "M" || code === "A" || code === "D" || code === "R" || code === "C" || code === "U"
				? code
				: "?";
		if ((status === "R" || status === "C") && parts.length >= 3) {
			files.push({ status, path: parts[2]!, oldPath: parts[1] });
		} else {
			files.push({ status, path: parts[1]! });
		}
	}
	return files;
}

function slugify(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40);
}

// ── Scroll helpers ────────────────────────────────────────────────────

/**
 * Walk the rendered list rows and return the absolute row index of the
 * issue's main row (not its detail sub-rows). Used to keep the selected
 * issue scrolled into view as `j`/`k` moves selection.
 */
function getRowIndexForFlatIndex(
	groups: ProjectGroup[],
	flatIssues: DashboardIssue[],
	flatIndex: number,
): number {
	const rows = buildIssueListRows(groups, flatIssues);
	for (let i = 0; i < rows.length; i++) {
		const r = rows[i]!;
		if (r.kind === "issue" && r.flatIndex === flatIndex) return i;
	}
	return 0;
}

/**
 * Map a clicked list row back to its parent issue's flat index, if any.
 */
function getFlatIndexForListRow(
	groups: ProjectGroup[],
	flatIssues: DashboardIssue[],
	listRow: number,
): number | null {
	const rows = buildIssueListRows(groups, flatIssues);
	const row = rows[listRow];
	if (!row) return null;
	if (row.kind === "issue") return row.flatIndex;
	return null;
}

// ── Terminal escape sequences ─────────────────────────────────────────
//
// We control the terminal by writing ANSI escape sequences to stdout.
// These are special byte strings that terminals interpret as commands
// rather than displayable text.
//
// Format: \x1b[ starts a "CSI" (Control Sequence Introducer).
//   \x1b is the ESC character (hex 0x1B, decimal 27).
//   The `[` after ESC begins a CSI sequence.
//   `?` marks a "private mode" (DEC-specific terminal feature).
//   The number identifies which feature, and the letter at the end
//   is the action: `h` = enable (high), `l` = disable (low).
//
// Sequences used:
//   \x1b[?1049h / l  — Enter/leave alternate screen buffer.
//                       The alt screen is a separate drawing area (like vim
//                       or less use). When you leave, the original terminal
//                       content is restored as if nothing happened.
//   \x1b[?25h / l    — Show/hide the text cursor.
//   \x1b[?1002h / l  — Enable/disable button-event mouse tracking.
//                       The terminal sends mouse press, release, drag, and
//                       scroll events as input sequences we can parse.
//   \x1b[?1006h / l  — Enable/disable SGR (Select Graphic Rendition)
//                       extended mouse format. Without this, mouse reporting
//                       breaks beyond column/row 223. SGR encodes events as
//                       \x1b[<button;col;row M/m (M=press, m=release).

// Must run before Ink renders the first frame to avoid leaking output
// to the main terminal buffer.
let altScreenEntered = false;
function ensureAltScreen() {
	if (altScreenEntered) return;
	altScreenEntered = true;
	getMultiplexer().renameWindow("", "santree");
	process.stdout.write("\x1b[?1049h"); // Enter alternate screen buffer
	process.stdout.write("\x1b[?25l"); // Hide cursor
}

/** Leave alternate screen and restore cursor — used when exiting to shell */
function leaveAltScreen() {
	process.stdout.write("\x1b[?1049l"); // Leave alternate screen buffer
	process.stdout.write("\x1b[?25h"); // Show cursor
}

/**
 * Tab pill — active tab uses an explicit hex bg + fg so contrast doesn't
 * depend on the user's ANSI palette interpretation (terminal "cyan" can be a
 * pale teal in light themes that doesn't read against ANSI "black"). Light
 * mode gets a darker teal pill with white text; dark mode keeps a bright
 * cyan pill with black text. Inactive tabs use default foreground.
 */
function Tab({ active, label, mode }: { active: boolean; label: string; mode: "light" | "dark" }) {
	if (active) {
		const bg = mode === "light" ? "#0e7490" : "#22d3ee";
		const fg = mode === "light" ? "white" : "black";
		return (
			<Text backgroundColor={bg} color={fg} bold>
				{` ${label} `}
			</Text>
		);
	}
	return <Text>{` ${label} `}</Text>;
}

/**
 * Single-line global keymap shown at the bottom-left of the dashboard. The
 * `E workspace` hint only appears when the action is meaningful
 * (`SANTREE_EDITOR` is `code`/`cursor` and a `.code-workspace` file exists in
 * the repo root). When the diff overlay is active, the keymap switches to
 * diff-specific bindings since the global ones don't apply.
 */
function CommandBar({
	showWorkspace,
	mode = "default",
}: {
	showWorkspace: boolean;
	mode?: "default" | "diff";
}) {
	const dot = <Text dimColor>{"  ·  "}</Text>;
	const Key = ({ k }: { k: string }) => (
		<Text color="cyan" bold>
			{k}
		</Text>
	);
	if (mode === "diff") {
		return (
			<Text>
				<Key k="j/k" />
				<Text dimColor> file</Text>
				{dot}
				<Key k="⇧↑↓" />
				<Text dimColor> scroll</Text>
				{dot}
				<Key k="g/G" />
				<Text dimColor> top/bot</Text>
				{dot}
				<Key k="q" />
				<Text dimColor> close</Text>
			</Text>
		);
	}
	return (
		<Text>
			<Key k="j/k" />
			<Text dimColor> nav</Text>
			{dot}
			<Key k="⇧↑↓" />
			<Text dimColor> scroll</Text>
			{dot}
			<Key k="1/2" />
			<Text dimColor> tabs</Text>
			{showWorkspace ? (
				<>
					{dot}
					<Key k="E" />
					<Text dimColor> workspace</Text>
				</>
			) : null}
			{dot}
			<Key k="R" />
			<Text dimColor> refresh</Text>
			{dot}
			<Key k="q" />
			<Text dimColor> quit</Text>
		</Text>
	);
}

// ── Component ─────────────────────────────────────────────────────────

export default function Dashboard() {
	ensureAltScreen();
	const { exit } = useApp();
	const { stdout } = useStdout();
	const [state, dispatch] = useReducer(reducer, initialState);
	// Theme is a visual concern only — kept outside the reducer so re-detection
	// on refresh doesn't churn data flow. Defaults to dark; replaced by OSC 11
	// detection on mount and on every refresh.
	const [theme, setTheme] = useState<DashboardTheme>(getThemeForMode("dark"));
	// `E workspace` is only meaningful when the user's editor accepts a
	// `.code-workspace` file (VSCode/Cursor) AND such a file exists in the
	// repo root. Recomputed alongside the data refresh.
	const [hasWorkspaceFile, setHasWorkspaceFile] = useState(false);
	const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const repoRootRef = useRef<string | null>(null);
	const stateRef = useRef(state);
	stateRef.current = state;
	const draggingRef = useRef<"main" | "diff" | null>(null);

	const [termSize, setTermSize] = useState({
		columns: stdout?.columns ?? 80,
		rows: stdout?.rows ?? 24,
	});

	// Show cached values immediately so the banner appears on first paint when
	// known-stale; refresh in the background without blocking dashboard load.
	const [latestVersion, setLatestVersion] = useState<string | null>(getCachedLatestVersion);
	const [latestClaudeVersion, setLatestClaudeVersion] = useState<string | null>(() =>
		getCachedLatestVersionFor(CLAUDE_CODE_PACKAGE),
	);

	useEffect(() => {
		let cancelled = false;
		getLatestVersion().then((v) => {
			if (!cancelled && v) setLatestVersion(v);
		});
		getLatestVersionFor(CLAUDE_CODE_PACKAGE).then((v) => {
			if (!cancelled && v) setLatestClaudeVersion(v);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	const updateAvailable = latestVersion ? isUpdateAvailable(CURRENT_VERSION, latestVersion) : false;
	const claudeUpdateAvailable =
		!!CLAUDE_VERSION &&
		!!latestClaudeVersion &&
		isUpdateAvailable(CLAUDE_VERSION, latestClaudeVersion);

	useEffect(() => {
		const onResize = () => {
			setTermSize({
				columns: stdout?.columns ?? 80,
				rows: stdout?.rows ?? 24,
			});
		};
		stdout?.on("resize", onResize);
		return () => {
			stdout?.off("resize", onResize);
		};
	}, [stdout]);

	const { columns, rows } = termSize;
	const separatorWidth = 3;
	const innerWidth = Math.max(40, columns - 2); // outer border consumes 1 col on each side
	const [leftWidth, setLeftWidth] = useState(Math.floor(innerWidth * 0.42));
	const leftWidthRef = useRef(leftWidth);
	leftWidthRef.current = leftWidth;
	const rightWidth = innerWidth - leftWidth - separatorWidth;
	// Diff overlay's left pane width — null means "use the default formula"
	// (computed inside computeDiffLayout). Becomes a number once the user drags
	// the divider, and persists across overlay open/close while the dashboard
	// session is alive.
	const [diffLeftWidth, setDiffLeftWidth] = useState<number | null>(null);
	const diffLeftWidthRef = useRef<number | null>(diffLeftWidth);
	diffLeftWidthRef.current = diffLeftWidth;
	// Header (1) + tab strip (1) + 2 borders + command bar (1, inside box) = 5 rows
	const contentHeight = Math.max(3, rows - 5);
	const LIST_FOOTER_HEIGHT = 0;

	// ── Data loading ──────────────────────────────────────────────────

	const refresh = useCallback(async (isInitial = false) => {
		if (!isInitial) dispatch({ type: "REFRESH_START" });

		const repoRoot = repoRootRef.current ?? findMainRepoRoot();
		if (!repoRoot) {
			dispatch({ type: "SET_ERROR", error: "Not inside a git repository" });
			return;
		}
		repoRootRef.current = repoRoot;

		try {
			// Re-detect terminal theme alongside data fetch so light↔dark switches
			// propagate within one refresh cycle (≤30s).
			const [data, reviewData, themeMode] = await Promise.all([
				loadDashboardData(repoRoot),
				loadReviewsData(repoRoot),
				detectTerminalTheme(),
			]);
			setTheme(getThemeForMode(themeMode));
			// Workspace file presence — only meaningful when the editor consumes
			// `.code-workspace` files. Cheap directory read; recomputed each cycle
			// in case the user adds/removes one.
			const editor = (process.env.SANTREE_EDITOR ?? "code").toLowerCase();
			const editorAcceptsWorkspace = editor === "code" || editor === "cursor";
			let hasWs = false;
			if (editorAcceptsWorkspace) {
				try {
					hasWs = fs.readdirSync(repoRoot).some((f) => f.endsWith(".code-workspace"));
				} catch {
					hasWs = false;
				}
			}
			setHasWorkspaceFile(hasWs);
			dispatch({ type: "SET_DATA", ...data });
			dispatch({ type: "SET_REVIEWS_DATA", flatReviews: reviewData.flatReviews });
		} catch (e) {
			dispatch({
				type: "SET_ERROR",
				error: e instanceof Error ? e.message : "Unknown error",
			});
		}
	}, []);

	useEffect(() => {
		// Enable button-event mouse tracking (?1002h) with SGR extended format (?1006h)
		// This reports press, release, drag, and scroll wheel events
		process.stdout.write("\x1b[?1002h\x1b[?1006h");

		// Mouse handler on raw stdin — handles click-to-select and drag-to-resize
		const onData = (data: Buffer) => {
			const str = data.toString("utf-8");
			// SGR mouse format: \x1b[<button;col;rowM (press/drag) or ...m (release)
			const match = str.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
			if (!match) return;
			const button = parseInt(match[1]!, 10);
			const col = parseInt(match[2]!, 10); // 1-based
			const row = parseInt(match[3]!, 10); // 1-based
			const isRelease = match[4] === "m";
			const isPress = match[4] === "M" && button === 0;
			const isDrag = match[4] === "M" && button === 32;

			const cols = stdout?.columns ?? 80;
			const minW = 20;
			const sepW = 3;

			// Release — stop dragging
			if (isRelease && draggingRef.current) {
				draggingRef.current = null;
				return;
			}

			// Drag — resize if actively dragging
			if (isDrag && draggingRef.current) {
				if (draggingRef.current === "diff") {
					// DiffOverlay starts at abs col 2 with width=innerWidth; its
					// 1-col divider sits at relative col (leftWidth+1) → abs col
					// (leftWidth+2). Setting newLeft = col - 2 keeps it under the
					// cursor; clampDiffLeftWidth enforces pane minimums.
					const innerW = Math.max(40, cols - 2);
					setDiffLeftWidth(clampDiffLeftWidth(col - 2, innerW));
					return;
				}
				// col is 1-based; outer border consumes col 1, so left pane spans cols 2..(lw+1).
				// Setting newLeft = col - 1 keeps the divider at the user's cursor.
				const newLeft = Math.max(minW, Math.min(col - 1, cols - 2 - sepW - minW));
				setLeftWidth(newLeft);
				return;
			}

			// Scroll wheel — button 64 = up, 65 = down
			if (match[4] === "M" && (button === 64 || button === 65)) {
				const s = stateRef.current;
				const lw = leftWidthRef.current;
				const delta = button === 65 ? 3 : -3;

				// Diff overlay: file navigation (left pane) or content scroll (right pane)
				if (s.overlay === "diff") {
					const cols = stdout?.columns ?? 80;
					const rowsRem = stdout?.rows ?? 24;
					// contentHeight = total - dashboard header (1) - tab bar (1) - bottom margin (0)
					const contentHeight = Math.max(3, rowsRem - 5);
					const layout = computeDiffLayout({
						width: Math.max(40, cols - 2), // outer box border eats 1 col on each side
						height: contentHeight,
						files: s.diffFiles,
						fileIndex: s.diffFileIndex,
						fileScrollOffset: s.diffFileScrollOffset,
						leftWidthOverride: diffLeftWidthRef.current ?? undefined,
					});
					// Body's first line is at absolute row 6 (title + tab + top border + overlay title + rule)
					const bodyRow = row - 6;
					if (bodyRow < 0 || bodyRow >= layout.bodyHeight) return;

					// DiffOverlay starts at abs col 2; left pane occupies abs cols
					// 2..(leftWidth+1).
					if (col <= layout.leftWidth + 1) {
						const maxIdx = s.diffFiles.length - 1;
						if (maxIdx < 0) return;
						const next = Math.max(0, Math.min(s.diffFileIndex + delta, maxIdx));
						dispatch({ type: "DIFF_FILE_SELECT", index: next });
					} else {
						const totalLines = s.diffContent ? s.diffContent.split("\n").length : 0;
						const maxScroll = Math.max(0, totalLines - layout.bodyHeight);
						const next = Math.max(0, Math.min(maxScroll, s.diffContentScrollOffset + delta));
						dispatch({ type: "DIFF_CONTENT_SCROLL", offset: next });
					}
					return;
				}

				// Outer border at col 1; left pane spans cols 2..(lw+1).
				const inLeftPane = col >= 2 && col <= lw + 1;

				if (s.activeTab === "reviews") {
					if (inLeftPane) {
						const maxIdx = s.flatReviews.length - 1;
						if (maxIdx < 0) return;
						const next = Math.max(0, Math.min(s.reviewSelectedIndex + delta, maxIdx));
						dispatch({ type: "REVIEW_SELECT", index: next });
					} else {
						const next = Math.max(0, s.reviewDetailScrollOffset + delta);
						dispatch({ type: "REVIEW_SCROLL_DETAIL", offset: next });
					}
					return;
				}

				if (inLeftPane) {
					// Scroll left pane (issue list)
					const maxIdx = s.flatIssues.length - 1;
					if (maxIdx < 0) return;
					const next = Math.max(0, Math.min(s.selectedIndex + delta, maxIdx));
					dispatch({ type: "SELECT", index: next });
				} else {
					// Scroll right pane (detail)
					const next = Math.max(0, s.detailScrollOffset + delta);
					dispatch({ type: "SCROLL_DETAIL", offset: next });
				}
				return;
			}

			if (!isPress) return;

			// Diff overlay click: drag divider, or select file row in left pane
			{
				const s = stateRef.current;
				if (s.overlay === "diff") {
					const cols = stdout?.columns ?? 80;
					const rowsRem = stdout?.rows ?? 24;
					const contentHeight = Math.max(3, rowsRem - 5);
					const layout = computeDiffLayout({
						width: Math.max(40, cols - 2), // outer box border eats 1 col on each side
						height: contentHeight,
						files: s.diffFiles,
						fileIndex: s.diffFileIndex,
						fileScrollOffset: s.diffFileScrollOffset,
						leftWidthOverride: diffLeftWidthRef.current ?? undefined,
					});
					// Divider sits at abs col leftWidth+2 (DiffOverlay starts at
					// abs col 2; divider at relative col leftWidth+1). Allow ±1
					// tolerance — a 1-col target is hard to hit precisely.
					const diffDivAbsCol = layout.leftWidth + 2;
					if (col >= diffDivAbsCol - 1 && col <= diffDivAbsCol - 1 + DIFF_DIVIDER_WIDTH + 1) {
						draggingRef.current = "diff";
						return;
					}
					if (col > layout.leftWidth + 1) return;
					const bodyRow = row - 6;
					if (bodyRow < 0 || bodyRow >= layout.bodyHeight) return;
					const absRowIdx = layout.effectiveScroll + bodyRow;
					const clickedRow = layout.rows[absRowIdx];
					if (clickedRow && clickedRow.fileIndex !== null) {
						dispatch({ type: "DIFF_FILE_SELECT", index: clickedRow.fileIndex });
					}
					return;
				}
			}

			// Left-click press: check if on divider to start drag
			// Outer border is at col 1; left pane spans cols 2..(lw+1); divider spans (lw+2)..(lw+1+sepW).
			const lw = leftWidthRef.current;
			const divStart = lw + 2;
			const divEnd = lw + 1 + sepW;
			if (col >= divStart && col <= divEnd) {
				draggingRef.current = "main";
				return;
			}

			// Left-click press: select item in left pane (cols 2..lw+1)
			const s = stateRef.current;
			if (s.loading || s.error) return;
			if (col < 2 || col > lw + 1) return;

			// Row 1 = title, row 2 = tab strip, row 3 = top border, content starts at row 4 (1-based)
			const contentRow = row - 4; // 0-based row within content area
			if (contentRow < 0) return;

			if (s.activeTab === "reviews") {
				if (s.flatReviews.length === 0) return;
				// Row 0 is column header, PRs start at row 1
				const listRow = s.reviewListScrollOffset + contentRow;
				const flatIdx = listRow - 1; // subtract column header
				if (flatIdx >= 0 && flatIdx < s.flatReviews.length) {
					dispatch({ type: "REVIEW_SELECT", index: flatIdx });
				}
				return;
			}

			if (s.flatIssues.length === 0) return;
			const listRow = s.listScrollOffset + contentRow;
			const flatIdx = getFlatIndexForListRow(s.groups, s.flatIssues, listRow);
			if (flatIdx !== null && flatIdx >= 0 && flatIdx < s.flatIssues.length) {
				dispatch({ type: "SELECT", index: flatIdx });
			}
		};

		if (process.stdin.isTTY) {
			process.stdin.on("data", onData);
		}

		const init = async () => {
			await new Promise((r) => setTimeout(r, 100));
			await refresh(true);
		};
		init();

		// Auto-refresh every 30s
		refreshTimerRef.current = setInterval(() => refresh(), 30_000);

		return () => {
			if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
			// Disable SGR extended format (?1006l) and button-event tracking (?1002l)
			process.stdout.write("\x1b[?1006l\x1b[?1002l");
			leaveAltScreen();
			if (process.stdin.isTTY) {
				process.stdin.removeListener("data", onData);
			}
		};
	}, [refresh]);

	// ── List scroll tracking ──────────────────────────────────────────

	useEffect(() => {
		const rowIdx = getRowIndexForFlatIndex(state.groups, state.flatIssues, state.selectedIndex);
		const maxVisible = contentHeight - LIST_FOOTER_HEIGHT;
		let offset = state.listScrollOffset;

		if (rowIdx < offset) {
			offset = Math.max(0, rowIdx - 1);
		} else if (rowIdx >= offset + maxVisible) {
			offset = rowIdx - maxVisible + 2;
		}

		if (offset !== state.listScrollOffset) {
			dispatch({ type: "SCROLL_LIST", offset });
		}
	}, [state.selectedIndex, state.groups, contentHeight, state.listScrollOffset]);

	// ── Review list scroll tracking ──────────────────────────────────

	useEffect(() => {
		// Row index = 1 (column header) + flatIndex
		const rowIdx = 1 + state.reviewSelectedIndex;
		const maxVisible = contentHeight - LIST_FOOTER_HEIGHT;
		let offset = state.reviewListScrollOffset;

		if (rowIdx < offset) {
			offset = Math.max(0, rowIdx - 1);
		} else if (rowIdx >= offset + maxVisible) {
			offset = rowIdx - maxVisible + 2;
		}

		if (offset !== state.reviewListScrollOffset) {
			dispatch({ type: "REVIEW_SCROLL_LIST", offset });
		}
	}, [state.reviewSelectedIndex, state.flatReviews, contentHeight, state.reviewListScrollOffset]);

	// ── Mouse tracking pause ─────────────────────────────────────────
	// The MultilineTextArea captures ESC for cancel. With SGR mouse tracking on,
	// every click emits `\x1b[<btn;col;rowM` — Ink reads the leading ESC and fires
	// key.escape, dismissing the overlay. Disable tracking while any overlay
	// phase mounts a MultilineTextArea (context-input editing OR pr-create
	// review); restore when that phase ends.
	useEffect(() => {
		const needsMouseOff =
			(state.overlay === "context-input" && state.contextInputPhase === "editing") ||
			(state.overlay === "pr-create" && state.prCreatePhase === "review");
		if (!needsMouseOff) return;
		process.stdout.write("\x1b[?1002l\x1b[?1006l");
		return () => {
			process.stdout.write("\x1b[?1002h\x1b[?1006h");
		};
	}, [state.overlay, state.contextInputPhase, state.prCreatePhase]);

	// ── Diff overlay: load file list when opened ──────────────────────
	// Resolves merge-base against the configured base branch so upstream-only
	// changes (commits on master we haven't pulled) are excluded — same semantics
	// as a GitHub PR diff.
	useEffect(() => {
		if (state.overlay !== "diff" || !state.diffWorktreePath || !state.diffBaseBranch) return;
		if (!state.diffLoadingFiles) return;
		const cwd = state.diffWorktreePath;
		const base = state.diffBaseBranch;
		void (async () => {
			try {
				const { stdout: mergeBaseOut } = await execAsync(
					`git -C "${cwd}" merge-base "${base}" HEAD`,
				);
				const mergeBase = mergeBaseOut.trim() || base;
				const { stdout } = await execAsync(`git -C "${cwd}" diff --name-status "${mergeBase}"`);
				const files = parseNameStatus(stdout);
				const ordered = flattenTreeFiles(files);
				dispatch({ type: "DIFF_FILES_LOADED", files: ordered, mergeBase });
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				dispatch({ type: "DIFF_FILES_ERROR", error: msg });
			}
		})();
	}, [state.overlay, state.diffWorktreePath, state.diffBaseBranch, state.diffLoadingFiles]);

	// ── Diff overlay: load content for selected file ──────────────────
	// If SANTREE_DIFF_TOOL is set, pipe `git diff` output through the tool so
	// the user's preferred renderer (delta, diff-so-fancy, etc.) handles
	// colorization. The tool's ANSI output is then rendered as-is by Ink.
	useEffect(() => {
		if (state.overlay !== "diff" || !state.diffWorktreePath || !state.diffMergeBase) return;
		const file = state.diffFiles[state.diffFileIndex];
		if (!file) return;
		const cwd = state.diffWorktreePath;
		const mergeBase = state.diffMergeBase;
		const tool = getDiffTool();
		dispatch({ type: "DIFF_CONTENT_LOADING" });
		void (async () => {
			try {
				if (tool) {
					// Pipe git diff (with colors enabled so the tool can pass them
					// through if desired) into the configured tool. Use spawn pipes
					// rather than shell to avoid quoting concerns.
					const content = await runPipedDiff(cwd, mergeBase, file.path, tool);
					dispatch({ type: "DIFF_CONTENT_LOADED", content });
				} else {
					// No external tool — get raw unified diff and render colors ourselves.
					const { stdout } = await execAsync(
						`git -C "${cwd}" diff --no-color "${mergeBase}" -- "${file.path}"`,
						{ maxBuffer: 32 * 1024 * 1024 },
					);
					dispatch({ type: "DIFF_CONTENT_LOADED", content: stdout });
				}
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				dispatch({ type: "DIFF_CONTENT_LOADED", content: `Error loading diff: ${msg}` });
			}
		})();
	}, [
		state.overlay,
		state.diffWorktreePath,
		state.diffMergeBase,
		state.diffFileIndex,
		state.diffFiles,
	]);

	// ── Actions ───────────────────────────────────────────────────────

	const launchWorkInTmux = useCallback(
		async (
			di: DashboardIssue,
			mode: "plan" | "implement",
			worktreePath: string,
			contextFile?: string,
		) => {
			const windowName = di.issue.identifier;
			const sessionId = di.worktree?.sessionId;
			const bin = resolveAgentBinary();
			const resumeCmd = sessionId && bin ? `${bin} --resume ${sessionId}` : null;
			const contextArg = contextFile ? ` --context-file "${contextFile}"` : "";
			const workCmd =
				mode === "plan" ? `st worktree work --plan${contextArg}` : `st worktree work${contextArg}`;
			const cmd = resumeCmd ?? workCmd;
			const mux = getMultiplexer();

			const selected = await mux.selectWindow(windowName);
			if (selected.ok) {
				const sent = mux.sendCommand(windowName, cmd);
				if (sent.ok) {
					dispatch({
						type: "SET_ACTION_MESSAGE",
						message: resumeCmd
							? `Resumed session in: ${windowName}`
							: `Launched ${mode} in: ${windowName}`,
					});
				} else {
					dispatch({
						type: "SET_ACTION_MESSAGE",
						message: `Focused ${windowName} — run \`${cmd}\` manually (${sent.reason})`,
					});
				}
			} else {
				const created = await mux.createWindow({
					name: windowName,
					cwd: worktreePath,
					command: cmd,
				});
				if (created.ok) {
					dispatch({
						type: "SET_ACTION_MESSAGE",
						message: resumeCmd
							? `Resumed session in new window: ${windowName}`
							: `Launched ${mode} in ${mux.kind} window: ${windowName}`,
					});
				} else {
					dispatch({
						type: "SET_ACTION_MESSAGE",
						message: `Failed to create ${mux.kind} window${created.message ? `: ${created.message}` : ""}`,
					});
				}
			}
			// Delayed refresh to pick up session ID created by `st worktree work`
			setTimeout(() => refresh(), 3000);
		},
		[refresh],
	);

	const launchAfterCreation = useCallback(
		async (
			mode: "plan" | "implement",
			worktreePath: string,
			ticketId: string,
			contextFile?: string,
		) => {
			const mux = getMultiplexer();
			if (mux.isActive()) {
				const windowName = ticketId;
				const contextArg = contextFile ? ` --context-file "${contextFile}"` : "";
				const workCmd =
					mode === "plan"
						? `st worktree work --plan${contextArg}`
						: `st worktree work${contextArg}`;
				const created = await mux.createWindow({
					name: windowName,
					cwd: worktreePath,
					command: workCmd,
				});
				if (created.ok) {
					dispatch({
						type: "SET_ACTION_MESSAGE",
						message: `Created worktree + launched ${mode} in: ${windowName}`,
					});
				} else {
					dispatch({
						type: "SET_ACTION_MESSAGE",
						message: `Worktree created, but ${mux.kind} failed${created.message ? `: ${created.message}` : ""}`,
					});
				}
				setTimeout(() => refresh(), 3000);
			} else {
				leaveAltScreen();
				console.log(`SANTREE_CD:${worktreePath}`);
				console.log(`SANTREE_WORK:${mode}`);
				if (contextFile) console.log(`SANTREE_WORK_CONTEXT:${contextFile}`);
				exit();
			}
		},
		[exit, refresh],
	);

	const writeContextFile = useCallback((context: string | null | undefined): string | undefined => {
		const trimmed = context?.trim();
		if (!trimmed) return undefined;
		const filePath = path.join(os.tmpdir(), `santree-context-${Date.now()}.md`);
		try {
			fs.writeFileSync(filePath, trimmed);
			return filePath;
		} catch {
			return undefined;
		}
	}, []);

	const createAndLaunch = useCallback(
		async (mode: "plan" | "implement", runSetup: boolean, base?: string, contextFile?: string) => {
			const di = stateRef.current.flatIssues[stateRef.current.selectedIndex];
			if (!di) return;
			const repoRoot = repoRootRef.current;
			if (!repoRoot) return;

			// Guard against concurrent creation
			if (stateRef.current.creatingForTicket) return;

			const ticketId = di.issue.identifier;
			dispatch({ type: "CREATION_START", ticketId });

			const slug = slugify(di.issue.title);
			const branchName = `feature/${ticketId}-${slug}`;
			const defaultBranch = getDefaultBranch();
			const baseBranch = base ?? defaultBranch;
			const isDefaultBase = baseBranch === defaultBranch;

			// 1. Pull latest (async to avoid blocking the event loop)
			dispatch({ type: "CREATION_LOG", logs: `Fetching origin...\n` });
			try {
				await execAsync("git fetch origin", { cwd: repoRoot });
				if (isDefaultBase) {
					// Only checkout + pull for default branch (can't checkout a branch with an active worktree)
					dispatch({ type: "CREATION_LOG", logs: `Checking out ${baseBranch}...\n` });
					await execAsync(`git checkout ${baseBranch}`, { cwd: repoRoot });
					dispatch({ type: "CREATION_LOG", logs: `Pulling ${baseBranch}...\n` });
					await execAsync(`git pull origin ${baseBranch}`, { cwd: repoRoot });
				}
				dispatch({ type: "CREATION_LOG", logs: `Pulled latest ${baseBranch}\n` });
			} catch (e) {
				const msg = e instanceof Error ? e.message : "Failed to pull latest";
				dispatch({ type: "CREATION_LOG", logs: `Warning: ${msg}\n` });
			}

			// 2. Create worktree
			dispatch({
				type: "CREATION_LOG",
				logs: `Creating worktree ${branchName} from ${baseBranch}...\n`,
			});
			const result = await createWorktree(branchName, baseBranch, repoRoot);

			if (!result.success || !result.path) {
				dispatch({ type: "CREATION_ERROR", error: result.error ?? "Unknown error" });
				dispatch({
					type: "SET_ACTION_MESSAGE",
					message: `Failed: ${result.error ?? "Unknown error"}`,
				});
				return;
			}

			dispatch({ type: "CREATION_LOG", logs: `Worktree created at ${result.path}\n` });

			// 3. Run init script if requested
			if (runSetup) {
				const initScript = getInitScriptPath(repoRoot);
				let canExecute = true;
				try {
					fs.accessSync(initScript, fs.constants.X_OK);
				} catch {
					dispatch({
						type: "CREATION_LOG",
						logs: "Warning: init.sh exists but is not executable, skipping\n",
					});
					canExecute = false;
				}

				if (canExecute) {
					dispatch({ type: "CREATION_LOG", logs: "Running init.sh...\n" });
					let lastLen = 0;
					const initResult = await spawnAsync(initScript, [], {
						cwd: result.path,
						env: {
							...process.env,
							SANTREE_WORKTREE_PATH: result.path,
							SANTREE_REPO_ROOT: repoRoot,
						},
						onOutput: (output) => {
							const delta = output.slice(lastLen);
							if (delta) dispatch({ type: "CREATION_LOG", logs: delta });
							lastLen = output.length;
						},
					});

					if (initResult.code !== 0) {
						dispatch({
							type: "CREATION_LOG",
							logs: `\nInit script exited with code ${initResult.code}\n`,
						});
					} else {
						dispatch({ type: "CREATION_LOG", logs: "\nSetup complete!\n" });
					}
				}
			}

			// 4. Done — launch work
			dispatch({ type: "CREATION_DONE" });
			launchAfterCreation(mode, result.path, ticketId, contextFile);
		},
		[launchAfterCreation],
	);

	// Holds the context file path through multi-step flows (mode-select → base-select → confirm-setup → create)
	const pendingContextFileRef = useRef<string | null>(null);

	const proceedAfterBaseSelect = useCallback(
		(mode: "plan" | "implement", base?: string) => {
			const repoRoot = repoRootRef.current;
			if (!repoRoot) return;

			if (hasInitScript(repoRoot)) {
				dispatch({ type: "SETUP_CONFIRM_SHOW", mode });
				return;
			}
			const contextFile = pendingContextFileRef.current ?? undefined;
			pendingContextFileRef.current = null;
			createAndLaunch(mode, false, base, contextFile);
		},
		[createAndLaunch],
	);

	const doWork = useCallback(
		(mode: "plan" | "implement", customContext?: string) => {
			const di = state.flatIssues[state.selectedIndex];
			if (!di) return;
			const repoRoot = repoRootRef.current;
			if (!repoRoot) return;

			dispatch({ type: "SET_OVERLAY", overlay: null });

			const contextFile = writeContextFile(customContext);

			if (di.worktree) {
				// Worktree exists — launch work
				if (getMultiplexer().isActive()) {
					void launchWorkInTmux(di, mode, di.worktree.path, contextFile);
				} else {
					leaveAltScreen();
					console.log(`SANTREE_CD:${di.worktree.path}`);
					console.log(`SANTREE_WORK:${mode}`);
					if (contextFile) console.log(`SANTREE_WORK_CONTEXT:${contextFile}`);
					exit();
				}
			} else {
				// No worktree — stash context for the create flow to pick up
				pendingContextFileRef.current = contextFile ?? null;

				const defaultBranch = getDefaultBranch();
				const baseOptions = [defaultBranch];
				for (const fi of state.flatIssues) {
					if (fi.worktree && !baseOptions.includes(fi.worktree.branch)) {
						baseOptions.push(fi.worktree.branch);
					}
				}

				if (baseOptions.length > 1) {
					// Store mode in setupMode so we can retrieve it after base selection
					dispatch({ type: "SETUP_CONFIRM_SHOW", mode });
					// Immediately replace overlay with base-select (setupMode is preserved)
					dispatch({ type: "BASE_SELECT_SHOW", options: baseOptions });
					return;
				}

				// Only default branch available — skip base select
				proceedAfterBaseSelect(mode);
			}
		},
		[
			state.flatIssues,
			state.selectedIndex,
			exit,
			launchWorkInTmux,
			proceedAfterBaseSelect,
			writeContextFile,
		],
	);

	// ── Commit flow ──────────────────────────────────────────────────

	const handleStageAll = useCallback(async () => {
		const wtPath = stateRef.current.commitWorktreePath;
		const ticketId = stateRef.current.commitTicketId;
		if (!wtPath) return;
		try {
			await execAsync("git add -A", { cwd: wtPath });
			dispatch({ type: "COMMIT_MESSAGE", message: `[${ticketId}] ` });
			dispatch({ type: "COMMIT_PHASE", phase: "awaiting-message" });
		} catch (e: any) {
			dispatch({
				type: "COMMIT_ERROR",
				error: e?.stderr?.trim() || e?.message || "Failed to stage",
			});
		}
	}, []);

	const handleCommitSubmit = useCallback(
		async (value: string) => {
			const s = stateRef.current;
			if (!s.commitWorktreePath || !s.commitBranch) return;
			const trimmed = value.trim();
			if (!trimmed) {
				dispatch({ type: "COMMIT_ERROR", error: "Empty commit message" });
				return;
			}
			const msg = trimmed.includes(`[${s.commitTicketId}]`)
				? trimmed
				: `[${s.commitTicketId}] ${trimmed}`;

			dispatch({ type: "COMMIT_PHASE", phase: "committing" });
			try {
				await execAsync(`git commit -m "${msg.replace(/"/g, '\\"')}"`, {
					cwd: s.commitWorktreePath,
				});
			} catch (e: any) {
				dispatch({
					type: "COMMIT_ERROR",
					error: e?.stderr?.trim() || e?.stdout?.trim() || e?.message || "Commit failed",
				});
				return;
			}

			dispatch({ type: "COMMIT_PHASE", phase: "pushing" });
			try {
				await execAsync(`git push -u origin "${s.commitBranch}"`, { cwd: s.commitWorktreePath });
			} catch (e: any) {
				dispatch({ type: "COMMIT_ERROR", error: e?.stderr?.trim() || e?.message || "Push failed" });
				return;
			}

			dispatch({ type: "COMMIT_DONE" });
			setTimeout(() => {
				dispatch({ type: "COMMIT_CANCEL" });
				refresh();
			}, 2000);
		},
		[refresh],
	);

	// ── Editor actions ───────────────────────────────────────────────

	const openInEditor = useCallback((wtPath: string) => {
		const editor = process.env.SANTREE_EDITOR || "code";
		spawn(editor, [wtPath], { detached: true, stdio: "ignore" }).unref();
		dispatch({
			type: "SET_ACTION_MESSAGE",
			message: `Opened ${path.basename(wtPath)} in ${editor}`,
		});
	}, []);

	const openWorkspace = useCallback(() => {
		const repoRoot = repoRootRef.current;
		if (!repoRoot) return;
		const editor = process.env.SANTREE_EDITOR || "code";
		try {
			const entries = fs.readdirSync(repoRoot);
			const wsFile = entries.find((f) => f.endsWith(".code-workspace"));
			if (!wsFile) {
				dispatch({ type: "SET_ACTION_MESSAGE", message: "No .code-workspace file found" });
				return;
			}
			spawn(editor, [path.join(repoRoot, wsFile)], { detached: true, stdio: "ignore" }).unref();
			dispatch({ type: "SET_ACTION_MESSAGE", message: `Opened workspace in ${editor}` });
		} catch {
			dispatch({ type: "SET_ACTION_MESSAGE", message: "Failed to open workspace" });
		}
	}, []);

	// ── PR create flow ───────────────────────────────────────────────

	const doPrCreate = useCallback(
		async (fill: boolean) => {
			const s = stateRef.current;
			if (!s.prCreateWorktreePath || !s.prCreateBranch) return;

			const base = getBaseBranch(s.prCreateBranch);
			const cwd = s.prCreateWorktreePath;

			// Push first
			dispatch({ type: "PR_CREATE_PHASE", phase: "pushing" });
			try {
				await execAsync(`git -C "${cwd}" push -u origin "${s.prCreateBranch}"`);
			} catch (e: any) {
				const msg = e?.stderr?.trim() || e?.message || "Push failed";
				dispatch({ type: "PR_CREATE_ERROR", error: msg });
				return;
			}

			if (!fill) {
				// Web mode — open in browser directly
				try {
					dispatch({ type: "PR_CREATE_PHASE", phase: "creating" });
					await execAsync(`gh pr create --web --base "${base}" --head "${s.prCreateBranch}"`, {
						cwd,
					});
					dispatch({ type: "PR_CREATE_DONE", url: "" });
					setTimeout(() => {
						dispatch({ type: "PR_CREATE_CANCEL" });
						refresh();
					}, 2500);
				} catch (e: any) {
					const msg = e?.stderr?.trim() || e?.message || "PR creation failed";
					dispatch({ type: "PR_CREATE_ERROR", error: msg });
				}
				return;
			}

			// Fill mode — use AI to generate body, then review
			try {
				const prTemplate = getPRTemplate();
				if (!prTemplate) {
					dispatch({
						type: "PR_CREATE_ERROR",
						error: "No PR template found (checked .github/, docs/, and repo root)",
					});
					return;
				}

				const bin = resolveAgentBinary();
				if (!bin) {
					dispatch({
						type: "PR_CREATE_ERROR",
						error: "Claude CLI not found (npm i -g @anthropic-ai/claude-code)",
					});
					return;
				}

				dispatch({ type: "PR_CREATE_PHASE", phase: "filling" });

				const ticketId = extractTicketId(s.prCreateBranch) ?? "";
				const mainRepoRoot = findMainRepoRoot();

				// Fetch ticket content (downloads images for Linear tickets)
				let ticketContent: string | undefined;
				if (ticketId && mainRepoRoot) {
					const ticket = await getTicketContent(ticketId, mainRepoRoot);
					if (ticket) {
						ticketContent = renderTicket(ticket);
					}
				}

				const commitLog = run(`git log ${base}..HEAD --format="- %s"`, { cwd }) || null;
				const diffStat = run(`git diff ${base}..HEAD --stat`, { cwd }) || null;
				const diff = run(`git diff ${base}..HEAD`, { cwd, maxBuffer: 10 * 1024 * 1024 }) || null;

				const diffContent = renderDiff({
					base_branch: base,
					commit_log: commitLog,
					diff_stat: diffStat,
					diff: diff,
				});

				const prompt = renderPrompt("fill-pr", {
					pr_template: prTemplate,
					diff_content: diffContent,
					ticket_id: ticketId,
					ticket_content: ticketContent,
					branch_name: s.prCreateBranch,
				});

				// Pass prompt via stdin instead of temp file
				const agentResult = await spawnAsync(
					bin,
					["-p", "--output-format", "text", "--allowedTools", "Read"],
					{
						stdin: prompt,
					},
				);

				const body = agentResult.output.trim();

				if (agentResult.code !== 0 || !body || body.toLowerCase().startsWith("error")) {
					dispatch({
						type: "PR_CREATE_ERROR",
						error: body || "Failed to generate PR body with AI",
					});
					return;
				}

				// Get title from first commit
				const title =
					run(`git log ${base}..HEAD --reverse --format=%s`, { cwd })?.split("\n")[0] ??
					s.prCreateBranch;

				// Show review instead of creating immediately
				dispatch({ type: "PR_CREATE_REVIEW", body, title });
			} catch (e: any) {
				const msg = e?.stderr?.trim() || e?.message || "PR creation failed";
				dispatch({ type: "PR_CREATE_ERROR", error: msg });
			}
		},
		[refresh],
	);

	const confirmPrCreate = useCallback(async () => {
		const s = stateRef.current;
		if (!s.prCreateWorktreePath || !s.prCreateBranch || !s.prCreateBody || !s.prCreateTitle) return;

		const base = getBaseBranch(s.prCreateBranch);
		const cwd = s.prCreateWorktreePath;

		dispatch({ type: "PR_CREATE_PHASE", phase: "creating" });
		try {
			const bodyFile = path.join(os.tmpdir(), `santree-pr-${Date.now()}.md`);
			fs.writeFileSync(bodyFile, s.prCreateBody);

			const { stdout } = await execAsync(
				`gh pr create --title "${s.prCreateTitle.replace(/"/g, '\\"')}" --base "${base}" --head "${s.prCreateBranch}" --body-file "${bodyFile}"`,
				{ cwd },
			);

			try {
				fs.unlinkSync(bodyFile);
			} catch {}

			dispatch({ type: "PR_CREATE_DONE", url: stdout.trim() });
			setTimeout(() => {
				dispatch({ type: "PR_CREATE_CANCEL" });
				refresh();
			}, 2500);
		} catch (e: any) {
			const msg = e?.stderr?.trim() || e?.message || "PR creation failed";
			dispatch({ type: "PR_CREATE_ERROR", error: msg });
		}
	}, [refresh]);

	const openPrInWeb = useCallback(async () => {
		const s = stateRef.current;
		if (!s.prCreateWorktreePath || !s.prCreateBranch) return;

		const base = getBaseBranch(s.prCreateBranch);
		const cwd = s.prCreateWorktreePath;

		try {
			await execAsync(`gh pr create --web --base "${base}" --head "${s.prCreateBranch}"`, { cwd });
			dispatch({ type: "PR_CREATE_DONE", url: "" });
			setTimeout(() => {
				dispatch({ type: "PR_CREATE_CANCEL" });
				refresh();
			}, 2500);
		} catch (e: any) {
			const msg = e?.stderr?.trim() || e?.message || "Failed to open in browser";
			dispatch({ type: "PR_CREATE_ERROR", error: msg });
		}
	}, [refresh]);

	// ── Keyboard ──────────────────────────────────────────────────────

	useInput(
		(input, key) => {
			// Clear action messages on any keypress
			if (state.actionMessage && input !== "q") {
				dispatch({ type: "SET_ACTION_MESSAGE", message: null });
			}

			// Commit overlay
			if (state.overlay === "commit") {
				if (key.escape) {
					dispatch({ type: "COMMIT_CANCEL" });
					return;
				}
				if (state.commitPhase === "confirm-stage") {
					if (input === "y") {
						handleStageAll();
						return;
					}
					if (input === "n") {
						dispatch({ type: "COMMIT_CANCEL" });
						return;
					}
					return;
				}
				// awaiting-message is handled by TextInput, not useInput
				// All other phases: swallow input
				return;
			}

			// PR create overlay
			if (state.overlay === "pr-create") {
				// Review phase — MultilineTextArea owns the keyboard
				if (state.prCreatePhase === "review") return;

				if (key.escape) {
					dispatch({ type: "PR_CREATE_CANCEL" });
					return;
				}
				if (state.prCreatePhase === "choose-mode") {
					if (input === "f") {
						doPrCreate(true);
						return;
					}
					if (input === "w") {
						doPrCreate(false);
						return;
					}
				}
				if (state.prCreatePhase === "confirm") {
					if (input === "y" || key.return) {
						confirmPrCreate();
						return;
					}
					if (input === "e") {
						dispatch({ type: "PR_CREATE_EDIT" });
						return;
					}
					if (input === "w") {
						openPrInWeb();
						return;
					}
				}
				if (state.prCreatePhase === "error") {
					if (input === "w") {
						openPrInWeb();
						return;
					}
				}
				return;
			}

			// Base select overlay
			if (state.overlay === "base-select") {
				const opts = state.baseSelectOptions;
				if (input === "j" || key.downArrow) {
					const next = Math.min(state.baseSelectIndex + 1, opts.length - 1);
					dispatch({ type: "BASE_SELECT_MOVE", index: next });
					return;
				}
				if (input === "k" || key.upArrow) {
					const prev = Math.max(state.baseSelectIndex - 1, 0);
					dispatch({ type: "BASE_SELECT_MOVE", index: prev });
					return;
				}
				if (key.return) {
					const chosen = opts[state.baseSelectIndex];
					if (chosen) {
						dispatch({ type: "BASE_SELECT_CONFIRM", chosen });
						const mode = state.setupMode;
						if (mode) {
							proceedAfterBaseSelect(mode, chosen);
						}
					}
					return;
				}
				if (key.escape) {
					dispatch({ type: "BASE_SELECT_DONE" });
					return;
				}
				return;
			}

			// Confirm setup overlay
			if (state.overlay === "confirm-setup") {
				const mode = state.setupMode;
				const base = state.baseSelectChosen ?? undefined;
				if (input === "y" && mode) {
					dispatch({ type: "SETUP_CONFIRM_DONE" });
					const contextFile = pendingContextFileRef.current ?? undefined;
					pendingContextFileRef.current = null;
					createAndLaunch(mode, true, base, contextFile);
					return;
				}
				if (input === "n" && mode) {
					dispatch({ type: "SETUP_CONFIRM_DONE" });
					const contextFile = pendingContextFileRef.current ?? undefined;
					pendingContextFileRef.current = null;
					createAndLaunch(mode, false, base, contextFile);
					return;
				}
				if (key.escape) {
					dispatch({ type: "SETUP_CONFIRM_DONE" });
					pendingContextFileRef.current = null;
					return;
				}
				return;
			}

			// Mode select overlay
			if (state.overlay === "mode-select") {
				if (input === "p" || input === "1") {
					dispatch({ type: "CONTEXT_INPUT_SHOW", mode: "plan" });
					return;
				}
				if (input === "i" || input === "2") {
					dispatch({ type: "CONTEXT_INPUT_SHOW", mode: "implement" });
					return;
				}
				if (key.escape || input === "q") {
					dispatch({ type: "SET_OVERLAY", overlay: null });
					return;
				}
				return;
			}

			// Context-input overlay.
			// Editing phase: MultilineTextArea owns useInput (outer is disabled
			// via isActive below).
			// Review phase: outer handles y/n/e/ESC.
			if (state.overlay === "context-input") {
				if (state.contextInputPhase === "review") {
					if (input === "y" || key.return) {
						const mode = state.contextInputMode;
						const ctx = state.contextInputValue;
						dispatch({ type: "CONTEXT_INPUT_DONE" });
						if (mode) doWork(mode, ctx);
						return;
					}
					if (input === "n" || input === "e") {
						dispatch({ type: "CONTEXT_INPUT_EDIT" });
						return;
					}
					if (key.escape) {
						dispatch({ type: "CONTEXT_INPUT_DONE" });
						return;
					}
				}
				return;
			}

			// Diff overlay
			if (state.overlay === "diff") {
				if (key.escape || input === "q") {
					dispatch({ type: "DIFF_CLOSE" });
					return;
				}
				const fileCount = state.diffFiles.length;
				if (fileCount === 0) return;

				// Compute max scroll so we never scroll past the end of the diff.
				const cols = stdout?.columns ?? 80;
				const rowsRem = stdout?.rows ?? 24;
				const contentHeight = Math.max(3, rowsRem - 2);
				const layout = computeDiffLayout({
					width: Math.max(40, cols - 2), // outer box border eats 1 col on each side
					height: contentHeight,
					files: state.diffFiles,
					fileIndex: state.diffFileIndex,
					fileScrollOffset: state.diffFileScrollOffset,
					leftWidthOverride: diffLeftWidth ?? undefined,
				});
				const totalLines = state.diffContent ? state.diffContent.split("\n").length : 0;
				const maxScroll = Math.max(0, totalLines - layout.bodyHeight);

				// Scroll diff content (J/K or shift+arrows)
				if ((key.shift && key.downArrow) || input === "J") {
					dispatch({
						type: "DIFF_CONTENT_SCROLL",
						offset: Math.min(maxScroll, state.diffContentScrollOffset + 5),
					});
					return;
				}
				if ((key.shift && key.upArrow) || input === "K") {
					dispatch({
						type: "DIFF_CONTENT_SCROLL",
						offset: Math.max(0, state.diffContentScrollOffset - 5),
					});
					return;
				}
				if (input === "g") {
					dispatch({ type: "DIFF_CONTENT_SCROLL", offset: 0 });
					return;
				}
				if (input === "G") {
					dispatch({ type: "DIFF_CONTENT_SCROLL", offset: maxScroll });
					return;
				}
				// Navigate file list (j/k or arrows)
				if (input === "j" || (key.downArrow && !key.shift)) {
					const next = Math.min(state.diffFileIndex + 1, fileCount - 1);
					dispatch({ type: "DIFF_FILE_SELECT", index: next });
					return;
				}
				if (input === "k" || (key.upArrow && !key.shift)) {
					const prev = Math.max(state.diffFileIndex - 1, 0);
					dispatch({ type: "DIFF_FILE_SELECT", index: prev });
					return;
				}
				return;
			}

			// Confirm delete overlay
			if (state.overlay === "confirm-delete") {
				if (input === "y") {
					dispatch({ type: "SET_OVERLAY", overlay: null });
					const di = state.flatIssues[state.selectedIndex];
					if (di?.worktree) {
						const repoRoot = repoRootRef.current;
						if (repoRoot) {
							dispatch({ type: "DELETE_START", ticketId: di.issue.identifier });
							const force = di.worktree.dirty;
							removeWorktree(di.worktree.branch, repoRoot, force).then((result) => {
								dispatch({ type: "DELETE_DONE" });
								if (result.success) {
									dispatch({
										type: "SET_ACTION_MESSAGE",
										message: `Removed worktree for ${di.issue.identifier}`,
									});
									refresh();
								} else {
									dispatch({
										type: "SET_ACTION_MESSAGE",
										message: `Failed: ${result.error ?? "Unknown error"}`,
									});
								}
							});
						}
					}
					return;
				}
				if (input === "n" || key.escape || input === "q") {
					dispatch({ type: "SET_OVERLAY", overlay: null });
					return;
				}
				return;
			}

			// Tab switching (only when no overlay is active)
			if (key.tab) {
				dispatch({
					type: "SET_TAB",
					tab: state.activeTab === "issues" ? "reviews" : "issues",
				});
				return;
			}
			if (input === "1") {
				dispatch({ type: "SET_TAB", tab: "issues" });
				return;
			}
			if (input === "2") {
				dispatch({ type: "SET_TAB", tab: "reviews" });
				return;
			}

			// Quit
			if (input === "q") {
				exit();
				return;
			}

			// Refresh (shared across tabs)
			if (input === "R") {
				refresh();
				return;
			}

			// ── Reviews tab keyboard ─────────────────────────────────
			if (state.activeTab === "reviews") {
				const maxReviewIdx = state.flatReviews.length - 1;

				if (input === "j" || (key.downArrow && !key.shift)) {
					const next = Math.min(state.reviewSelectedIndex + 1, maxReviewIdx);
					dispatch({ type: "REVIEW_SELECT", index: next });
					return;
				}
				if (input === "k" || (key.upArrow && !key.shift)) {
					const prev = Math.max(state.reviewSelectedIndex - 1, 0);
					dispatch({ type: "REVIEW_SELECT", index: prev });
					return;
				}
				if (key.shift && key.downArrow) {
					dispatch({
						type: "REVIEW_SCROLL_DETAIL",
						offset: state.reviewDetailScrollOffset + 3,
					});
					return;
				}
				if (key.shift && key.upArrow) {
					dispatch({
						type: "REVIEW_SCROLL_DETAIL",
						offset: Math.max(0, state.reviewDetailScrollOffset - 3),
					});
					return;
				}

				const ri = state.flatReviews[state.reviewSelectedIndex];
				if (!ri) return;

				// Open PR in browser
				if (input === "o") {
					if (ri.pr.url) {
						const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
						execSync(`${openCmd} "${ri.pr.url}"`, { stdio: "ignore" });
						dispatch({ type: "SET_ACTION_MESSAGE", message: "Opened PR in browser" });
					}
					return;
				}

				// Create worktree from PR branch (checkout for local testing)
				if (input === "w") {
					if (ri.worktree) {
						dispatch({ type: "SET_ACTION_MESSAGE", message: "Worktree already exists" });
						return;
					}
					if (!ri.branch) {
						dispatch({ type: "SET_ACTION_MESSAGE", message: "No branch info" });
						return;
					}
					const repoRoot = repoRootRef.current;
					if (!repoRoot) return;
					if (state.creatingForTicket) return;

					const ticketId = extractTicketId(ri.branch);
					if (!ticketId) {
						dispatch({ type: "SET_ACTION_MESSAGE", message: "No ticket ID in branch" });
						return;
					}

					dispatch({ type: "CREATION_START", ticketId });

					(async () => {
						try {
							dispatch({ type: "CREATION_LOG", logs: `Fetching ${ri.branch}...\n` });
							await execAsync(`git fetch origin ${ri.branch}`, { cwd: repoRoot });

							dispatch({ type: "CREATION_LOG", logs: `Creating worktree...\n` });
							const result = await createWorktree(
								ri.branch!,
								ri.baseBranch ?? getDefaultBranch(),
								repoRoot,
							);

							if (!result.success || !result.path) {
								dispatch({ type: "CREATION_ERROR", error: result.error ?? "Unknown error" });
								dispatch({ type: "SET_ACTION_MESSAGE", message: `Failed: ${result.error}` });
								return;
							}

							dispatch({ type: "CREATION_LOG", logs: `Worktree at ${result.path}\n` });

							// Run init script if available
							if (hasInitScript(repoRoot)) {
								const initScript = getInitScriptPath(repoRoot);
								let canExecute = true;
								try {
									fs.accessSync(initScript, fs.constants.X_OK);
								} catch {
									dispatch({ type: "CREATION_LOG", logs: "init.sh not executable, skipping\n" });
									canExecute = false;
								}
								if (canExecute) {
									dispatch({ type: "CREATION_LOG", logs: "Running init.sh...\n" });
									let lastLen = 0;
									const initResult = await spawnAsync(initScript, [], {
										cwd: result.path,
										env: {
											...process.env,
											SANTREE_WORKTREE_PATH: result.path,
											SANTREE_REPO_ROOT: repoRoot,
										},
										onOutput: (output) => {
											const delta = output.slice(lastLen);
											if (delta) dispatch({ type: "CREATION_LOG", logs: delta });
											lastLen = output.length;
										},
									});
									if (initResult.code !== 0) {
										dispatch({
											type: "CREATION_LOG",
											logs: `\ninit.sh exited with code ${initResult.code}\n`,
										});
									} else {
										dispatch({ type: "CREATION_LOG", logs: "\nSetup complete!\n" });
									}
								}
							}

							dispatch({ type: "CREATION_DONE" });
							dispatch({ type: "SET_ACTION_MESSAGE", message: `Worktree created for ${ticketId}` });
							// Open in editor automatically
							const editor = process.env.SANTREE_EDITOR || "code";
							spawn(editor, [result.path], { detached: true, stdio: "ignore" }).unref();
							refresh();
						} catch (e: any) {
							dispatch({ type: "CREATION_ERROR", error: e?.message ?? "Failed" });
						}
					})();
					return;
				}

				// Open in editor
				if (input === "e") {
					if (!ri.worktree) {
						dispatch({ type: "SET_ACTION_MESSAGE", message: "No worktree (press w to checkout)" });
						return;
					}
					const editor = process.env.SANTREE_EDITOR || "code";
					spawn(editor, [ri.worktree.path], { detached: true, stdio: "ignore" }).unref();
					dispatch({ type: "SET_ACTION_MESSAGE", message: `Opened in ${editor}` });
					return;
				}

				// AI Review in multiplexer
				if (input === "r") {
					if (!ri.worktree) {
						dispatch({
							type: "SET_ACTION_MESSAGE",
							message: "No worktree (press w to checkout first)",
						});
						return;
					}
					const mux = getMultiplexer();
					if (mux.isActive()) {
						const windowName = `review-${extractTicketId(ri.branch ?? "") ?? ri.pr.number}`;
						const cwd = ri.worktree.path;
						void (async () => {
							const created = await mux.createWindow({
								name: windowName,
								cwd,
								command: "st pr review",
							});
							dispatch({
								type: "SET_ACTION_MESSAGE",
								message: created.ok
									? `Launched AI review in ${mux.kind}`
									: `Failed to launch review${created.message ? `: ${created.message}` : ""}`,
							});
						})();
					} else {
						leaveAltScreen();
						console.log(`SANTREE_CD:${ri.worktree.path}`);
						exit();
					}
					return;
				}

				// Delete worktree
				if (input === "d") {
					if (!ri.worktree || !ri.branch) {
						dispatch({ type: "SET_ACTION_MESSAGE", message: "No worktree to remove" });
						return;
					}
					const repoRoot = repoRootRef.current;
					if (!repoRoot) return;
					const ticketId = extractTicketId(ri.branch);
					if (!ticketId) return;
					dispatch({ type: "DELETE_START", ticketId });
					const force = ri.worktree.dirty;
					removeWorktree(ri.branch, repoRoot, force).then((result) => {
						dispatch({ type: "DELETE_DONE" });
						if (result.success) {
							dispatch({ type: "SET_ACTION_MESSAGE", message: `Removed worktree` });
							refresh();
						} else {
							dispatch({ type: "SET_ACTION_MESSAGE", message: `Failed: ${result.error}` });
						}
					});
					return;
				}

				return; // prevent fallthrough to issues actions
			}

			const maxIndex = state.flatIssues.length - 1;

			// Navigation
			if (input === "j" || (key.downArrow && !key.shift)) {
				const next = Math.min(state.selectedIndex + 1, maxIndex);
				dispatch({ type: "SELECT", index: next });
				return;
			}
			if (input === "k" || (key.upArrow && !key.shift)) {
				const prev = Math.max(state.selectedIndex - 1, 0);
				dispatch({ type: "SELECT", index: prev });
				return;
			}

			// Detail scroll
			if (key.shift && key.downArrow) {
				dispatch({ type: "SCROLL_DETAIL", offset: state.detailScrollOffset + 3 });
				return;
			}
			if (key.shift && key.upArrow) {
				dispatch({
					type: "SCROLL_DETAIL",
					offset: Math.max(0, state.detailScrollOffset - 3),
				});
				return;
			}

			const di = state.flatIssues[state.selectedIndex];
			if (!di) return;

			// Work
			if (input === "w") {
				if (di.worktree?.sessionId) {
					dispatch({
						type: "SET_ACTION_MESSAGE",
						message: "Session active. Press Enter to resume.",
					});
					return;
				}
				dispatch({ type: "SET_OVERLAY", overlay: "mode-select" });
				return;
			}

			// Switch to worktree (Enter) — also resumes session
			if (key.return) {
				if (!di.worktree) {
					dispatch({ type: "SET_ACTION_MESSAGE", message: "No worktree to switch to" });
					return;
				}
				const mux = getMultiplexer();
				if (mux.isActive()) {
					const windowName = di.issue.identifier;
					const sessionId = di.worktree.sessionId;
					const bin = resolveAgentBinary();
					const resumeCmd = sessionId && bin ? `${bin} --resume ${sessionId}` : null;
					const worktreePath = di.worktree.path;
					void (async () => {
						const selected = await mux.selectWindow(windowName);
						if (selected.ok) return;
						const cmd = resumeCmd ?? "st worktree work";
						const created = await mux.createWindow({
							name: windowName,
							cwd: worktreePath,
							command: cmd,
						});
						if (!created.ok) {
							dispatch({
								type: "SET_ACTION_MESSAGE",
								message: `Failed to switch ${mux.kind} window${created.message ? `: ${created.message}` : ""}`,
							});
						}
					})();
				} else {
					leaveAltScreen();
					console.log(`SANTREE_CD:${di.worktree.path}`);
					exit();
				}
				return;
			}

			// Open in Linear
			if (input === "o") {
				if (!di.issue.url) {
					dispatch({ type: "SET_ACTION_MESSAGE", message: "No Linear ticket URL" });
					return;
				}
				const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
				execSync(`${openCmd} "${di.issue.url}"`, { stdio: "ignore" });
				dispatch({ type: "SET_ACTION_MESSAGE", message: "Opened in browser" });
				return;
			}

			// Open PR
			if (input === "p") {
				if (!di.pr?.url) {
					dispatch({ type: "SET_ACTION_MESSAGE", message: "No PR to open" });
					return;
				}
				const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
				execSync(`${openCmd} "${di.pr.url}"`, { stdio: "ignore" });
				dispatch({ type: "SET_ACTION_MESSAGE", message: "Opened PR in browser" });
				return;
			}

			// Create PR
			if (input === "c") {
				if (!di.worktree) {
					dispatch({ type: "SET_ACTION_MESSAGE", message: "Create a worktree first (w)" });
					return;
				}
				if (di.pr) {
					dispatch({ type: "SET_ACTION_MESSAGE", message: "PR already exists" });
					return;
				}
				dispatch({
					type: "PR_CREATE_START",
					ticketId: di.issue.identifier,
					worktreePath: di.worktree.path,
					branch: di.worktree.branch,
				});
				return;
			}

			// Review PR
			if (input === "r") {
				if (!di.pr || !di.worktree) {
					dispatch({ type: "SET_ACTION_MESSAGE", message: "No PR to review" });
					return;
				}
				const mux = getMultiplexer();
				if (mux.isActive()) {
					const windowName = `review-${di.issue.identifier}`;
					const cwd = di.worktree.path;
					void (async () => {
						const created = await mux.createWindow({
							name: windowName,
							cwd,
							command: "st pr review",
						});
						dispatch({
							type: "SET_ACTION_MESSAGE",
							message: created.ok
								? `Launched review in ${mux.kind}`
								: `Failed to launch review${created.message ? `: ${created.message}` : ""}`,
						});
					})();
				} else {
					leaveAltScreen();
					console.log(`SANTREE_CD:${di.worktree.path}`);
					exit();
				}
				return;
			}

			// Open in editor
			if (input === "e") {
				if (!di.worktree) {
					dispatch({ type: "SET_ACTION_MESSAGE", message: "No worktree to open" });
					return;
				}
				openInEditor(di.worktree.path);
				return;
			}

			// Open workspace — no-op unless the editor accepts a .code-workspace
			// file and one exists. Keeps the keybinding from firing surprises on
			// editors like zed/nvim that don't have the concept.
			if (input === "E") {
				if (hasWorkspaceFile) openWorkspace();
				return;
			}

			// Commit & push
			if (input === "C") {
				if (!di.worktree) {
					dispatch({ type: "SET_ACTION_MESSAGE", message: "No worktree" });
					return;
				}
				if (!di.worktree.dirty) {
					dispatch({ type: "SET_ACTION_MESSAGE", message: "No changes to commit" });
					return;
				}
				dispatch({
					type: "COMMIT_START",
					ticketId: di.issue.identifier,
					worktreePath: di.worktree.path,
					branch: di.worktree.branch,
					gitStatus: di.worktree.gitStatus,
				});
				return;
			}

			// Fix PR
			if (input === "f") {
				if (!di.pr || !di.worktree) {
					dispatch({ type: "SET_ACTION_MESSAGE", message: "No PR to fix" });
					return;
				}
				const mux = getMultiplexer();
				if (mux.isActive()) {
					const windowName = `fix-${di.issue.identifier}`;
					const cwd = di.worktree.path;
					void (async () => {
						const created = await mux.createWindow({
							name: windowName,
							cwd,
							command: "st pr fix",
						});
						dispatch({
							type: "SET_ACTION_MESSAGE",
							message: created.ok
								? `Launched PR fix in ${mux.kind}`
								: `Failed to launch PR fix${created.message ? `: ${created.message}` : ""}`,
						});
					})();
				} else {
					leaveAltScreen();
					console.log(`SANTREE_CD:${di.worktree.path}`);
					exit();
				}
				return;
			}

			// View diff (inline overlay)
			if (input === "v") {
				if (!di.worktree) {
					dispatch({ type: "SET_ACTION_MESSAGE", message: "No worktree to diff" });
					return;
				}
				const baseBranch = getBaseBranch(di.worktree.branch);
				dispatch({
					type: "DIFF_OPEN",
					ticketId: di.issue.identifier,
					worktreePath: di.worktree.path,
					baseBranch,
				});
				return;
			}

			// Delete worktree
			if (input === "d") {
				if (!di.worktree) {
					dispatch({ type: "SET_ACTION_MESSAGE", message: "No worktree to remove" });
					return;
				}
				dispatch({ type: "SET_OVERLAY", overlay: "confirm-delete" });
				return;
			}
		},
		{
			isActive:
				(state.overlay !== "context-input" || state.contextInputPhase === "review") &&
				(state.overlay !== "pr-create" || state.prCreatePhase !== "review") &&
				(state.overlay !== "commit" || state.commitPhase !== "awaiting-message"),
		},
	);

	// ── Render ─────────────────────────────────────────────────────────

	if (state.loading) {
		return (
			<Box width={columns} height={rows} flexDirection="column">
				<Box justifyContent="center" alignItems="center" flexGrow={1}>
					<Text color="cyan">
						<Spinner type="dots" />
					</Text>
					<Text> Loading dashboard...</Text>
				</Box>
			</Box>
		);
	}

	if (state.error) {
		return (
			<Box width={columns} height={rows} flexDirection="column">
				<Box justifyContent="center" alignItems="center" flexGrow={1} flexDirection="column">
					<Text color="red" bold>
						Error: {state.error}
					</Text>
					<Text dimColor>Press R to retry or q to quit</Text>
				</Box>
			</Box>
		);
	}

	const selectedIssue = state.flatIssues[state.selectedIndex] ?? null;
	const selectedReview = state.flatReviews[state.reviewSelectedIndex] ?? null;

	return (
		<Box width={columns} height={rows} flexDirection="column">
			{/* Header — single line: brand + meta */}
			<Box paddingX={1}>
				<Text bold color="cyan">
					santree
				</Text>
				<Text dimColor>
					{"  "}v{version}
				</Text>
				{updateAvailable && latestVersion ? (
					<Text color="yellow">
						{"  ⬆ v"}
						{latestVersion}
						{" available — `santree update`"}
					</Text>
				) : null}
				{CLAUDE_VERSION ? (
					<Text dimColor>
						{"  ·  claude "}
						{CLAUDE_VERSION}
					</Text>
				) : null}
				{claudeUpdateAvailable && latestClaudeVersion ? (
					<Text color="yellow">
						{"  ⬆ "}
						{latestClaudeVersion}
					</Text>
				) : null}
				{state.refreshing ? <Text dimColor>{"  ·  refreshing…"}</Text> : null}
				{state.actionMessage ? (
					<Text color="yellow">
						{"  ·  "}
						{state.actionMessage}
					</Text>
				) : null}
			</Box>

			{/* Tab strip \u2014 pill-style; active tab highlighted with cyan background.
			    Count in parens disambiguates the trailing number from the tab keybind. */}
			<Box paddingX={1}>
				<Tab
					active={state.activeTab === "issues"}
					label={`1 Issues (${state.flatIssues.length})`}
					mode={theme.mode}
				/>
				<Text> </Text>
				<Tab
					active={state.activeTab === "reviews"}
					label={`2 Reviews (${state.flatReviews.length})`}
					mode={theme.mode}
				/>
			</Box>

			{/* Bordered content area — wraps tab content for a real "panel" feel */}
			<Box flexGrow={1} borderStyle="round" borderColor="cyan" flexDirection="column">
				{/* Main content */}
				{state.overlay === "mode-select" ? (
					<Box flexGrow={1} justifyContent="center" alignItems="center">
						<Box
							flexDirection="column"
							borderStyle="round"
							borderColor="cyan"
							paddingX={3}
							paddingY={1}
						>
							<Text bold>Select mode:</Text>
							<Text> </Text>
							<Text>
								<Text color="cyan" bold>
									p
								</Text>
								{"  Plan"}
							</Text>
							<Text>
								<Text color="cyan" bold>
									i
								</Text>
								{"  Implement"}
							</Text>
							<Text> </Text>
							<Text dimColor>ESC to cancel</Text>
						</Box>
					</Box>
				) : state.overlay === "context-input" ? (
					<Box flexGrow={1} justifyContent="center" alignItems="center">
						<Box flexDirection="column" paddingX={2} width={Math.min(columns - 8, 100)}>
							<Text bold color="cyan">
								Extra context for {state.contextInputMode}
							</Text>
							<Text dimColor>Optional — appended to the prompt before launching Claude</Text>
							<Text> </Text>
							{state.contextInputPhase === "editing" ? (
								<>
									<MultilineTextArea
										value={state.contextInputValue}
										onChange={(v) => dispatch({ type: "CONTEXT_INPUT_CHANGE", value: v })}
										onSubmit={() => dispatch({ type: "CONTEXT_INPUT_REVIEW" })}
										onCancel={() => dispatch({ type: "CONTEXT_INPUT_DONE" })}
										width={Math.min(columns - 8, 100)}
										height={10}
										placeholder="Type or paste extra context…"
									/>
									<Text> </Text>
									<Text dimColor>
										<Text color="cyan" bold>
											Ctrl+D
										</Text>
										{" send  ·  "}
										<Text color="cyan" bold>
											Ctrl+O
										</Text>
										{" editor  ·  "}
										<Text color="cyan" bold>
											Ctrl+C
										</Text>
										{" cancel"}
									</Text>
								</>
							) : (
								<>
									<Box
										flexDirection="column"
										borderStyle="round"
										borderColor="green"
										paddingX={1}
										minHeight={6}
									>
										{(state.contextInputValue || "(no extra context)")
											.split("\n")
											.slice(0, 12)
											.map((line, i) => (
												<Text key={i}>{line || " "}</Text>
											))}
										{state.contextInputValue.split("\n").length > 12 && (
											<Text dimColor>
												…+{state.contextInputValue.split("\n").length - 12} more lines
											</Text>
										)}
									</Box>
									<Text> </Text>
									<Text bold>Anything else to add?</Text>
									<Text> </Text>
									<Text>
										<Text color="green" bold>
											y
										</Text>
										{" / "}
										<Text color="green" bold>
											Enter
										</Text>
										{"  launch   "}
										<Text color="yellow" bold>
											n
										</Text>
										{" / "}
										<Text color="yellow" bold>
											e
										</Text>
										{"  keep editing   "}
										<Text color="red" bold>
											ESC
										</Text>
										{"  cancel"}
									</Text>
								</>
							)}
						</Box>
					</Box>
				) : state.overlay === "base-select" ? (
					<Box flexGrow={1} justifyContent="center" alignItems="center">
						<Box
							flexDirection="column"
							borderStyle="round"
							borderColor="cyan"
							paddingX={3}
							paddingY={1}
						>
							<Text bold>Select base branch:</Text>
							<Text> </Text>
							{state.baseSelectOptions.map((branch, idx) => {
								const selected = idx === state.baseSelectIndex;
								const defaultBranch = getDefaultBranch();
								const label = branch === defaultBranch ? `${branch} (default)` : branch;
								return (
									<Text key={branch}>
										<Text color={selected ? "cyan" : undefined} bold={selected}>
											{selected ? "> " : "  "}
											{label}
										</Text>
									</Text>
								);
							})}
							<Text> </Text>
							<Text dimColor>j/k to navigate, Enter to select, ESC to cancel</Text>
						</Box>
					</Box>
				) : state.overlay === "confirm-delete" ? (
					<Box flexGrow={1} justifyContent="center" alignItems="center">
						<Box
							flexDirection="column"
							borderStyle="round"
							borderColor="red"
							paddingX={3}
							paddingY={1}
						>
							<Text bold color="red">
								Remove worktree?
							</Text>
							<Text> </Text>
							<Text>{selectedIssue?.worktree?.branch ?? ""}</Text>
							{selectedIssue?.worktree?.dirty && (
								<Text color="yellow">Warning: worktree has uncommitted changes</Text>
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
				) : state.overlay === "diff" ? (
					<DiffOverlay
						width={innerWidth}
						height={contentHeight}
						ticketId={state.diffTicketId ?? ""}
						baseBranch={state.diffBaseBranch ?? ""}
						files={state.diffFiles}
						fileIndex={state.diffFileIndex}
						fileScrollOffset={state.diffFileScrollOffset}
						content={state.diffContent}
						contentScrollOffset={state.diffContentScrollOffset}
						loadingFiles={state.diffLoadingFiles}
						loadingContent={state.diffLoadingContent}
						error={state.diffError}
						selectionBg={theme.selectionBg}
						leftWidthOverride={diffLeftWidth ?? undefined}
					/>
				) : state.overlay === "confirm-setup" ? (
					<Box flexGrow={1} justifyContent="center" alignItems="center">
						<Box
							flexDirection="column"
							borderStyle="round"
							borderColor="yellow"
							paddingX={3}
							paddingY={1}
						>
							<Text bold>Run setup script?</Text>
							<Text> </Text>
							<Text dimColor>.santree/init.sh</Text>
							<Text> </Text>
							<Text>
								<Text color="green" bold>
									y
								</Text>
								{"  Run setup"}
							</Text>
							<Text>
								<Text color="yellow" bold>
									n
								</Text>
								{"  Skip"}
							</Text>
						</Box>
					</Box>
				) : (
					<Box flexGrow={1}>
						{/* Left pane */}
						<Box width={leftWidth}>
							{state.activeTab === "reviews" ? (
								<ReviewList
									flatReviews={state.flatReviews}
									selectedIndex={state.reviewSelectedIndex}
									scrollOffset={state.reviewListScrollOffset}
									height={contentHeight}
									width={leftWidth}
									selectionBg={theme.selectionBg}
								/>
							) : state.flatIssues.length === 0 ? (
								<Box
									width={leftWidth}
									height={contentHeight}
									justifyContent="center"
									alignItems="center"
								>
									<Text color="yellow">No active issues</Text>
								</Box>
							) : (
								<IssueList
									groups={state.groups}
									flatIssues={state.flatIssues}
									selectedIndex={state.selectedIndex}
									scrollOffset={state.listScrollOffset}
									height={contentHeight}
									width={leftWidth}
									selectionBg={theme.selectionBg}
								/>
							)}
						</Box>

						{/* Separator */}
						<Box flexDirection="column" width={3}>
							{Array.from({ length: contentHeight }).map((_, i) => (
								<Text key={i} dimColor>
									{" │ "}
								</Text>
							))}
						</Box>

						{/* Right pane */}
						<Box width={rightWidth}>
							{state.activeTab === "reviews" && state.creatingForTicket ? (
								<Box flexDirection="column" width={rightWidth} height={contentHeight}>
									<Text color="yellow" bold>
										Setting up worktree for {state.creatingForTicket}...
									</Text>
									{state.creationLogs
										.split("\n")
										.slice(-(contentHeight - 1))
										.map((line, i) => (
											<Box key={i}>
												<Text dimColor>{line}</Text>
											</Box>
										))}
								</Box>
							) : state.activeTab === "reviews" ? (
								<ReviewDetailPanel
									item={selectedReview}
									scrollOffset={state.reviewDetailScrollOffset}
									height={contentHeight}
									width={rightWidth}
								/>
							) : state.overlay === "commit" ? (
								<CommitOverlay
									width={rightWidth}
									height={contentHeight}
									branch={state.commitBranch}
									ticketId={state.commitTicketId}
									gitStatus={state.commitGitStatus}
									phase={state.commitPhase}
									message={state.commitMessage}
									error={state.commitError}
									dispatch={dispatch}
									onSubmit={handleCommitSubmit}
								/>
							) : state.overlay === "pr-create" ? (
								<PrCreateOverlay
									width={rightWidth}
									height={contentHeight}
									branch={state.prCreateBranch}
									ticketId={state.prCreateTicketId}
									phase={state.prCreatePhase}
									error={state.prCreateError}
									url={state.prCreateUrl}
									body={state.prCreateBody}
									title={state.prCreateTitle}
									dispatch={dispatch}
								/>
							) : (
								<DetailPanel
									issue={selectedIssue}
									scrollOffset={state.detailScrollOffset}
									height={contentHeight}
									width={rightWidth}
									creatingForTicket={state.creatingForTicket}
									creationLogs={state.creationLogs}
								/>
							)}
						</Box>
					</Box>
				)}

				{/* Dashboard-wide footer row inside the bordered area: global
				    command bar on the left, context-sensitive action keys on the
				    right. Both panes' key hints sit on the same row. */}
				<Box>
					<Box width={leftWidth + separatorWidth} paddingX={1}>
						<CommandBar
							showWorkspace={hasWorkspaceFile}
							mode={state.overlay === "diff" ? "diff" : "default"}
						/>
					</Box>
					<Box width={rightWidth}>
						<ActionRow
							activeTab={state.activeTab}
							selectedIssue={selectedIssue}
							selectedReview={selectedReview}
							overlay={state.overlay}
						/>
					</Box>
				</Box>
			</Box>
		</Box>
	);
}

/**
 * Renders the per-issue action key hints (Resume / Editor / View diff / …)
 * lifted out of the detail panels so they sit on the same row as the global
 * command bar. Empty when nothing is selected.
 */
function ActionRow({
	activeTab,
	selectedIssue,
	selectedReview,
	overlay,
}: {
	activeTab: "issues" | "reviews";
	selectedIssue: DashboardIssue | null;
	selectedReview: import("../lib/dashboard/types.js").EnrichedReviewPR | null;
	overlay: import("../lib/dashboard/types.js").ActionOverlay;
}) {
	// During the diff overlay, none of the per-issue actions apply (View diff
	// is what got us here, Commit/PR/etc. need the detail panel context). Keep
	// the row blank so the diff-specific CommandBar reads cleanly.
	if (overlay === "diff") return <Text> </Text>;

	const items: Array<IssueActionItem | ReviewActionItem> =
		activeTab === "reviews"
			? selectedReview
				? buildReviewActions(selectedReview)
				: []
			: selectedIssue
				? buildIssueActions(selectedIssue)
				: [];

	if (items.length === 0) return <Text> </Text>;

	return (
		<Text>
			{items.map((item, j) => (
				<Text key={j}>
					{"  "}
					<Text color={item.color} bold>
						{item.key}
					</Text>
					<Text color={item.color === "gray" ? "gray" : undefined}> {item.label}</Text>
				</Text>
			))}
		</Text>
	);
}

type IssueActionItem = ReturnType<typeof buildIssueActions>[number];
type ReviewActionItem = ReturnType<typeof buildReviewActions>[number];
