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
} from "../lib/git.js";
import { spawnAsync } from "../lib/exec.js";
import { resolveAgentBinary } from "../lib/ai.js";
import type { DashboardIssue, ProjectGroup } from "../lib/dashboard/types.js";
import { initialState, reducer } from "../lib/dashboard/types.js";
import { loadDashboardData } from "../lib/dashboard/data.js";
import IssueList from "../lib/dashboard/IssueList.js";
import DetailPanel from "../lib/dashboard/DetailPanel.js";
import { CommitOverlay, PrCreateOverlay } from "../lib/dashboard/Overlays.js";

export const description = "Interactive dashboard of your Linear issues";

const execAsync = promisify(exec);

// ── Helpers ───────────────────────────────────────────────────────────

function isInTmux(): boolean {
	return !!process.env.TMUX;
}

function slugify(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40);
}

// ── Scroll helpers ────────────────────────────────────────────────────

function getRowIndexForFlatIndex(groups: ProjectGroup[], flatIndex: number): number {
	let row = 1; // skip column header row
	let issuesSeen = 0;
	for (const g of groups) {
		row++; // project header
		for (const sg of g.statusGroups) {
			row++; // status header
			for (let i = 0; i < sg.issues.length; i++) {
				if (issuesSeen === flatIndex) return row;
				row++;
				issuesSeen++;
			}
		}
	}
	return 0;
}

function getFlatIndexForListRow(groups: ProjectGroup[], listRow: number): number | null {
	if (listRow === 0) return null; // column header row
	let row = 1; // skip column header row
	let issuesSeen = 0;
	for (const g of groups) {
		if (row === listRow) return null; // project header row
		row++;
		for (const sg of g.statusGroups) {
			if (row === listRow) return null; // status header row
			row++;
			for (let i = 0; i < sg.issues.length; i++) {
				if (row === listRow) return issuesSeen;
				row++;
				issuesSeen++;
			}
		}
	}
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
	if (isInTmux()) {
		try {
			execSync('tmux rename-window "santree"', { stdio: "ignore" });
		} catch {}
	}
	process.stdout.write("\x1b[?1049h"); // Enter alternate screen buffer
	process.stdout.write("\x1b[?25l"); // Hide cursor
}

/** Leave alternate screen and restore cursor — used when exiting to shell */
function leaveAltScreen() {
	process.stdout.write("\x1b[?1049l"); // Leave alternate screen buffer
	process.stdout.write("\x1b[?25h"); // Show cursor
}

// ── Component ─────────────────────────────────────────────────────────

