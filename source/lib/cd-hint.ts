/**
 * santree is a plain binary — a child process can't change its parent shell's
 * working directory. So when a command wants you to land in a worktree, it
 * prints the command for you to run. (Dashboard flows with tmux/cmux open a new
 * window in the right directory instead and never need this.)
 */

/** Single-quote a value for safe copy-paste into a POSIX shell. */
function sq(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface CdHint {
	path: string;
	/** Append a `worktree work` launch after the cd. */
	work?: { mode: "plan" | "implement" | string; contextFile?: string };
}

/** The shell command to enter a worktree (and optionally start work). */
export function formatCdCommand(hint: CdHint): string {
	let cmd = `cd ${sq(hint.path)}`;
	if (hint.work) {
		let work = "santree worktree work";
		if (hint.work.mode === "plan") work += " --plan";
		if (hint.work.contextFile) work += ` --context-file ${sq(hint.work.contextFile)}`;
		cmd += ` && ${work}`;
	}
	return cmd;
}

/** Print the cd hint to stdout (for non-Ink contexts, e.g. after the dashboard exits). */
export function printCdHint(hint: CdHint): void {
	console.log(`\n→ Run this to enter the worktree:\n  ${formatCdCommand(hint)}`);
}
