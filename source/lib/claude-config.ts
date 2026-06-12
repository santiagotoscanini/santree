import * as fs from "fs";
import * as path from "path";

/**
 * Shared read/detect/configure helpers for the two Claude Code config files
 * santree touches:
 *   - ~/.claude/settings.json   (statusline + hooks)
 *   - ~/.claude.json            (remote control)
 *
 * Both `santree doctor` (detect) and `santree setup` (configure) go through
 * here so the two commands can never disagree about what "configured" means.
 */

const STATUSLINE_COMMAND = "santree helpers statusline";

export function claudeSettingsPath(): string {
	return path.join(process.env.HOME || "", ".claude", "settings.json");
}

export function claudeConfigPath(): string {
	return path.join(process.env.HOME || "", ".claude.json");
}

export function readJsonSafe(filePath: string): Record<string, any> {
	try {
		if (fs.existsSync(filePath)) {
			return JSON.parse(fs.readFileSync(filePath, "utf-8"));
		}
	} catch {
		// Invalid/unreadable — caller decides whether to start fresh.
	}
	return {};
}

function writeJson(filePath: string, data: Record<string, any>): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

// ── Statusline ───────────────────────────────────────────────────────────────

export function getStatuslineCommand(): string | undefined {
	const settings = readJsonSafe(claudeSettingsPath());
	const cmd = settings.statusLine?.command;
	return cmd ? String(cmd) : undefined;
}

export function isStatuslineConfigured(): boolean {
	const cmd = getStatuslineCommand();
	return (
		!!cmd && (cmd.includes("santree statusline") || cmd.includes("santree helpers statusline"))
	);
}

export function configureStatusline(): string {
	const settingsPath = claudeSettingsPath();
	const settings = readJsonSafe(settingsPath);
	settings.statusLine = { type: "command", command: STATUSLINE_COMMAND };
	writeJson(settingsPath, settings);
	return settingsPath;
}

// ── Remote control ────────────────────────────────────────────────────────────

export function isRemoteControlEnabled(): boolean {
	return readJsonSafe(claudeConfigPath()).remoteControlAtStartup === true;
}

export function enableRemoteControl(): string {
	const configPath = claudeConfigPath();
	const config = readJsonSafe(configPath);
	config.remoteControlAtStartup = true;
	writeJson(configPath, config);
	return configPath;
}

// ── Session-signal hooks ──────────────────────────────────────────────────────

export const SESSION_SIGNAL_EVENTS = ["Notification", "Stop", "UserPromptSubmit", "SessionEnd"];

/** Returns the session-signal events that are NOT yet wired in settings.json. */
export function missingSessionSignalHooks(): string[] {
	const settings = readJsonSafe(claudeSettingsPath());
	const hooks = settings.hooks || {};
	const missing: string[] = [];
	for (const event of SESSION_SIGNAL_EVENTS) {
		const eventHooks = hooks[event];
		if (!Array.isArray(eventHooks)) {
			missing.push(event);
			continue;
		}
		const found = eventHooks.some((entry: any) => {
			const inner = entry.hooks || [];
			return inner.some(
				(h: any) => typeof h.command === "string" && h.command.includes("session-signal"),
			);
		});
		if (!found) missing.push(event);
	}
	return missing;
}

export function isSessionSignalConfigured(): boolean {
	return missingSessionSignalHooks().length === 0;
}
