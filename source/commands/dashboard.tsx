import { useEffect, useReducer, useCallback, useRef, useState } from "react";
import { Text, Box, useInput, useStdout, useApp } from "ink";
import { exec, spawn } from "child_process";
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
	getWorktreeStatus,
	stageFile,
	unstageFile,
	stageAll,
	unstageAll,
	discardFile,
} from "../lib/git.js";
import { run, spawnAsync } from "../lib/exec.js";
import { resolveAgentBinary, fillCommitMessage } from "../lib/ai.js";
import { getInstalledClaudeVersion } from "../lib/version.js";
import { extractTicketId, getStagedDiffContent } from "../lib/git.js";
import { getMultiplexer } from "../lib/multiplexer/index.js";
import { shellEscape } from "../lib/multiplexer/types.js";
import Spinner from "ink-spinner";
import SquirrelLoader from "../lib/squirrel-loader.js";
import { getPRTemplate } from "../lib/github.js";
import { renderPrompt, renderDiff, renderTicket } from "../lib/prompts.js";
import { getIssueTracker, isRepoTrackerConfigured, setRepoTracker } from "../lib/trackers/index.js";
import { setRepoLinearOrg } from "../lib/trackers/linear/index.js";
import { readLinearAuthStore } from "../lib/trackers/auth-store.js";
import { getAuthenticatedUser, getCurrentRepoNwo } from "../lib/trackers/github/auth.js";
import { openUrl } from "../lib/open-url.js";
import { parseUnifiedDiff } from "../lib/diff-parse.js";
import * as os from "os";
import type { DashboardIssue, ProjectGroup } from "../lib/dashboard/types.js";
import { initialState, reducer } from "../lib/dashboard/types.js";
import { loadDashboardData, loadReviewsData } from "../lib/dashboard/data.js";
import IssueList, { buildIssueListRows } from "../lib/dashboard/IssueList.js";
import {
	detectTerminalTheme,
	getThemeForMode,
	type DashboardTheme,
	type ThemeMode,
} from "../lib/dashboard/theme.js";
import DetailPanel, { buildIssueActions } from "../lib/dashboard/DetailPanel.js";
import ReviewList from "../lib/dashboard/ReviewList.js";
import ReviewDetailPanel, { buildReviewActions } from "../lib/dashboard/ReviewDetailPanel.js";
import { CommitOverlay, PrCreateOverlay, HelpOverlay } from "../lib/dashboard/Overlays.js";
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

export const description = "Interactive dashboard of your assigned issues";

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
 * Split combined-parameter SGR sequences (e.g. `\x1b[48;2;R;G;B;38;2;R;G;B m`)
 * into separate single-attribute SGRs (`\x1b[48;2;...m\x1b[38;2;...m`).
 *
 * Why: Ink uses `slice-ansi` to clip text horizontally, and `slice-ansi`
 * miscounts visible width on combined RGB bg+fg SGRs — it cuts the line at
 * roughly half the requested visible width. Delta emits exactly this combined
 * form on every styled token, so the diff pane was rendering content cut at
 * arbitrary points (e.g. `from datetime i` instead of `from datetime import
 * timedelta`). Splitting them sidesteps the slice-ansi bug without losing any
 * styling — the terminal renders the two SGRs identically to the combined one.
 */
function splitCombinedSgr(s: string): string {
	return s.replace(/\x1b\[([0-9;]+)m/g, (_match, params: string) => {
		const tokens = params.split(";");
		const groups: string[] = [];
		for (let i = 0; i < tokens.length; i++) {
			const t = tokens[i]!;
			if ((t === "38" || t === "48") && tokens[i + 1] === "2") {
				groups.push([t, "2", tokens[i + 2], tokens[i + 3], tokens[i + 4]].join(";"));
				i += 4;
			} else if ((t === "38" || t === "48") && tokens[i + 1] === "5") {
				groups.push([t, "5", tokens[i + 2]].join(";"));
				i += 2;
			} else {
				groups.push(t);
			}
		}
		if (groups.length <= 1) return `\x1b[${params}m`;
		return groups.map((g) => `\x1b[${g}m`).join("");
	});
}

/**
 * Pipe `git diff` output through an external tool (e.g. delta) and return the
 * combined ANSI output. Uses spawn pipes — no shell — so the tool name is safe
 * even though we already validate it in getDiffTool().
 */
function runPipedDiff(
	cwd: string,
	gitArgs: string[],
	tool: string,
	themeMode: ThemeMode,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const git = spawn("git", ["-C", cwd, ...gitArgs], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		// Delta's syntax theme defaults are tuned for dark backgrounds — pale
		// Monokai foreground on a light terminal becomes invisible. Force the
		// theme flag matching santree's detected mode so colors stay readable.
		const pagerArgs = tool === "delta" ? [themeMode === "light" ? "--light" : "--dark"] : [];
		// Disable hyperlinks for delta: OSC 8 sequences (`\x1b]8;...`) are not
		// handled by truncateVisible() — its CSI-only regex counts the URL
		// bytes as visible characters, mangling line truncation and breaking
		// terminal rendering of the wrapped text. Delta's CLI rejects an
		// inline `--hyperlinks=false`, so override via GIT_CONFIG_PARAMETERS
		// (delta reads its config from git). Also drop line-numbers — they
		// eat ~6 cols of an already-narrow right pane.
		const pagerEnv =
			tool === "delta"
				? {
						...process.env,
						GIT_CONFIG_PARAMETERS: "'delta.hyperlinks=false' 'delta.line-numbers=false'",
					}
				: process.env;
		// We use the pager only for its rendering — the dashboard owns
		// scrolling/search itself in Ink, so we capture stdout as a string.
		const pager = spawn(tool, pagerArgs, {
			stdio: ["pipe", "pipe", "pipe"],
			env: pagerEnv,
		});
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
				resolve(splitCombinedSgr(out));
			}
		});
	});
}

/**
 * Pipe an in-memory unified diff string through the configured pager. Used by
 * the reviews-tab PR diff path, which already has per-file content from
 * `gh pr diff` parsed into a map — no `git diff` to spawn here.
 */
