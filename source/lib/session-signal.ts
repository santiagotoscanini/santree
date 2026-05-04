import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { getMultiplexer } from "./multiplexer/index.js";

export type SessionStateValue = "waiting" | "idle" | "active" | "exited";

export function readStdin(): string {
	try {
		return fs.readFileSync(0, "utf-8");
	} catch {
		return "";
	}
}

export function extractRepoAndTicket(cwd: string): { repoRoot: string; ticketId: string } | null {
	const marker = "/.santree/worktrees/";
	const idx = cwd.indexOf(marker);
	if (idx === -1) return null;

	const repoRoot = cwd.slice(0, idx);
	const rest = cwd.slice(idx + marker.length);
	const ticketId = rest.split("/")[0];
	if (!ticketId) return null;

	return { repoRoot, ticketId };
}

export function renameTmuxWindow(ticketId: string, state: SessionStateValue): void {
	const mux = getMultiplexer();
	if (!mux.isActive()) return;

	let name: string;
	switch (state) {
		case "waiting":
			name = `${ticketId} !`;
			break;
		case "idle":
			name = `${ticketId} ~`;
			break;
		default:
			name = ticketId;
			break;
	}

	mux.renameWindow("", name);
}

export function runHookScript(
	repoRoot: string,
	state: SessionStateValue,
	env: Record<string, string>,
): void {
	const script = path.join(repoRoot, ".santree", "hooks", `on-${state}.sh`);
	try {
		fs.accessSync(script, fs.constants.X_OK);
	} catch {
		return;
	}
	const child = spawn(script, [], {
		cwd: env.SANTREE_WORKTREE_PATH,
		env: { ...process.env, ...env },
		stdio: "ignore",
		detached: true,
	});
	child.unref();
}

/**
 * Unified helper: reads stdin, extracts repo/ticket, writes state file,
 * renames tmux window, runs hook script, then exits.
 */
export function signalState(state: SessionStateValue): void {
	const input = readStdin();
	let data: any;
	try {
		data = JSON.parse(input);
	} catch {
		process.exit(0);
	}

	const cwd = data.cwd || process.cwd();
	const info = extractRepoAndTicket(cwd);
	if (!info) {
		process.exit(0);
	}

	const { repoRoot, ticketId } = info;
	const statesDir = path.join(repoRoot, ".santree", "session-states");
	fs.mkdirSync(statesDir, { recursive: true });

	const stateFile = path.join(statesDir, `${ticketId}.json`);
	const payload = {
		state,
		message: state === "waiting" ? (data.message ?? null) : null,
		session_id: data.session_id ?? "",
		at: new Date().toISOString(),
	};

	fs.writeFileSync(stateFile, JSON.stringify(payload, null, 2) + "\n");

	renameTmuxWindow(ticketId, state);

	const worktreePath = path.join(repoRoot, ".santree", "worktrees", ticketId);
	runHookScript(repoRoot, state, {
		SANTREE_TICKET_ID: ticketId,
		SANTREE_SESSION_STATE: state,
		SANTREE_SESSION_ID: data.session_id ?? "",
		SANTREE_WORKTREE_PATH: worktreePath,
		SANTREE_REPO_ROOT: repoRoot,
		SANTREE_MESSAGE: payload.message ?? "",
	});

	process.exit(0);
}

export function getHooksJson(): Record<string, unknown> {
	const base = "santree helpers session-signal";
	const opts = { async: true, timeout: 10 };
	return {
		Notification: [
			{
				matcher: "permission_prompt",
				hooks: [{ type: "command", command: `${base} notification`, ...opts }],
			},
		],
		Stop: [{ hooks: [{ type: "command", command: `${base} stop`, ...opts }] }],
		UserPromptSubmit: [{ hooks: [{ type: "command", command: `${base} prompt`, ...opts }] }],
		SessionEnd: [{ hooks: [{ type: "command", command: `${base} end`, ...opts }] }],
	};
}

export function installHooks(): string {
	const home = process.env.HOME || "";
	const settingsPath = path.join(home, ".claude", "settings.json");

	let settings: Record<string, any> = {};
	try {
		if (fs.existsSync(settingsPath)) {
			settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		}
	} catch {
		// Start fresh if file is invalid
	}

	const requiredHooks = getHooksJson();
	const existingHooks: Record<string, any> = settings.hooks || {};

	for (const [event, hookEntries] of Object.entries(requiredHooks)) {
		const existing = existingHooks[event];
		if (!Array.isArray(existing)) {
			existingHooks[event] = hookEntries;
			continue;
		}
		// Remove existing session-signal entries, then add the current ones
		const filtered = existing.filter((entry: any) => {
			const inner = entry.hooks || [];
			return !inner.some(
				(h: any) => typeof h.command === "string" && h.command.includes("session-signal"),
			);
		});
		existingHooks[event] = [...filtered, ...(hookEntries as any[])];
	}

	settings.hooks = existingHooks;

	const claudeDir = path.join(home, ".claude");
	fs.mkdirSync(claudeDir, { recursive: true });

	fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
	return settingsPath;
}
