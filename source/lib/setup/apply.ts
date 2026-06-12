import { spawnSync } from "child_process";

/**
 * TTY hand-off for setup steps that run an interactive subprocess (brew install,
 * gh auth login, `santree issue setup`). Mirrors lib/dashboard/external-editor.ts:
 * drop raw mode so the child owns the terminal, run it synchronously (Ink can't
 * repaint while the event loop is blocked), then restore raw mode.
 *
 * Returns the child's exit code (1 on spawn failure).
 */
export function spawnTTY(cmd: string, args: string[], opts?: { cwd?: string }): number {
	const wasRaw = process.stdin.isTTY ? process.stdin.isRaw : false;
	if (process.stdin.isTTY && process.stdin.setRawMode) {
		try {
			process.stdin.setRawMode(false);
		} catch {}
	}

	const result = spawnSync(cmd, args, { stdio: "inherit", cwd: opts?.cwd });

	if (process.stdin.isTTY && process.stdin.setRawMode) {
		try {
			process.stdin.setRawMode(wasRaw);
		} catch {}
	}

	if (result.error) return 1;
	return result.status ?? 1;
}

/** argv to re-invoke this same santree binary (robust to global vs local installs). */
export function santreeSelfArgv(args: string[]): { cmd: string; args: string[] } {
	const entry = process.argv[1];
	if (entry) return { cmd: process.execPath, args: [entry, ...args] };
	return { cmd: "santree", args };
}
