import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type ClaudeTodoStatus = "pending" | "in_progress" | "completed";

export interface ClaudeTodo {
	id: string;
	content: string;
	status: ClaudeTodoStatus;
}

/** Read the main-agent todo list for a Claude Code session.
 *
 * Claude Code persists `TodoWrite` state to
 * `~/.claude/todos/<sessionId>-agent-<agentId>.json`. The file with
 * `agentId === sessionId` is the user-visible list; sub-agent files
 * (different agentId) are noise and ignored here.
 *
 * Returns null when the file is missing, empty, or unparseable. The
 * dashboard treats a null/empty result as "hide the section" so a
 * stray malformed file never blocks rendering. */
export function readMainAgentTodos(sessionId: string): ClaudeTodo[] | null {
	const file = path.join(os.homedir(), ".claude", "todos", `${sessionId}-agent-${sessionId}.json`);
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return null;
	}
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return null;
		const out: ClaudeTodo[] = [];
		for (const item of parsed) {
			if (!item || typeof item !== "object") continue;
			const { id, content, status } = item as Partial<ClaudeTodo>;
			if (typeof id !== "string" || typeof content !== "string") continue;
			if (status !== "pending" && status !== "in_progress" && status !== "completed") continue;
			out.push({ id, content, status });
		}
		return out.length > 0 ? out : null;
	} catch {
		return null;
	}
}

function encodeCwd(cwd: string): string {
	return cwd.replace(/[/.]/g, "-");
}

/** Locate the cwd from which a Claude Code session is resumable.
 *
 * Claude stores transcripts at
 * `~/.claude/projects/<encodedCwd>/<sessionId>.jsonl`, where `encodedCwd`
 * replaces every `/` and `.` with `-`. `claude --resume <id>` is cwd-scoped:
 * a session created at the worktree root is NOT resumable from a
 * subdirectory like `backend/canary`, even though the file exists somewhere
 * under `~/.claude/projects/`. The dashboard's tmux send-keys flow has no
 * control over where the user's shell init / direnv leaves the window's
 * cwd, so we resolve the original launch cwd here and prepend a `cd` to
 * the resume command.
 *
 * Returns the real path of the cwd where the session is resumable —
 * constrained to the worktree subtree so we never recommend `cd`-ing
 * outside it. Returns null when the file isn't found anywhere matching
 * the worktree (the file was deleted, or the session was created in a
 * cwd we can't reconstruct). The encoding is lossy (`-` could come from
 * `/` or `.`), so we verify candidates against real filesystem paths
 * under `worktreeRoot` rather than guessing. */
export function findClaudeSessionCwd(worktreeRoot: string, sessionId: string): string | null {
	const projectsRoot = path.join(os.homedir(), ".claude", "projects");
	const wtEncoded = encodeCwd(worktreeRoot);

	// Fast path: session was created at the worktree root itself.
	if (fs.existsSync(path.join(projectsRoot, wtEncoded, `${sessionId}.jsonl`))) {
		return worktreeRoot;
	}

	// Slow path: session was created in a subdir of the worktree (e.g.
	// project conventions auto-cd into `backend/canary` via direnv).
	let dirs: string[];
	try {
		dirs = fs.readdirSync(projectsRoot);
	} catch {
		return null;
	}

	const prefix = `${wtEncoded}-`;
	for (const dir of dirs) {
		if (!dir.startsWith(prefix)) continue;
		if (!fs.existsSync(path.join(projectsRoot, dir, `${sessionId}.jsonl`))) continue;

		// Decode the suffix back to a real path under the worktree. The
		// encoding is lossy, so we verify candidates against the filesystem
		// rather than guessing — only return a path that actually exists.
		const suffix = dir.slice(prefix.length);
		const candidate = path.join(worktreeRoot, ...suffix.split("-"));
		if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
			return candidate;
		}
	}
	return null;
}
