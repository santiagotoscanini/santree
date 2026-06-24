import { execSync, spawn, spawnSync, type ChildProcess } from "child_process";
import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";
import { promptArg } from "../prompt-arg.js";
import type { AiAgent, HeadlessOpts, LaunchOpts, RunResult } from "../types.js";

const NOT_FOUND = "Codex CLI not found. Install: npm install -g @openai/codex";

/**
 * Resolve the OpenAI Codex CLI binary. Codex is a native (Rust) binary wrapped
 * by the `@openai/codex` npm package; no cmux-bundled variant exists. PATH
 * lookup, then the npm-global / installer location under the home dir.
 */
export function resolveCodexBinary(): string | null {
	try {
		execSync("which codex", { stdio: "ignore" });
		return "codex";
	} catch {
		// fall through
	}
	// Curl-installer / release-binary location.
	const local = join(homedir(), ".codex", "bin", "codex");
	if (existsSync(local)) return local;
	return null;
}

/** POSIX single-quote a shell argument. */
function sq(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Sandbox/approval args for a Codex run.
 *  - read-only  → `--sandbox read-only` (santree's headless calls never write
 *    files: fill-commit, fill-pr, triage ask).
 *  - autonomous → `--sandbox workspace-write --ask-for-approval never`, the
 *    Codex equivalent of Claude's `--permission-mode auto`.
 * NOTE: confirm flag spelling against the installed `codex` (Phase 0 spike).
 */
function sandboxArgs(readOnly: boolean): string[] {
	return readOnly
		? ["--sandbox", "read-only", "--ask-for-approval", "never"]
		: ["--sandbox", "workspace-write", "--ask-for-approval", "never"];
}

export const codexAgent: AiAgent = {
	kind: "codex",
	displayName: "Codex",
	installPackage: "@openai/codex",
	installHint: "npm install -g @openai/codex",

	// Codex gaps vs Claude — every false here makes the matching santree feature
	// degrade gracefully (see CODEX_SUPPORT_PLAN.md).
	canPresetSessionId: false, // Codex generates session ids; can't be told one up front.
	supportsStatusline: false, // No scriptable statusline (openai/codex#17827).
	supportsRemoteControl: false, // Has a WebSocket app-server model, not a file toggle.
	supportsReadableTodos: false, // No documented external per-session todos file.
	supportsSelfPacedLoop: false, // No ScheduleWakeup / self-paced `/loop` primitive.
	supportsSlashSkills: false, // Reusable workflows via skills, not `/skill <arg>` slash calls.

	resolveBinary: resolveCodexBinary,

	getInstalledVersion(): string | null {
		const bin = resolveCodexBinary();
		if (!bin) return null;
		try {
			const out = execSync(`${bin} --version`, {
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			}).trim();
			// e.g. "codex 0.12.3" → take the last token that looks like a version.
			const v = out.split(/\s+/).find((t) => /^\d+\.\d+/.test(t)) ?? out.split(/\s+/).pop();
			return v ?? null;
		} catch {
			return null;
		}
	},

	launchInteractive(prompt: string, opts?: LaunchOpts): ChildProcess {
		const bin = resolveCodexBinary();
		if (!bin) throw new Error(NOT_FOUND);

		// Resume an existing session when asked (only reached if a caller tracked
		// a Codex session id — santree doesn't today, since canPresetSessionId is
		// false, so this is here for completeness/parity).
		if (opts?.resume && opts.sessionId) {
			return spawn(bin, ["resume", opts.sessionId], { stdio: "inherit" });
		}

		const args = [...sandboxArgs(!!opts?.planMode), promptArg(prompt)];
		return spawn(bin, args, { stdio: "inherit" });
	},

	runHeadless(prompt: string, opts?: HeadlessOpts): RunResult {
		const bin = resolveCodexBinary();
		if (!bin) throw new Error(NOT_FOUND);
		const outFile = join(tmpdir(), `santree-codex-${Date.now()}.out`);
		// santree's headless calls are read-only generation; keep Codex sandboxed.
		const readOnly = opts?.readOnly ?? true;
		const result = spawnSync(
			bin,
			["exec", ...sandboxArgs(readOnly), "-o", outFile, promptArg(prompt)],
			{ encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
		);
		return { success: result.status === 0, output: readOutFile(outFile, result.stdout) };
	},

	runHeadlessAsync(prompt: string, opts?: HeadlessOpts): Promise<RunResult> {
		const bin = resolveCodexBinary();
		if (!bin) return Promise.reject(new Error(NOT_FOUND));
		const outFile = join(tmpdir(), `santree-codex-${Date.now()}.out`);
		const readOnly = opts?.readOnly ?? true;
		const args = ["exec", ...sandboxArgs(readOnly), "-o", outFile, promptArg(prompt)];
		return new Promise<RunResult>((resolve) => {
			const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			child.stdout?.on("data", (chunk) => (stdout += chunk.toString("utf-8")));
			child.on("error", () => resolve({ success: false, output: "" }));
			child.on("close", (code) =>
				resolve({ success: code === 0, output: readOutFile(outFile, stdout) }),
			);
		});
	},

	buildResumeCommand(sessionId: string, cwd: string): string {
		const bin = resolveCodexBinary() ?? "codex";
		return `cd ${sq(cwd)} && ${bin} resume ${sessionId}`;
	},

	buildLaunchLine(prompt: string): string {
		const bin = resolveCodexBinary() ?? "codex";
		return `${bin} ${sq(prompt)}`;
	},
};

/**
 * Prefer the final-message file written via `-o`; fall back to captured stdout
 * if the file is absent (older codex, or the flag changed). Always cleans up.
 */
function readOutFile(outFile: string, fallbackStdout: string): string {
	try {
		const content = readFileSync(outFile, "utf-8").trim();
		rmSync(outFile, { force: true });
		if (content) return content;
	} catch {
		// file not written — fall back to stdout
	}
	return fallbackStdout.trim();
}
