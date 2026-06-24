import type { ChildProcess } from "child_process";
import type { ClaudeTodo } from "../claude-todos.js";

export type AiAgentKind = "claude" | "codex";

export interface LaunchOpts {
	/** Read-only / plan mode (Claude `--permission-mode plan`, Codex `--sandbox read-only`). */
	planMode?: boolean;
	/** Session id to attach (Claude `--session-id`/`--resume`). Ignored when the agent can't preset ids. */
	sessionId?: string;
	/** Resume the given session rather than starting a new one. */
	resume?: boolean;
}

export interface HeadlessOpts {
	/**
	 * Restrict the run to read-only behaviour. Claude maps this to an
	 * `--allowedTools` allowlist (see `allowedTools`); Codex maps any read-only
	 * intent to `--sandbox read-only` (coarser — it can't allowlist by tool).
	 */
	readOnly?: boolean;
	/** Fine-grained tool allowlist. Honoured by agents that support it (Claude). */
	allowedTools?: string[];
}

export interface RunResult {
	success: boolean;
	output: string;
}

/**
 * Pluggable AI coding-agent backend. Mirrors the IssueTracker / Multiplexer
 * abstractions: a factory (`getAiAgent()`) resolves the active adapter and the
 * rest of santree gates behaviour on **capability flags** (never on `kind`).
 *
 * Adapters: `claude` (Claude Code CLI) and `codex` (OpenAI Codex CLI).
 */
export interface AiAgent {
	readonly kind: AiAgentKind;
	/** Human-facing name shown in config / diagnostics ("Claude Code", "Codex"). */
	readonly displayName: string;
	/** npm package used for install + version-freshness checks. */
	readonly installPackage: string;
	/** Short hint shown when the binary is missing. */
	readonly installHint: string;

	/** Resolve the CLI binary path, or null if not installed. */
	resolveBinary(): string | null;
	/** Locally installed version string, or null. Sync (execSync) like the rest of the version layer. */
	getInstalledVersion(): string | null;

	/** Launch an interactive session (inherits stdio). Throws if the binary is missing. */
	launchInteractive(prompt: string, opts?: LaunchOpts): ChildProcess;
	/** Run headless and capture output (blocking). Throws if the binary is missing. */
	runHeadless(prompt: string, opts?: HeadlessOpts): RunResult;
	/** Async headless run — use from Ink renderers so the event loop keeps turning. */
	runHeadlessAsync(prompt: string, opts?: HeadlessOpts): Promise<RunResult>;

	/**
	 * Build the shell line that resumes a stored session from `cwd`
	 * (e.g. `cd <cwd> && claude --resume <id>`). Used by the dashboard's
	 * new-window resume flow. Only reached when a session id exists, which in
	 * turn only happens for agents with `canPresetSessionId`.
	 */
	buildResumeCommand(sessionId: string, cwd: string): string;

	/**
	 * Build the shell line that launches the agent interactively in a fresh
	 * multiplexer window with `prompt` as its sole argument (used by investigate).
	 */
	buildLaunchLine(prompt: string): string;

	// ── Capability flags (UI/feature gates read these) ───────────────────────
	/** Can santree assign a session id up front? Claude ✓ (`--session-id`), Codex ✗. */
	readonly canPresetSessionId: boolean;
	/** Scriptable statusline command hook (Claude ✓, Codex ✗). */
	readonly supportsStatusline: boolean;
	/** File-based remote-control toggle (Claude `~/.claude.json` ✓, Codex ✗). */
	readonly supportsRemoteControl: boolean;
	/** Externally-readable per-session todos file (Claude ✓, Codex ✗). */
	readonly supportsReadableTodos: boolean;
	/** Self-paced loop primitive that keeps cross-iteration context (Claude `/loop` ✓, Codex ✗). */
	readonly supportsSelfPacedLoop: boolean;
	/** Slash-command skill invocation, e.g. `/skill TEAM-1` (Claude ✓, Codex ✗ today). */
	readonly supportsSlashSkills: boolean;

	// ── Optional capabilities (feature-detected, like IssueTracker.canMutate) ──
	/** Read the agent's todo file for a session. Present only when `supportsReadableTodos`. */
	readTodos?(sessionId: string): ClaudeTodo[] | null;
	/** Resolve the cwd a session is resumable from. Present only when `canPresetSessionId`. */
	findSessionCwd?(worktreeRoot: string, sessionId: string): string | null;
}
