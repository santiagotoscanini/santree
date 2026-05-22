import * as fs from "fs";
import * as path from "path";

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

/**
 * Unified helper: reads stdin, extracts repo/ticket, writes the session-state
 * file, then exits. The dashboard reads the state file to render its session
 * badges (◆ waiting / active / idle, ◇ id-only). Window/tab renaming used to
 * happen here too but was removed — it clobbered names the user had set
 * manually and added little value once the state file was in place.
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