export default function Dashboard() {
	ensureAltScreen();
	const { exit } = useApp();
	const { stdout } = useStdout();
	const [state, dispatch] = useReducer(reducer, initialState);
	const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const repoRootRef = useRef<string | null>(null);
	const stateRef = useRef(state);
	stateRef.current = state;
	const draggingRef = useRef(false);

	const [termSize, setTermSize] = useState({
		columns: stdout?.columns ?? 80,
		rows: stdout?.rows ?? 24,
	});

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
	const [leftWidth, setLeftWidth] = useState(Math.floor(columns * 0.42));
	const leftWidthRef = useRef(leftWidth);
	leftWidthRef.current = leftWidth;
	const rightWidth = columns - leftWidth - separatorWidth;
	const contentHeight = rows - 1; // 1 header
	const LIST_FOOTER_HEIGHT = 2;

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
			const data = await loadDashboardData(repoRoot);
			dispatch({ type: "SET_DATA", ...data });
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
				draggingRef.current = false;
				return;
			}

			// Drag — resize if actively dragging
			if (isDrag && draggingRef.current) {
				// col is 1-based; place divider center at mouse position
				const newLeft = Math.max(minW, Math.min(col - 1, cols - sepW - minW));
				setLeftWidth(newLeft);
				return;
			}

			// Scroll wheel — button 64 = up, 65 = down
			if (match[4] === "M" && (button === 64 || button === 65)) {
				const s = stateRef.current;
				const lw = leftWidthRef.current;
				const delta = button === 65 ? 3 : -3;

				if (col <= lw) {
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

			// Left-click press: check if on divider to start drag
			const lw = leftWidthRef.current;
			const divStart = lw + 1; // 1-based start of separator
			const divEnd = lw + sepW; // 1-based end of separator
			if (col >= divStart && col <= divEnd) {
				draggingRef.current = true;
				return;
			}

			// Left-click press: select issue in left pane
			const s = stateRef.current;
			if (s.loading || s.error || s.flatIssues.length === 0) return;
			if (col > lw) return;

			// Row 1 is the header line, content starts at row 2 (1-based)
			const contentRow = row - 2; // 0-based row within content area
			if (contentRow < 0) return;

			const listRow = s.listScrollOffset + contentRow;
			const flatIdx = getFlatIndexForListRow(s.groups, listRow);
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
		const rowIdx = getRowIndexForFlatIndex(state.groups, state.selectedIndex);
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

	// ── Actions ───────────────────────────────────────────────────────

	const launchWorkInTmux = useCallback(
		(di: DashboardIssue, mode: "plan" | "implement", worktreePath: string) => {
			const windowName = di.issue.identifier;
			const sessionId = di.worktree?.sessionId;
			const bin = resolveAgentBinary();
			const resumeCmd = sessionId && bin ? `${bin} --resume ${sessionId}` : null;
			const workCmd = mode === "plan" ? "st worktree work --plan" : "st worktree work";

			try {
				// Switch to existing window if it exists
				execSync(`tmux select-window -t "${windowName}"`, { stdio: "ignore" });
				const cmd = resumeCmd ?? workCmd;
				execSync(`tmux send-keys -t "${windowName}" "${cmd}" Enter`, { stdio: "ignore" });
				dispatch({
					type: "SET_ACTION_MESSAGE",
					message: resumeCmd
						? `Resumed session in: ${windowName}`
						: `Launched ${mode} in: ${windowName}`,
				});
			} catch {
				// Window doesn't exist — create it
				try {
					execSync(`tmux new-window -n "${windowName}" -c "${worktreePath}"`, { stdio: "ignore" });
					// Small delay so the new shell can start reading input before we send keys,
					// otherwise buffered keystrokes from the dashboard pane can leak in.
					execSync("sleep 0.1", { stdio: "ignore" });
					const cmd = resumeCmd ?? workCmd;
					execSync(`tmux send-keys -t "${windowName}" "${cmd}" Enter`, { stdio: "ignore" });
					dispatch({
						type: "SET_ACTION_MESSAGE",
						message: resumeCmd
							? `Resumed session in new window: ${windowName}`
							: `Launched ${mode} in tmux window: ${windowName}`,
					});
				} catch {
					dispatch({ type: "SET_ACTION_MESSAGE", message: "Failed to create tmux window" });
				}
			}
			// Delayed refresh to pick up session ID created by `st worktree work`
			setTimeout(() => refresh(), 3000);
		},
		[refresh],
	);

	const launchAfterCreation = useCallback(
		(mode: "plan" | "implement", worktreePath: string, ticketId: string) => {
			if (isInTmux()) {
				const windowName = ticketId;
				const workCmd = mode === "plan" ? "st worktree work --plan" : "st worktree work";
				try {
					execSync(`tmux new-window -n "${windowName}" -c "${worktreePath}"`, { stdio: "ignore" });
					execSync("sleep 0.1", { stdio: "ignore" });
					execSync(`tmux send-keys -t "${windowName}" "${workCmd}" Enter`, { stdio: "ignore" });
					dispatch({
						type: "SET_ACTION_MESSAGE",
						message: `Created worktree + launched ${mode} in: ${windowName}`,
					});
				} catch {
					dispatch({ type: "SET_ACTION_MESSAGE", message: "Worktree created, but tmux failed" });
				}
				setTimeout(() => refresh(), 3000);
			} else {
				leaveAltScreen();
				console.log(`SANTREE_CD:${worktreePath}`);
				console.log(`SANTREE_WORK:${mode}`);
				exit();
			}
		},
		[exit, refresh],
	);

	const createAndLaunch = useCallback(
		async (mode: "plan" | "implement", runSetup: boolean) => {
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
			const base = getDefaultBranch();

			// 1. Pull latest (async to avoid blocking the event loop)
			dispatch({ type: "CREATION_LOG", logs: `Fetching origin...\n` });
			try {
				await execAsync("git fetch origin", { cwd: repoRoot });
				dispatch({ type: "CREATION_LOG", logs: `Checking out ${base}...\n` });
				await execAsync(`git checkout ${base}`, { cwd: repoRoot });
				dispatch({ type: "CREATION_LOG", logs: `Pulling ${base}...\n` });
				await execAsync(`git pull origin ${base}`, { cwd: repoRoot });
				dispatch({ type: "CREATION_LOG", logs: `Pulled latest ${base}\n` });
			} catch (e) {
				const msg = e instanceof Error ? e.message : "Failed to pull latest";
				dispatch({ type: "CREATION_LOG", logs: `Warning: ${msg}\n` });
			}

			// 2. Create worktree
			dispatch({ type: "CREATION_LOG", logs: `Creating worktree ${branchName}...\n` });
			const result = await createWorktree(branchName, base, repoRoot);

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
			launchAfterCreation(mode, result.path, ticketId);
		},
		[launchAfterCreation],
	);

	const doWork = useCallback(
		(mode: "plan" | "implement") => {
			const di = state.flatIssues[state.selectedIndex];
			if (!di) return;
			const repoRoot = repoRootRef.current;
			if (!repoRoot) return;

			dispatch({ type: "SET_OVERLAY", overlay: null });

			if (di.worktree) {
				// Worktree exists — launch work
				if (isInTmux()) {
					launchWorkInTmux(di, mode, di.worktree.path);
				} else {
					leaveAltScreen();
					console.log(`SANTREE_CD:${di.worktree.path}`);
					console.log(`SANTREE_WORK:${mode}`);
					exit();
				}
			} else {
				// No worktree — ask about setup if init script exists
				if (hasInitScript(repoRoot)) {
					dispatch({ type: "SETUP_CONFIRM_SHOW", mode });
					return;
				}
				// No init script — create directly
				createAndLaunch(mode, false);
			}
		},
		[state.flatIssues, state.selectedIndex, exit, launchWorkInTmux, createAndLaunch],
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

			// Push first
			dispatch({ type: "PR_CREATE_PHASE", phase: "pushing" });
			try {
				await execAsync(`git -C "${s.prCreateWorktreePath}" push -u origin "${s.prCreateBranch}"`);
			} catch (e: any) {
				const msg = e?.stderr?.trim() || e?.message || "Push failed";
				dispatch({ type: "PR_CREATE_ERROR", error: msg });
				return;
			}

			dispatch({ type: "PR_CREATE_PHASE", phase: "creating" });
			try {
				if (fill) {
					const { stdout } = await execAsync(
						`gh pr create --fill --base "${base}" --head "${s.prCreateBranch}"`,
						{ cwd: s.prCreateWorktreePath },
					);
					const url = stdout.trim();
					dispatch({ type: "PR_CREATE_DONE", url });
				} else {
					await execAsync(`gh pr create --web --base "${base}" --head "${s.prCreateBranch}"`, {
						cwd: s.prCreateWorktreePath,
					});
					dispatch({ type: "PR_CREATE_DONE", url: "" });
				}
				setTimeout(() => {
					dispatch({ type: "PR_CREATE_CANCEL" });
					refresh();
				}, 2500);
			} catch (e: any) {
				const msg = e?.stderr?.trim() || e?.message || "PR creation failed";
				dispatch({ type: "PR_CREATE_ERROR", error: msg });
			}
		},
		[refresh],
	);

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
				return;
			}

			// Confirm setup overlay
			if (state.overlay === "confirm-setup") {
				const mode = state.setupMode;
				if (input === "y" && mode) {
					dispatch({ type: "SETUP_CONFIRM_DONE" });
					createAndLaunch(mode, true);
					return;
				}
				if (input === "n" && mode) {
					dispatch({ type: "SETUP_CONFIRM_DONE" });
					createAndLaunch(mode, false);
					return;
				}
				if (key.escape) {
					dispatch({ type: "SETUP_CONFIRM_DONE" });
					return;
				}
				return;
			}

			// Mode select overlay
			if (state.overlay === "mode-select") {
				if (input === "p" || input === "1") {
					doWork("plan");
					return;
				}
				if (input === "i" || input === "2") {
					doWork("implement");
					return;
				}
				if (key.escape || input === "q") {
					dispatch({ type: "SET_OVERLAY", overlay: null });
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

			// Quit
			if (input === "q") {
				exit();
				return;
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
				if (isInTmux()) {
					const windowName = di.issue.identifier;
					const sessionId = di.worktree.sessionId;
					const bin = resolveAgentBinary();
					const resumeCmd = sessionId && bin ? `${bin} --resume ${sessionId}` : null;

					try {
						execSync(`tmux select-window -t "${windowName}"`, { stdio: "ignore" });
					} catch {
						// Window doesn't exist — create one and resume/launch
						try {
							execSync(`tmux new-window -n "${windowName}" -c "${di.worktree.path}"`, {
								stdio: "ignore",
							});
							execSync("sleep 0.1", { stdio: "ignore" });
							const cmd = resumeCmd ?? "st worktree work";
							execSync(`tmux send-keys -t "${windowName}" "${cmd}" Enter`, {
								stdio: "ignore",
							});
						} catch {
							dispatch({ type: "SET_ACTION_MESSAGE", message: "Failed to switch tmux window" });
						}
					}
				} else {
					leaveAltScreen();
					console.log(`SANTREE_CD:${di.worktree.path}`);
					exit();
				}
				return;
			}

			// Open in Linear
			if (input === "o") {
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
				if (isInTmux()) {
					const windowName = `review-${di.issue.identifier}`;
					try {
						execSync(`tmux new-window -n "${windowName}" -c "${di.worktree.path}"`, {
							stdio: "ignore",
						});
						execSync(`tmux send-keys -t "${windowName}" "st pr review" Enter`, { stdio: "ignore" });
						dispatch({ type: "SET_ACTION_MESSAGE", message: "Launched review in tmux" });
					} catch {
						dispatch({ type: "SET_ACTION_MESSAGE", message: "Failed to launch review" });
					}
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

			// Open workspace
			if (input === "E") {
				openWorkspace();
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
				if (isInTmux()) {
					const windowName = `fix-${di.issue.identifier}`;
					try {
						execSync(`tmux new-window -n "${windowName}" -c "${di.worktree.path}"`, {
							stdio: "ignore",
						});
						execSync(`tmux send-keys -t "${windowName}" "st pr fix" Enter`, { stdio: "ignore" });
						dispatch({ type: "SET_ACTION_MESSAGE", message: "Launched PR fix in tmux" });
					} catch {
						dispatch({ type: "SET_ACTION_MESSAGE", message: "Failed to launch PR fix" });
					}
				} else {
					leaveAltScreen();
					console.log(`SANTREE_CD:${di.worktree.path}`);
					exit();
				}
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

			// Refresh
			if (input === "R") {
				refresh();
				return;
			}
		},
		{ isActive: state.overlay !== "commit" || state.commitPhase !== "awaiting-message" },
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

	if (state.flatIssues.length === 0) {
		return (
			<Box width={columns} height={rows} flexDirection="column">
				<Box justifyContent="center" alignItems="center" flexGrow={1} flexDirection="column">
					<Text color="yellow">No active issues assigned to you</Text>
					<Text dimColor>Press R to refresh or q to quit</Text>
				</Box>
			</Box>
		);
	}

	const selectedIssue = state.flatIssues[state.selectedIndex] ?? null;

	return (
		<Box width={columns} height={rows} flexDirection="column">
			{/* Header */}
			<Box>
				<Text bold color="cyan">
					Santree Dashboard
				</Text>
				<Text dimColor> v{version}</Text>
				<Text dimColor>
					{" "}
					({state.flatIssues.length} issues)
					{state.refreshing ? " refreshing..." : ""}
				</Text>
				{state.actionMessage && (
					<Text color="yellow">
						{"  "}
						{state.actionMessage}
					</Text>
				)}
			</Box>

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
						<IssueList
							groups={state.groups}
							flatIssues={state.flatIssues}
							selectedIndex={state.selectedIndex}
							scrollOffset={state.listScrollOffset}
							height={contentHeight}
							width={leftWidth}
							creatingForTicket={state.creatingForTicket}
							deletingForTicket={state.deletingForTicket}
						/>
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
						{state.overlay === "commit" ? (
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
		</Box>
	);
}
