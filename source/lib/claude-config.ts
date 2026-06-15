import * as fs from "fs";
import * as path from "path";

/**
 * Shared read/detect/configure helpers for the two Claude Code config files
 * santree touches:
 *   - ~/.claude/settings.json   (statusline + hooks)
 *   - ~/.claude.json            (remote control)
 *
 * `santree config` (both the `--check` report and the interactive panel) goes
 * through here so detection and configuration can never disagree about what
 * "configured" means.
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

/**
 * Remove santree's statusline. Only clears `statusLine` when it's actually
 * pointing at santree — a user's hand-rolled statusline is left untouched.
 */
export function removeStatusline(): string {
	const settingsPath = claudeSettingsPath();
	if (!isStatuslineConfigured()) return settingsPath;
	const settings = readJsonSafe(settingsPath);
	delete settings.statusLine;
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

/** Revert remote-control to the default (off) by dropping the opt-in flag. */
export function disableRemoteControl(): string {
	const configPath = claudeConfigPath();
	const config = readJsonSafe(configPath);
	delete config.remoteControlAtStartup;
	writeJson(configPath, config);
	return configPath;
}

// ── Legacy cleanup ────────────────────────────────────────────────────────────

/**
 * Strip any leftover session-signal hook entries from settings.json. The
 * session-state feature (and its `santree helpers session-signal` command) was
 * removed, so these hooks now invoke a command that no longer exists and fire
 * on every Claude event. Removing them is always safe: we only touch entries
 * whose command mentions `session-signal`, leaving every other hook on the
 * shared events untouched. Returns the number of hook entries removed so
 * callers can report it. Self-healing: running `santree config` once cleans up
 * an existing install.
 */
export function pruneSessionSignalHooks(): number {
	const settingsPath = claudeSettingsPath();
	const settings = readJsonSafe(settingsPath);
	const hooks = settings.hooks;
	if (!hooks || typeof hooks !== "object") return 0;

	let removed = 0;
	for (const event of Object.keys(hooks)) {
		const arr = hooks[event];
		if (!Array.isArray(arr)) continue;
		const kept = arr.filter((entry: any) => {
			const inner = Array.isArray(entry.hooks) ? entry.hooks : [];
			const isSignal = inner.some(
				(h: any) => typeof h.command === "string" && h.command.includes("session-signal"),
			);
			if (isSignal) removed++;
			return !isSignal;
		});
		if (kept.length === 0) delete hooks[event];
		else hooks[event] = kept;
	}

	if (removed > 0) writeJson(settingsPath, settings);
	return removed;
}
