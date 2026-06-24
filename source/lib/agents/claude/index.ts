import { execSync, spawn, spawnSync, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { promptArg } from "../prompt-arg.js";
import { readMainAgentTodos, findClaudeSessionCwd } from "../../claude-todos.js";
import type { AiAgent, HeadlessOpts, LaunchOpts, RunResult } from "../types.js";

/**
 * cmux ships its own Claude CLI shim wired to the active cmux workspace. When
 * we run inside cmux, the system `claude` (if any) talks to a different
 * session — confusing for the user. See manaflow-ai/cmux#2048.
 */
const CMUX_CLAUDE_PATH = "/Applications/cmux.app/Contents/Resources/bin/claude";

const NOT_FOUND = "Claude CLI not found. Install: npm install -g @anthropic-ai/claude-code";

/**
 * Resolve the path to the Claude CLI binary, preferring cmux's bundled copy
 * when running inside cmux. Falls back to PATH lookup, then to Anthropic's
 * standard installer location (`~/.claude/local/claude`). Returns null if none
 * resolve.
 */
export function resolveClaudeBinary(): string | null {
	// Inside cmux, the bundled binary is the only one wired to the active
	// workspace. Gate on `CMUX_SURFACE_ID` (real cmux runtime) — outside a live
	// workspace the bundled binary has no auth context and exits with
	// "Invalid API key".
	if (process.env["CMUX_SURFACE_ID"] && existsSync(CMUX_CLAUDE_PATH)) {
		return CMUX_CLAUDE_PATH;
	}

	try {
		execSync("which claude", { stdio: "ignore" });
		return "claude";
	} catch {
		// fall through
	}

	const localClaude = join(homedir(), ".claude", "local", "claude");
	if (existsSync(localClaude)) return localClaude;

	return null;
}

/** POSIX single-quote a shell argument. */
function sq(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

export const claudeAgent: AiAgent = {
	kind: "claude",
	displayName: "Claude Code",
	installPackage: "@anthropic-ai/claude-code",
	installHint: "npm install -g @anthropic-ai/claude-code",

	canPresetSessionId: true,
	supportsStatusline: true,
	supportsRemoteControl: true,
	supportsReadableTodos: true,
	supportsSelfPacedLoop: true,
	supportsSlashSkills: true,

	resolveBinary: resolveClaudeBinary,

	getInstalledVersion(): string | null {
		const resolved = resolveClaudeBinary();
		const candidates = [resolved, "claude", join(homedir(), ".claude", "local", "claude")].filter(
			(b): b is string => b !== null,
		);
		const seen = new Set<string>();
		for (const bin of candidates) {
			if (seen.has(bin)) continue;
			seen.add(bin);
			try {
				const out = execSync(`${bin} --version`, {
					encoding: "utf-8",
					stdio: ["pipe", "pipe", "pipe"],
				}).trim();
				const v = out.split(/\s+/)[0];
				if (v) return v;
			} catch {
				// try next
			}
		}
		return null;
	},

	launchInteractive(prompt: string, opts?: LaunchOpts): ChildProcess {
		const bin = resolveClaudeBinary();
		if (!bin) throw new Error(NOT_FOUND);

		const args: string[] = [];
		// Plan mode uses `--permission-mode plan` (read-only, restrictive);
		// implement runs use `auto`. Auto-acceptance of non-mutating tools while
		// planning is governed by the user's `useAutoModeDuringPlan` setting in
		// ~/.claude/settings.json, not by santree.
		args.push("--permission-mode", opts?.planMode ? "plan" : "auto");

		if (opts?.sessionId) {
			if (opts.resume) args.push("--resume", opts.sessionId);
			else args.push("--session-id", opts.sessionId);
		}

		args.push("--", promptArg(prompt));
		return spawn(bin, args, { stdio: "inherit" });
	},

	runHeadless(prompt: string, opts?: HeadlessOpts): RunResult {
		const bin = resolveClaudeBinary();
		if (!bin) throw new Error(NOT_FOUND);
		const toolArgs = opts?.allowedTools?.length ? ["--allowedTools", ...opts.allowedTools] : [];
		const result = spawnSync(
			bin,
			[
				"--permission-mode",
				"auto",
				...toolArgs,
				"-p",
				"--output-format",
				"text",
				"--",
				promptArg(prompt),
			],
			{ encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
		);
		return { success: result.status === 0, output: result.stdout?.trim() ?? "" };
	},

	runHeadlessAsync(prompt: string, opts?: HeadlessOpts): Promise<RunResult> {
		const bin = resolveClaudeBinary();
		if (!bin) return Promise.reject(new Error(NOT_FOUND));
		const toolArgs = opts?.allowedTools?.length ? ["--allowedTools", ...opts.allowedTools] : [];
		const args = [
			"--permission-mode",
			"auto",
			...toolArgs,
			"-p",
			"--output-format",
			"text",
			"--",
			promptArg(prompt),
		];
		return new Promise<RunResult>((resolve) => {
			const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			child.stdout?.on("data", (chunk) => (stdout += chunk.toString("utf-8")));
			child.on("error", () => resolve({ success: false, output: "" }));
			child.on("close", (code) => resolve({ success: code === 0, output: stdout.trim() }));
		});
	},

	buildResumeCommand(sessionId: string, cwd: string): string {
		// `claude --resume` is cwd-scoped, so anchor the resume at the cwd where
		// the session was created.
		const bin = resolveClaudeBinary() ?? "claude";
		return `cd ${sq(cwd)} && ${bin} --resume ${sessionId}`;
	},

	buildLaunchLine(prompt: string): string {
		const bin = resolveClaudeBinary() ?? "claude";
		return `${bin} ${sq(prompt)}`;
	},

	readTodos: readMainAgentTodos,
	findSessionCwd: findClaudeSessionCwd,
};