function runPagerOnString(input: string, tool: string, themeMode: ThemeMode): Promise<string> {
	return new Promise((resolve, reject) => {
		const pagerArgs = tool === "delta" ? [themeMode === "light" ? "--light" : "--dark"] : [];
		const pagerEnv =
			tool === "delta"
				? {
						...process.env,
						GIT_CONFIG_PARAMETERS: "'delta.hyperlinks=false' 'delta.line-numbers=false'",
					}
				: process.env;
		const pager = spawn(tool, pagerArgs, {
			stdio: ["pipe", "pipe", "pipe"],
			env: pagerEnv,
		});
		let out = "";
		let err = "";
		pager.stdout.on("data", (d) => {
			out += d.toString();
		});
		pager.stderr.on("data", (d) => {
			err += d.toString();
		});
		pager.on("error", reject);
		pager.on("close", (code) => {
			if (code !== 0 && !out) {
				reject(new Error(err || `${tool} exited with code ${code}`));
			} else {
				resolve(splitCombinedSgr(out));
			}
		});
		pager.stdin.write(input);
		pager.stdin.end();
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
				<Key k="␣" />
				<Text dimColor> stage</Text>
				{dot}
				<Key k="a" />
				<Text dimColor> all</Text>
				{dot}
				<Key k="d" />
				<Text dimColor> discard</Text>
				{dot}
				<Key k="e" />
				<Text dimColor> edit</Text>
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
			<Key k="?" />
			<Text dimColor> help</Text>
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

		// No tracker configured → show the selection flow instead of letting
		// getIssueTracker silently fall back to GitHub and then fail auth on
		// the dead-end error screen. Genuine auth/network failures of a
		// *configured* tracker still hit the catch → error screen below.
		if (!isRepoTrackerConfigured(repoRoot)) {
			dispatch({ type: "TRACKER_SELECT_OPEN" });
			return;
		}

		try {
			// Re-detect terminal theme alongside data fetch so light↔dark
			// switches propagate within one refresh cycle (≤5min, or sooner
			// on a manual `R`). Skip the
			// OSC 11 query when a text-input overlay is active — the
			// terminal's response would otherwise leak into the user's
			// commit/PR/context message via Ink's stdin handler.
			const overlay = stateRef.current.overlay;
			const inTextInput =
				overlay === "context-input" ||
				(overlay === "pr-create" && stateRef.current.prCreatePhase === "review") ||
				(overlay === "commit" && stateRef.current.commitPhase === "awaiting-message");
			const themeP = inTextInput ? Promise.resolve<null>(null) : detectTerminalTheme();
			const [data, reviewData, themeMode] = await Promise.all([
				loadDashboardData(repoRoot),
				loadReviewsData(repoRoot),
				themeP,
			]);
			if (themeMode !== null) setTheme(getThemeForMode(themeMode));
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

				{
					const isTreesTab = s.activeTab === "trees";
					const flat = isTreesTab ? s.flatTrees : s.flatIssues;
					const idx = isTreesTab ? s.treeSelectedIndex : s.selectedIndex;
					const detailOff = isTreesTab ? s.treeDetailScrollOffset : s.detailScrollOffset;
					if (inLeftPane) {
						const maxIdx = flat.length - 1;
						if (maxIdx < 0) return;
						const next = Math.max(0, Math.min(idx + delta, maxIdx));
						dispatch({ type: isTreesTab ? "TREE_SELECT" : "SELECT", index: next });
					} else {
						const next = Math.max(0, detailOff + delta);
						dispatch({ type: isTreesTab ? "TREE_SCROLL_DETAIL" : "SCROLL_DETAIL", offset: next });
					}
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

			{
				const isTreesTab = s.activeTab === "trees";
				const flat = isTreesTab ? s.flatTrees : s.flatIssues;
				const grps = isTreesTab ? s.treeGroups : s.groups;
				const scrollOff = isTreesTab ? s.treeListScrollOffset : s.listScrollOffset;
				if (flat.length === 0) return;
				const listRow = scrollOff + contentRow;
				const flatIdx = getFlatIndexForListRow(grps, flat, listRow);
				if (flatIdx !== null && flatIdx >= 0 && flatIdx < flat.length) {
					dispatch({ type: isTreesTab ? "TREE_SELECT" : "SELECT", index: flatIdx });
				}
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

		// Auto-refresh every 5 minutes. Each refresh fans out into several
		// `gh pr view`/`gh pr checks` calls per worktree-PR plus the reviews
		// tab, all on the GraphQL API (5000-point/hour budget) — a 30s cadence
		// drained it within the hour when the dashboard was left open. Press
		// `R` for an on-demand refresh between cycles. While the diff overlay
		// is open, also bump the diff refresh tick so new/removed files
		// (created or deleted outside the dashboard) eventually show up.
		// Stage/unstage already patch XY in place, so this is purely about
		// file-set drift.
		refreshTimerRef.current = setInterval(() => {
			refresh();
			if (stateRef.current.overlay === "diff") {
				dispatch({ type: "DIFF_REFRESH_FILES" });
			}
		}, 300_000);

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

	// ── Trees list scroll tracking ───────────────────────────────────

	useEffect(() => {
		const rowIdx = getRowIndexForFlatIndex(
			state.treeGroups,
			state.flatTrees,
			state.treeSelectedIndex,
		);
		const maxVisible = contentHeight - LIST_FOOTER_HEIGHT;
		let offset = state.treeListScrollOffset;

		if (rowIdx < offset) {
			offset = Math.max(0, rowIdx - 1);
		} else if (rowIdx >= offset + maxVisible) {
			offset = rowIdx - maxVisible + 2;
		}

		if (offset !== state.treeListScrollOffset) {
			dispatch({ type: "TREE_SCROLL_LIST", offset });
		}
	}, [state.treeSelectedIndex, state.treeGroups, contentHeight, state.treeListScrollOffset]);

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
	// With SGR mouse tracking on, every click emits `\x1b[<btn;col;rowM` —
	// these escape sequences leak into text inputs as garbage characters
	// (and into MultilineTextArea, the leading ESC fires key.escape).
	// Disable tracking while any text-input overlay is mounted; restore on exit.
	useEffect(() => {
		const needsMouseOff =
			state.overlay === "context-input" ||
			(state.overlay === "issue-form" && state.issueFormPhase !== "saving") ||
			(state.overlay === "pr-create" && state.prCreatePhase === "review") ||
			(state.overlay === "commit" && state.commitPhase === "awaiting-message");
		if (!needsMouseOff) return;
		process.stdout.write("\x1b[?1002l\x1b[?1006l");
		return () => {
			process.stdout.write("\x1b[?1002h\x1b[?1006h");
		};
	}, [state.overlay, state.issueFormPhase, state.prCreatePhase, state.commitPhase]);

	// ── Diff overlay: load file list when opened (gh pr diff path) ────
	// Reviews-tab PRs without a local worktree shell out to `gh pr diff <n>`,
	// parse the unified blob into per-file records, and stash the per-file
	// content for the content-loader effect below to read synchronously.
	useEffect(() => {
		if (state.overlay !== "diff" || state.diffPRNumber == null) return;
		const prNumber = state.diffPRNumber;
		void (async () => {
			try {
				const { stdout } = await execAsync(`gh pr diff ${prNumber}`, {
					maxBuffer: 32 * 1024 * 1024,
				});
				const { files, contentByPath } = parseUnifiedDiff(stdout);
				const ordered = flattenTreeFiles(files);
				dispatch({ type: "DIFF_PR_LOADED", files: ordered, contentByPath });
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				dispatch({ type: "DIFF_FILES_ERROR", error: msg });
			}
		})();
	}, [state.overlay, state.diffPRNumber]);

	// ── Diff overlay: load file list when opened ──────────────────────
	// Resolves merge-base against the configured base branch so upstream-only
	// changes (commits on master we haven't pulled) are excluded — same semantics
	// as a GitHub PR diff.
	useEffect(() => {
		if (state.overlay !== "diff" || !state.diffWorktreePath || !state.diffBaseBranch) return;
		const cwd = state.diffWorktreePath;
		const base = state.diffBaseBranch;
		void (async () => {
			try {
				const { stdout: mergeBaseOut } = await execAsync(
					`git -C "${cwd}" merge-base "${base}" HEAD`,
				);
				const mergeBase = mergeBaseOut.trim() || base;
				const [{ stdout }, porcelain] = await Promise.all([
					execAsync(`git -C "${cwd}" diff --name-status "${mergeBase}"`),
					getWorktreeStatus(cwd).catch(() => []),
				]);
				const files = parseNameStatus(stdout);
				// Merge porcelain (working-tree state) into the merge-base file list.
				// XY status drives stage/unstage UX; untracked files (`??`) only show
				// up here since `git diff` ignores them.
				const porcelainByPath = new Map<string, (typeof porcelain)[number]>();
				for (const p of porcelain) porcelainByPath.set(p.path, p);
				const enriched: DiffFile[] = files.map((f) => {
					const p = porcelainByPath.get(f.path);
					if (!p) return f;
					porcelainByPath.delete(f.path);
					return {
						...f,
						indexStatus: p.index,
						workingStatus: p.working,
						isUntracked: p.index === "?" && p.working === "?",
					};
				});
				// Untracked entries left over → add as new DiffFile rows so they
				// appear in the tree and can be staged.
				for (const p of porcelainByPath.values()) {
					if (p.index === "?" && p.working === "?") {
						enriched.push({
							path: p.path,
							status: "?",
							indexStatus: p.index,
							workingStatus: p.working,
							isUntracked: true,
						});
					}
				}
				const ordered = flattenTreeFiles(enriched);
				dispatch({ type: "DIFF_FILES_LOADED", files: ordered, mergeBase });
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				dispatch({ type: "DIFF_FILES_ERROR", error: msg });
			}
		})();
	}, [state.overlay, state.diffWorktreePath, state.diffBaseBranch, state.diffRefreshTick]);

	// ── Diff overlay: select content for current file (gh pr diff path) ─
	// Per-file slices were parsed up front by the file-list effect above —
	// just pull the right entry out of the map. When SANTREE_DIFF_TOOL is set,
	// pipe the slice through the pager so reviews-tab diffs get the same
	// syntax highlighting as worktree diffs.
	useEffect(() => {
		if (state.overlay !== "diff" || state.diffPRNumber == null) return;
		const file = state.diffFiles[state.diffFileIndex];
		if (!file) {
			dispatch({ type: "DIFF_CONTENT_LOADED", content: "" });
			return;
		}
		const raw = state.diffPRContentByPath[file.path] ?? "";
		const tool = getDiffTool();
		if (!tool || !raw) {
			dispatch({ type: "DIFF_CONTENT_LOADED", content: raw });
			return;
		}
		dispatch({ type: "DIFF_CONTENT_LOADING" });
		void (async () => {
			try {
				const content = await runPagerOnString(raw, tool, theme.mode);
				dispatch({ type: "DIFF_CONTENT_LOADED", content });
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				dispatch({ type: "DIFF_CONTENT_LOADED", content: `Error rendering diff: ${msg}` });
			}
		})();
	}, [
		state.overlay,
		state.diffPRNumber,
		state.diffFileIndex,
		state.diffFiles,
		state.diffPRContentByPath,
		theme.mode,
	]);

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
				if (file.isUntracked) {
					// Untracked files aren't in `git diff` output — fake a "full
					// addition" diff via --no-index against /dev/null. git exits 1
					// when files differ; that's expected, so we capture stdout
					// regardless. Pipe through the configured tool when set so
					// untracked files get the same syntax highlighting as tracked
					// ones; otherwise fall back to spawnAsync + manual colorize.
					if (tool) {
						const content = await runPipedDiff(
							cwd,
							["diff", "--color=always", "--no-index", "--", "/dev/null", file.path],
							tool,
							theme.mode,
						);
						dispatch({ type: "DIFF_CONTENT_LOADED", content });
					} else {
						const { output } = await spawnAsync(
							"git",
							["-C", cwd, "diff", "--no-color", "--no-index", "--", "/dev/null", file.path],
							{ cwd },
						);
						dispatch({ type: "DIFF_CONTENT_LOADED", content: output });
					}
				} else if (tool) {
					// Pipe git diff (with colors enabled so the tool can pass them
					// through if desired) into the configured tool. Use spawn pipes
					// rather than shell to avoid quoting concerns.
					const content = await runPipedDiff(
						cwd,
						["diff", "--color=always", mergeBase, "--", file.path],
						tool,
						theme.mode,
					);
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
		theme.mode,
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
			// `claude --resume` is cwd-scoped — it only finds the session under
			// the encoded path of the current cwd. Project conventions (direnv,
			// shell init) sometimes leave the tmux window in a subdir, so we
			// prepend `cd <sessionCwd>` (resolved by `findClaudeSessionCwd`)
			// to guarantee the resume runs from where the session was created.
			const sessionCwd = di.worktree?.sessionCwd ?? di.worktree?.path;
			const resumeCmd =
				sessionId && bin && sessionCwd
					? `cd ${shellEscape(sessionCwd)} && ${bin} --resume ${sessionId}`
					: null;
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
							: `Launched ${mode} in new window: ${windowName}`,
					});
				} else {
					dispatch({
						type: "SET_ACTION_MESSAGE",
						message: `Failed to create window${created.message ? `: ${created.message}` : ""}`,
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
						message: `Worktree created, but window launch failed${created.message ? `: ${created.message}` : ""}`,
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
			const sref = stateRef.current;
			const di =
				sref.activeTab === "trees"
					? sref.flatTrees[sref.treeSelectedIndex]
					: sref.flatIssues[sref.selectedIndex];
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
			const di =
				state.activeTab === "trees"
					? state.flatTrees[state.treeSelectedIndex]
					: state.flatIssues[state.selectedIndex];
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
				// Worktree branches live on the Trees tab now; scan there for
				// candidate base branches (stacked work).
				for (const fi of [...state.flatTrees, ...state.flatIssues]) {
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
			state.flatTrees,
			state.treeSelectedIndex,
			state.activeTab,
			exit,
			launchWorkInTmux,
			proceedAfterBaseSelect,
			writeContextFile,
		],
	);

	// ── Tracker selection ────────────────────────────────────────────
	// Mirrors `santree issue setup`. Local needs no account; Linear picks an
	// authenticated workspace (sub-list when >1); GitHub verifies `gh`.
	const chooseTracker = useCallback(
		async (kind: "local" | "linear" | "github") => {
			const root = repoRootRef.current ?? findMainRepoRoot();
			if (!root) {
				dispatch({ type: "SET_ERROR", error: "Not inside a git repository" });
				return;
			}
			repoRootRef.current = root;
			if (kind === "local") {
				setRepoTracker(root, "local");
				dispatch({ type: "TRACKER_SELECT_CLOSE" });
				refresh();
				return;
			}
			if (kind === "linear") {
				const store = readLinearAuthStore();
				const orgs = Object.entries(store).map(([slug, tokens]) => ({
					slug,
					name: tokens.org_name,
				}));
				if (orgs.length === 0) {
					dispatch({
						type: "TRACKER_SELECT_MESSAGE",
						message: "No authenticated Linear workspaces. Run: santree linear auth",
					});
					return;
				}
				if (orgs.length === 1) {
					setRepoLinearOrg(root, orgs[0]!.slug);
					setRepoTracker(root, "linear");
					dispatch({ type: "TRACKER_SELECT_CLOSE" });
					refresh();
					return;
				}
				dispatch({ type: "TRACKER_SELECT_PHASE", phase: "linear-org", orgs });
				return;
			}
			// github
			const user = await getAuthenticatedUser();
			if (!user) {
				dispatch({
					type: "TRACKER_SELECT_MESSAGE",
					message: "GitHub CLI not authenticated. Run: santree github auth",
				});
				return;
			}
			setRepoTracker(root, "github");
			await getCurrentRepoNwo(root);
			dispatch({ type: "TRACKER_SELECT_CLOSE" });
			refresh();
		},
		[refresh],
	);

	const chooseLinearOrg = useCallback(
		(slug: string) => {
			const root = repoRootRef.current ?? findMainRepoRoot();
			if (!root) return;
			setRepoLinearOrg(root, slug);
			setRepoTracker(root, "linear");
			dispatch({ type: "TRACKER_SELECT_CLOSE" });
			refresh();
		},
		[refresh],
	);

	// ── Issue CRUD (built-in tracker only) ───────────────────────────
	const submitIssueForm = useCallback(async () => {
		const s = stateRef.current;
		const root = repoRootRef.current;
		if (!root) return;
		const tracker = getIssueTracker(root);
		const title = s.issueFormTitle.split("\n")[0]?.trim() ?? "";
		if (!title) {
			dispatch({ type: "ISSUE_FORM_ERROR", error: "Title is required" });
			return;
		}
		const description = s.issueFormDescription;
		dispatch({ type: "ISSUE_FORM_PHASE", phase: "saving" });
		try {
			if (s.issueFormMode === "edit" && s.issueFormId && tracker.updateIssue) {
				const res = await tracker.updateIssue(s.issueFormId, { title, description }, root);
				if (!res.ok) {
					dispatch({ type: "ISSUE_FORM_ERROR", error: res.message ?? "Update failed" });
					return;
				}
			} else if (tracker.createIssue) {
				const res = await tracker.createIssue({ title, description }, root);
				if (!res.ok) {
					dispatch({ type: "ISSUE_FORM_ERROR", error: res.message ?? "Create failed" });
					return;
				}
			} else {
				dispatch({ type: "ISSUE_FORM_ERROR", error: "Tracker does not support editing" });
				return;
			}
			dispatch({ type: "ISSUE_FORM_CLOSE" });
			dispatch({
				type: "SET_ACTION_MESSAGE",
				message: s.issueFormMode === "edit" ? "Issue updated" : "Issue created",
			});
			refresh();
		} catch (e) {
			dispatch({
				type: "ISSUE_FORM_ERROR",
				error: e instanceof Error ? e.message : "Failed to save issue",
			});
		}
	}, [refresh]);

	const deleteSelectedIssue = useCallback(async () => {
		const s = stateRef.current;
		const root = repoRootRef.current;
		if (!root) return;
		const di = s.flatIssues[s.selectedIndex];
		if (!di) return;
		const tracker = getIssueTracker(root);
		dispatch({ type: "ISSUE_DELETE_CLOSE" });
		if (!tracker.deleteIssue) return;
		try {
			const res = await tracker.deleteIssue(di.issue.identifier, root);
			dispatch({
				type: "SET_ACTION_MESSAGE",
				message: res.ok
					? `Deleted ${di.issue.identifier}`
					: `Failed: ${res.message ?? "delete failed"}`,
			});
			if (res.ok) refresh();
		} catch (e) {
			dispatch({
				type: "SET_ACTION_MESSAGE",
				message: e instanceof Error ? e.message : "Delete failed",
			});
		}
	}, [refresh]);

	// ── Commit flow ──────────────────────────────────────────────────

	const handleStageAll = useCallback(async () => {
		const wtPath = stateRef.current.commitWorktreePath;
		if (!wtPath) return;
		try {
			await execAsync("git add -A", { cwd: wtPath });
			// After staging, ask whether to draft with AI or write manually.
			dispatch({ type: "COMMIT_PHASE", phase: "choose-mode" });
		} catch (e: any) {
			dispatch({
				type: "COMMIT_ERROR",
				error: e?.stderr?.trim() || e?.message || "Failed to stage",
			});
		}
	}, []);

	const handleFillCommit = useCallback(async () => {
		const s = stateRef.current;
		const wtPath = s.commitWorktreePath;
		const branch = s.commitBranch;
		const ticketId = s.commitTicketId;
		if (!wtPath || !branch) return;

		dispatch({ type: "COMMIT_PHASE", phase: "filling" });

		const diffContent = getStagedDiffContent(wtPath);
		const fallbackPrefix = ticketId ? `[${ticketId}] ` : "";
		if (!diffContent.trim()) {
			dispatch({ type: "COMMIT_MESSAGE", message: fallbackPrefix });
			dispatch({ type: "COMMIT_PHASE", phase: "awaiting-message" });
			return;
		}

		// Pull ticket context so the AI message is grounded in the requested
		// change rather than just the literal diff.
		let ticketContent: string | undefined;
		const mainRoot = repoRootRef.current;
		if (ticketId && mainRoot) {
			try {
				const tracker = getIssueTracker(mainRoot);
				const result = await tracker.getIssue(ticketId, mainRoot);
				if (result.ok) {
					ticketContent = renderTicket(result.value, tracker.displayName);
				}
			} catch {
				// non-fatal — the prompt works with diff alone
			}
		}

		const drafted = await fillCommitMessage({
			branch,
			ticketId,
			ticketContent,
			diffContent,
		});

		dispatch({ type: "COMMIT_MESSAGE", message: drafted ?? fallbackPrefix });
		dispatch({ type: "COMMIT_PHASE", phase: "awaiting-message" });
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
			// Auto-prefix with `[TICKET]` only when there's a real ticket
			// AND the user hasn't already typed it.
			const tid = s.commitTicketId;
			const msg = tid && !trimmed.includes(`[${tid}]`) ? `[${tid}] ${trimmed}` : trimmed;

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

				// Fetch issue content from the active tracker (downloads images
				// inline so Claude can read them via --allowedTools Read).
				let ticketContent: string | undefined;
				if (ticketId && mainRepoRoot) {
					const tracker = getIssueTracker(mainRepoRoot);
					const result = await tracker.getIssue(ticketId, mainRepoRoot);
					if (result.ok) {
						ticketContent = renderTicket(result.value, tracker.displayName);
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

			const draftFlag = s.prCreateDraft ? " --draft" : "";
			const { stdout } = await execAsync(
				`gh pr create --title "${s.prCreateTitle.replace(/"/g, '\\"')}" --base "${base}" --head "${s.prCreateBranch}" --body-file "${bodyFile}"${draftFlag}`,
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

		// Carry the edited title/body into GitHub's compose page so the browser
		// opens pre-filled (gh passes them as URL query params). Without this,
		// the fill→"open in browser" path would drop everything the user just
		// reviewed. Note: very long bodies can be truncated by GitHub's URL
		// length limit — gh's documented `--web` behavior; the editable compose
		// page is the fallback. Draft selection lives in the browser dropdown,
		// since `gh --web` doesn't accept `--draft`.
		let bodyFile: string | null = null;
		try {
			let cmd = `gh pr create --web --base "${base}" --head "${s.prCreateBranch}"`;
			if (s.prCreateTitle) {
				cmd += ` --title "${s.prCreateTitle.replace(/"/g, '\\"')}"`;
			}
			if (s.prCreateBody) {
				bodyFile = path.join(os.tmpdir(), `santree-pr-${Date.now()}.md`);
				fs.writeFileSync(bodyFile, s.prCreateBody);
				cmd += ` --body-file "${bodyFile}"`;
			}
			await execAsync(cmd, { cwd });
			dispatch({ type: "PR_CREATE_DONE", url: "" });
			setTimeout(() => {
				dispatch({ type: "PR_CREATE_CANCEL" });
				refresh();
			}, 2500);
		} catch (e: any) {
			const msg = e?.stderr?.trim() || e?.message || "Failed to open in browser";
			dispatch({ type: "PR_CREATE_ERROR", error: msg });
		} finally {
			if (bodyFile) {
				try {
					fs.unlinkSync(bodyFile);
				} catch {}
			}
		}
	}, [refresh]);

	// ── Keyboard ──────────────────────────────────────────────────────

	useInput(
		(input, key) => {
			// Clear action messages on any keypress
			if (state.actionMessage && input !== "q") {
				dispatch({ type: "SET_ACTION_MESSAGE", message: null });
			}

			// Help overlay — toggleable from anywhere except text-input
			// overlays. ? opens, ? again or Esc closes.
			if (state.overlay === "help") {
				if (input === "?" || key.escape) {
					dispatch({ type: "SET_OVERLAY", overlay: null });
				}
				return;
			}
			if (input === "?" && state.overlay === null) {
				dispatch({ type: "SET_OVERLAY", overlay: "help" });
				return;
			}

			// Commit overlay
			if (state.overlay === "commit") {
				// awaiting-message is owned by MultilineTextArea (Ctrl+D submit,
				// Ctrl+G cancel) — escape there is handled inside the component,
				// so we don't intercept any keys at this phase.
				if (state.commitPhase === "awaiting-message") return;

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
				if (state.commitPhase === "choose-mode") {
					if (input === "f") {
						handleFillCommit();
						return;
					}
					if (input === "m") {
						const tid = state.commitTicketId;
						dispatch({ type: "COMMIT_MESSAGE", message: tid ? `[${tid}] ` : "" });
						dispatch({ type: "COMMIT_PHASE", phase: "awaiting-message" });
						return;
					}
					return;
				}
				// committing / pushing / done / error: swallow
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
					if (input === "d") {
						dispatch({ type: "PR_CREATE_TOGGLE_DRAFT" });
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

			// Context-input overlay: MultilineTextArea owns useInput (outer is
			// disabled via isActive below). Submit launches directly; cancel
			// closes the overlay.
			if (state.overlay === "context-input") {
				return;
			}

			// Diff overlay
			if (state.overlay === "diff") {
				// Pending discard modal — intercepts y/n/ESC/q so they don't
				// also close the diff overlay.
				if (state.diffPendingDiscard) {
					const pd = state.diffPendingDiscard;
					if (input === "y") {
						const cwd = state.diffWorktreePath;
						if (!cwd) {
							dispatch({ type: "DIFF_DISCARD_CANCEL" });
							return;
						}
						(async () => {
							try {
								await discardFile(cwd, pd.path, pd.isUntracked);
								dispatch({ type: "DIFF_DISCARD_CANCEL" });
								dispatch({ type: "DIFF_REFRESH_FILES" });
								dispatch({
									type: "SET_ACTION_MESSAGE",
									message: pd.isUntracked
										? `Deleted ${pd.path}`
										: `Discarded changes in ${pd.path}`,
								});
							} catch (err: unknown) {
								const msg = err instanceof Error ? err.message : String(err);
								dispatch({ type: "DIFF_DISCARD_CANCEL" });
								dispatch({ type: "SET_ACTION_MESSAGE", message: `Discard failed: ${msg}` });
							}
						})();
						return;
					}
					if (input === "n" || key.escape || input === "q") {
						dispatch({ type: "DIFF_DISCARD_CANCEL" });
						return;
					}
					return;
				}

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

				// Stage / unstage / discard — only meaningful when the worktree
				// path is known. All ops dispatch DIFF_REFRESH_FILES so the
				// porcelain status (and selection) updates immediately.
				const cwd = state.diffWorktreePath;
				const currentFile = state.diffFiles[state.diffFileIndex];
				if (input === " " && cwd && currentFile) {
					// Toggle: if anything is staged for this file, unstage it;
					// otherwise stage. Files with no uncommitted state (only
					// committed changes vs base) have no XY → no-op. Updates XY
					// in place via porcelain re-fetch — no full reload, no spinner.
					const xRaw = currentFile.indexStatus;
					const yRaw = currentFile.workingStatus;
					if (xRaw === undefined && yRaw === undefined) {
						dispatch({
							type: "SET_ACTION_MESSAGE",
							message: "No uncommitted changes to stage on this file",
						});
						return;
					}
					const x = xRaw ?? " ";
					const isStaged = x !== " " && x !== "?";
					const path = currentFile.path;
					(async () => {
						try {
							if (isStaged) await unstageFile(cwd, path);
							else await stageFile(cwd, path);
							const porcelain = await getWorktreeStatus(cwd);
							dispatch({ type: "DIFF_STATUS_UPDATED", porcelain });
						} catch (err: unknown) {
							const msg = err instanceof Error ? err.message : String(err);
							dispatch({
								type: "SET_ACTION_MESSAGE",
								message: `${isStaged ? "Unstage" : "Stage"} failed: ${msg}`,
							});
						}
					})();
					return;
				}
				if (input === "a" && cwd) {
					// Stage-all if anything is unstaged or untracked; otherwise
					// unstage everything. Untracked files have Y === "?" so they
					// fall under "unstaged" — staging them adds them to the index.
					// Same in-place porcelain refresh as `space`.
					const anyUnstaged = state.diffFiles.some((f) => {
						const y = f.workingStatus;
						return y !== undefined && y !== " ";
					});
					(async () => {
						try {
							if (anyUnstaged) await stageAll(cwd);
							else await unstageAll(cwd);
							const porcelain = await getWorktreeStatus(cwd);
							dispatch({ type: "DIFF_STATUS_UPDATED", porcelain });
							dispatch({
								type: "SET_ACTION_MESSAGE",
								message: anyUnstaged ? "Staged all changes" : "Unstaged all changes",
							});
						} catch (err: unknown) {
							const msg = err instanceof Error ? err.message : String(err);
							dispatch({ type: "SET_ACTION_MESSAGE", message: `Failed: ${msg}` });
						}
					})();
					return;
				}
				if (input === "d" && currentFile) {
					if (currentFile.indexStatus === undefined && currentFile.workingStatus === undefined) {
						dispatch({
							type: "SET_ACTION_MESSAGE",
							message: "No uncommitted changes to discard",
						});
						return;
					}
					dispatch({
						type: "DIFF_DISCARD_OPEN",
						path: currentFile.path,
						isUntracked: !!currentFile.isUntracked,
					});
					return;
				}
				// Open the selected file in the user's editor — useful when
				// the diff alone isn't enough context. Editor resolution
				// matches the rest of santree (SANTREE_EDITOR > "code").
				if (input === "e" && cwd && currentFile) {
					openInEditor(path.join(cwd, currentFile.path));
					return;
				}
				return;
			}

			// Confirm delete overlay
			if (state.overlay === "confirm-delete") {
				if (input === "y") {
					dispatch({ type: "SET_OVERLAY", overlay: null });
					// Worktree removal is a Trees-tab action.
					const di = state.flatTrees[state.treeSelectedIndex];
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

			// Tracker-selection overlay (shown when no tracker is configured,
			// or reopened with `t`). Not a text input — outer useInput drives it.
			if (state.overlay === "tracker-select") {
				if (state.trackerSelectPhase === "linear-org") {
					const orgs = state.trackerSelectOrgs;
					if (input === "j" || key.downArrow) {
						dispatch({
							type: "TRACKER_SELECT_MOVE",
							index: Math.min(state.trackerSelectIndex + 1, orgs.length - 1),
						});
						return;
					}
					if (input === "k" || key.upArrow) {
						dispatch({
							type: "TRACKER_SELECT_MOVE",
							index: Math.max(state.trackerSelectIndex - 1, 0),
						});
						return;
					}
					if (key.return) {
						const org = orgs[state.trackerSelectIndex];
						if (org) chooseLinearOrg(org.slug);
						return;
					}
					if (key.escape) {
						dispatch({ type: "TRACKER_SELECT_PHASE", phase: "root" });
						return;
					}
					return;
				}
				const TRACKER_KINDS = ["local", "linear", "github"] as const;
				if (input === "j" || key.downArrow) {
					dispatch({
						type: "TRACKER_SELECT_MOVE",
						index: Math.min(state.trackerSelectIndex + 1, TRACKER_KINDS.length - 1),
					});
					return;
				}
				if (input === "k" || key.upArrow) {
					dispatch({
						type: "TRACKER_SELECT_MOVE",
						index: Math.max(state.trackerSelectIndex - 1, 0),
					});
					return;
				}
				if (key.return) {
					void chooseTracker(TRACKER_KINDS[state.trackerSelectIndex] ?? "local");
					return;
				}
				if (input === "q" || key.escape) {
					// Can't proceed without a tracker — leave the dashboard.
					exit();
					return;
				}
				return;
			}

			// Confirm-delete-issue overlay (built-in tracker only)
			if (state.overlay === "confirm-delete-issue") {
				if (input === "y") {
					void deleteSelectedIssue();
					return;
				}
				if (input === "n" || key.escape || input === "q") {
					dispatch({ type: "ISSUE_DELETE_CLOSE" });
					return;
				}
				return;
			}

			// Issue create/edit form. Title/description phases are owned by
			// MultilineTextArea (outer useInput disabled via isActive); only
			// the "saving" phase reaches here — swallow all keys.
			if (state.overlay === "issue-form") {
				return;
			}

			// Tab switching (only when no overlay is active)
			const TAB_ORDER: Array<typeof state.activeTab> = ["issues", "trees", "reviews"];
			if (key.tab) {
				const idx = TAB_ORDER.indexOf(state.activeTab);
				dispatch({ type: "SET_TAB", tab: TAB_ORDER[(idx + 1) % TAB_ORDER.length]! });
				return;
			}
			if (input === "1") {
				dispatch({ type: "SET_TAB", tab: "issues" });
				return;
			}
			if (input === "2") {
				dispatch({ type: "SET_TAB", tab: "trees" });
				return;
			}
			if (input === "3") {
				dispatch({ type: "SET_TAB", tab: "reviews" });
				return;
			}
			// Reopen tracker selection from any tab.
			if (input === "t") {
				dispatch({ type: "TRACKER_SELECT_OPEN" });
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

				// Open linked ticket in browser (only when one is associated).
				// Aligns with the issues tab: `[o]` always opens the ticket; `[p]`
				// opens the PR. The previous behavior — `[o]` opens the PR — is
				// the only intentional muscle-memory break in this redesign.
				if (input === "o") {
					if (!ri.ticket?.url) {
						dispatch({ type: "SET_ACTION_MESSAGE", message: "No linked ticket" });
						return;
					}
					if (openUrl(ri.ticket.url)) {
						dispatch({ type: "SET_ACTION_MESSAGE", message: "Opened ticket in browser" });
					}
					return;
				}

				// Open PR in browser
				if (input === "p") {
					if (!ri.pr.url) return;
					if (openUrl(ri.pr.url)) {
						dispatch({ type: "SET_ACTION_MESSAGE", message: "Opened PR in browser" });
					}
					return;
				}

				// View diff (inline overlay).
				//   - With a local worktree: reuse the issues-tab path (git diff
				//     against merge-base, full XY/staging support).
				//   - Without a worktree: parse `gh pr diff <n>` once, render the
				//     same DiffOverlay in read-only mode.
				if (input === "v") {
					const ticketLabel = ri.ticket?.identifier ?? `#${ri.pr.number}`;
					if (ri.worktree) {
						const baseBranch = getBaseBranch(ri.worktree.branch);
						dispatch({
							type: "DIFF_OPEN",
							ticketId: ticketLabel,
							worktreePath: ri.worktree.path,
							baseBranch,
						});
					} else {
						dispatch({
							type: "DIFF_OPEN_PR",
							label: ticketLabel,
							prNumber: ri.pr.number,
							baseBranch: ri.baseBranch ?? "main",
						});
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
									? "Launched AI review in new window"
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

			// Issues tab = backlog/planning; Trees tab = worktrees in
			// progress. Both reuse the same list/detail UI and worktree action
			// handlers below — only the backing data + selection slice differ.
			const isTrees = state.activeTab === "trees";
			const viewFlat = isTrees ? state.flatTrees : state.flatIssues;
			const viewIndex = isTrees ? state.treeSelectedIndex : state.selectedIndex;
			const viewDetailScroll = isTrees ? state.treeDetailScrollOffset : state.detailScrollOffset;
			const selectAction = isTrees ? ("TREE_SELECT" as const) : ("SELECT" as const);
			const scrollDetailAction = isTrees
				? ("TREE_SCROLL_DETAIL" as const)
				: ("SCROLL_DETAIL" as const);
			const maxIndex = viewFlat.length - 1;

			// Navigation
			if (input === "j" || (key.downArrow && !key.shift)) {
				dispatch({ type: selectAction, index: Math.min(viewIndex + 1, maxIndex) });
				return;
			}
			if (input === "k" || (key.upArrow && !key.shift)) {
				dispatch({ type: selectAction, index: Math.max(viewIndex - 1, 0) });
				return;
			}

			// Detail scroll
			if (key.shift && key.downArrow) {
				dispatch({ type: scrollDetailAction, offset: viewDetailScroll + 3 });
				return;
			}
			if (key.shift && key.upArrow) {
				dispatch({ type: scrollDetailAction, offset: Math.max(0, viewDetailScroll - 3) });
				return;
			}

			const di = viewFlat[viewIndex];
			if (!di) return;

			// ── Issues tab: backlog actions only (no worktree ops) ──────
			if (!isTrees) {
				const tracker = getIssueTracker(repoRootRef.current);
				const canMutate = tracker.canMutate === true;
				if (input === "w") {
					if (di.worktree?.sessionId) {
						dispatch({
							type: "SET_ACTION_MESSAGE",
							message: "Session active — switch to the Trees tab to resume.",
						});
						return;
					}
					dispatch({ type: "SET_OVERLAY", overlay: "mode-select" });
					return;
				}
				if (input === "n") {
					if (!canMutate) {
						dispatch({
							type: "SET_ACTION_MESSAGE",
							message: `${tracker.displayName} issues can't be created from santree`,
						});
						return;
					}
					dispatch({
						type: "ISSUE_FORM_OPEN",
						mode: "create",
						id: null,
						title: "",
						description: "",
					});
					return;
				}
				if (input === "e") {
					if (!canMutate) {
						dispatch({
							type: "SET_ACTION_MESSAGE",
							message: `${tracker.displayName} issues can't be edited from santree`,
						});
						return;
					}
					dispatch({
						type: "ISSUE_FORM_OPEN",
						mode: "edit",
						id: di.issue.identifier,
						title: di.issue.title,
						description: di.issue.description ?? "",
					});
					return;
				}
				if (input === "d") {
					if (!canMutate) {
						dispatch({ type: "SET_ACTION_MESSAGE", message: "Nothing to delete here" });
						return;
					}
					dispatch({ type: "ISSUE_DELETE_OPEN" });
					return;
				}
				if (input === "o") {
					if (!di.issue.url) {
						dispatch({ type: "SET_ACTION_MESSAGE", message: "No issue URL available" });
						return;
					}
					if (openUrl(di.issue.url)) {
						dispatch({ type: "SET_ACTION_MESSAGE", message: "Opened in browser" });
					}
					return;
				}
				return; // backlog has no worktree/PR actions
			}

			// ── Trees tab: worktree-in-progress actions ─────────────────
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
					const sessionCwd = di.worktree.sessionCwd ?? di.worktree.path;
					const resumeCmd =
						sessionId && bin
							? `cd ${shellEscape(sessionCwd)} && ${bin} --resume ${sessionId}`
							: null;
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
								message: `Failed to switch window${created.message ? `: ${created.message}` : ""}`,
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

			// Open issue in tracker (Linear/GitHub web UI)
			if (input === "o") {
				if (!di.issue.url) {
					dispatch({ type: "SET_ACTION_MESSAGE", message: "No issue URL available" });
					return;
				}
				if (openUrl(di.issue.url)) {
					dispatch({ type: "SET_ACTION_MESSAGE", message: "Opened in browser" });
				}
				return;
			}

			// Open PR
			if (input === "p") {
				if (!di.pr?.url) {
					dispatch({ type: "SET_ACTION_MESSAGE", message: "No PR to open" });
					return;
				}
				if (openUrl(di.pr.url)) {
					dispatch({ type: "SET_ACTION_MESSAGE", message: "Opened PR in browser" });
				}
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
								? "Launched review in new window"
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
					// Main-row commits don't carry a ticket prefix — only real
					// tracker tickets do.
					ticketId: di.issue.state.type === "main" ? null : di.issue.identifier,
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
								? "Launched PR fix in new window"
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
				state.overlay !== "context-input" &&
				// Issue form title/description are owned by MultilineTextArea;
				// only the "saving" phase needs the outer handler (a no-op
				// swallow), so disabling it for the whole overlay is fine.
				state.overlay !== "issue-form" &&
				(state.overlay !== "pr-create" || state.prCreatePhase !== "review") &&
				(state.overlay !== "commit" || state.commitPhase !== "awaiting-message"),
		},
	);

	// ── Render ─────────────────────────────────────────────────────────

	if (state.loading) {
		return (
			<Box width={columns} height={rows} flexDirection="column">
				<Box justifyContent="center" alignItems="center" flexGrow={1}>
					<SquirrelLoader text="Loading dashboard..." />
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

	// The active issue/tree row drives the detail pane and action row.
	const selectedIssue =
		(state.activeTab === "trees"
			? state.flatTrees[state.treeSelectedIndex]
			: state.flatIssues[state.selectedIndex]) ?? null;
	const selectedReview = state.flatReviews[state.reviewSelectedIndex] ?? null;
	const activeTracker = getIssueTracker(repoRootRef.current);

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
				{state.refreshing ? (
					<Text dimColor>
						{"  ·  "}
						<Spinner type="dots" />
						{" refreshing"}
					</Text>
				) : null}
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
					active={state.activeTab === "trees"}
					label={`2 Trees (${state.flatTrees.length})`}
					mode={theme.mode}
				/>
				<Text> </Text>
				<Tab
					active={state.activeTab === "reviews"}
					label={`3 Reviews (${state.flatReviews.length})`}
					mode={theme.mode}
				/>
			</Box>

			{/* Bordered content area — wraps tab content for a real "panel" feel */}
			<Box flexGrow={1} borderStyle="round" borderColor="cyan" flexDirection="column">
				{/* Main content */}
				{state.overlay === "help" ? (
					<HelpOverlay width={innerWidth} height={contentHeight} />
				) : state.overlay === "tracker-select" ? (
					<Box flexGrow={1} justifyContent="center" alignItems="center">
						<Box
							flexDirection="column"
							borderStyle="round"
							borderColor="cyan"
							paddingX={3}
							paddingY={1}
						>
							{state.trackerSelectPhase === "linear-org" ? (
								<>
									<Text bold>Select a Linear workspace:</Text>
									<Text> </Text>
									{state.trackerSelectOrgs.map((org, i) => {
										const sel = i === state.trackerSelectIndex;
										return (
											<Text key={org.slug} color={sel ? "cyan" : undefined} bold={sel}>
												{sel ? "> " : "  "}
												{org.name} ({org.slug})
											</Text>
										);
									})}
									<Text> </Text>
									<Text dimColor>j/k to navigate, Enter to link, ESC to go back</Text>
								</>
							) : (
								<>
									<Text bold>Select an issue tracker for this repo:</Text>
									<Text> </Text>
									{[
										{ label: "Local", hint: "built-in, file-based — no account needed" },
										{ label: "Linear", hint: "OAuth workspace" },
										{ label: "GitHub", hint: "GitHub Issues via gh CLI" },
									].map((t, i) => {
										const sel = i === state.trackerSelectIndex;
										return (
											<Text key={t.label}>
												<Text color={sel ? "cyan" : undefined} bold={sel}>
													{sel ? "> " : "  "}
													{t.label}
												</Text>
												<Text dimColor> — {t.hint}</Text>
											</Text>
										);
									})}
									<Text> </Text>
									{state.trackerSelectMessage ? (
										<Text color="yellow">{state.trackerSelectMessage}</Text>
									) : null}
									<Text dimColor>j/k to navigate, Enter to select, q to quit</Text>
								</>
							)}
						</Box>
					</Box>
				) : state.overlay === "confirm-delete-issue" ? (
					<Box flexGrow={1} justifyContent="center" alignItems="center">
						<Box
							flexDirection="column"
							borderStyle="round"
							borderColor="red"
							paddingX={3}
							paddingY={1}
						>
							<Text bold color="red">
								Delete issue?
							</Text>
							<Text> </Text>
							<Text>
								{selectedIssue?.issue.identifier}
								{"  "}
								{selectedIssue?.issue.title}
							</Text>
							<Text dimColor>This removes the issue file from .santree/issues/</Text>
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
				) : state.overlay === "issue-form" ? (
					<Box flexGrow={1} justifyContent="center" alignItems="center">
						<Box flexDirection="column" paddingX={2} width={Math.min(columns - 8, 100)}>
							<Text bold color="cyan">
								{state.issueFormMode === "edit" ? `Edit ${state.issueFormId}` : "New issue"}
								{" · "}
								{state.issueFormPhase === "title"
									? "title"
									: state.issueFormPhase === "description"
										? "description"
										: "saving…"}
							</Text>
							{state.issueFormError ? (
								<Text color="red">{state.issueFormError}</Text>
							) : (
								<Text dimColor>
									{state.issueFormPhase === "title"
										? "First line is the title"
										: "Markdown body — Ctrl+D to save"}
								</Text>
							)}
							<Text> </Text>
							{state.issueFormPhase === "saving" ? (
								<Text color="cyan">Saving…</Text>
							) : state.issueFormPhase === "title" ? (
								<MultilineTextArea
									value={state.issueFormTitle}
									onChange={(v) => dispatch({ type: "ISSUE_FORM_TITLE", title: v })}
									onSubmit={() => dispatch({ type: "ISSUE_FORM_PHASE", phase: "description" })}
									onCancel={() => dispatch({ type: "ISSUE_FORM_CLOSE" })}
									width={Math.min(columns - 8, 100)}
									height={3}
									placeholder="Issue title…"
								/>
							) : (
								<MultilineTextArea
									value={state.issueFormDescription}
									onChange={(v) => dispatch({ type: "ISSUE_FORM_DESC", description: v })}
									onSubmit={() => void submitIssueForm()}
									onCancel={() => dispatch({ type: "ISSUE_FORM_CLOSE" })}
									width={Math.min(columns - 8, 100)}
									height={10}
									placeholder="Description (optional)…"
								/>
							)}
							<Text> </Text>
							<Text dimColor>
								<Text color="cyan" bold>
									Ctrl+D
								</Text>
								{state.issueFormPhase === "title" ? " next  ·  " : " save  ·  "}
								<Text color="cyan" bold>
									Ctrl+G
								</Text>
								{" cancel"}
							</Text>
						</Box>
					</Box>
				) : state.overlay === "mode-select" ? (
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
							<MultilineTextArea
								value={state.contextInputValue}
								onChange={(v) => dispatch({ type: "CONTEXT_INPUT_CHANGE", value: v })}
								onSubmit={() => {
									const mode = state.contextInputMode;
									const ctx = state.contextInputValue;
									dispatch({ type: "CONTEXT_INPUT_DONE" });
									if (mode) doWork(mode, ctx);
								}}
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
								{" launch  ·  "}
								<Text color="cyan" bold>
									Ctrl+O
								</Text>
								{" editor  ·  "}
								<Text color="cyan" bold>
									Ctrl+G
								</Text>
								{" cancel"}
							</Text>
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
						pendingDiscard={state.diffPendingDiscard}
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
							) : (state.activeTab === "trees" ? state.flatTrees : state.flatIssues).length ===
							  0 ? (
								<Box
									width={leftWidth}
									height={contentHeight}
									justifyContent="center"
									alignItems="center"
									flexDirection="column"
								>
									<Text color="yellow">
										{state.activeTab === "trees" ? "No worktrees yet" : "No active issues"}
									</Text>
									{state.activeTab === "issues" && activeTracker.canMutate ? (
										<Text dimColor>Press n to create one</Text>
									) : null}
								</Box>
							) : (
								<IssueList
									groups={state.activeTab === "trees" ? state.treeGroups : state.groups}
									flatIssues={state.activeTab === "trees" ? state.flatTrees : state.flatIssues}
									selectedIndex={
										state.activeTab === "trees" ? state.treeSelectedIndex : state.selectedIndex
									}
									scrollOffset={
										state.activeTab === "trees"
											? state.treeListScrollOffset
											: state.listScrollOffset
									}
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
									draft={state.prCreateDraft}
									dispatch={dispatch}
								/>
							) : (
								<DetailPanel
									issue={selectedIssue}
									scrollOffset={
										state.activeTab === "trees"
											? state.treeDetailScrollOffset
											: state.detailScrollOffset
									}
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
				    right. Both panes' key hints sit on the same row. In diff
				    mode the ActionRow is blank, so the keymap claims the full
				    width to avoid wrapping. */}
				<Box>
					{state.overlay === "diff" ? (
						<Box width={innerWidth} paddingX={1}>
							<CommandBar showWorkspace={hasWorkspaceFile} mode="diff" />
						</Box>
					) : (
						<>
							<Box width={leftWidth + separatorWidth} paddingX={1}>
								<CommandBar showWorkspace={hasWorkspaceFile} mode="default" />
							</Box>
							<Box width={rightWidth}>
								<ActionRow
									activeTab={state.activeTab}
									selectedIssue={selectedIssue}
									selectedReview={selectedReview}
									overlay={state.overlay}
									trackerName={activeTracker.displayName}
									canMutate={activeTracker.canMutate === true}
								/>
							</Box>
						</>
					)}
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
	trackerName,
	canMutate,
}: {
	activeTab: import("../lib/dashboard/types.js").DashboardTab;
	selectedIssue: DashboardIssue | null;
	selectedReview: import("../lib/dashboard/types.js").EnrichedReviewPR | null;
	overlay: import("../lib/dashboard/types.js").ActionOverlay;
	trackerName: string;
	canMutate: boolean;
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
				? buildIssueActions(selectedIssue, trackerName, { tab: activeTab, canMutate })
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
