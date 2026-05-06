import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const MARKER = "english-tutor";

export function getLogPath(): string {
	const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
	return path.join(configDir, "santree", "english-practice-log.md");
}

export function getHooksJson(): Record<string, unknown> {
	const base = "santree helpers english-tutor";
	// Synchronous hooks: Claude Code waits for completion and injects stdout into
	// the model's context. `async: true` would fire-and-forget — stdout is
	// discarded, so the instruction would never reach Claude. session-signal can
	// use `async: true` because it only writes a state file; we cannot.
	const opts = { timeout: 10 };
	return {
		UserPromptSubmit: [{ hooks: [{ type: "command", command: `${base} prompt`, ...opts }] }],
		// No matcher: fires on all SessionStart sub-events (startup, resume,
		// clear, compact). Restricting to "startup" silently skips resumed
		// sessions, which is the common case when picking up yesterday's work.
		SessionStart: [{ hooks: [{ type: "command", command: `${base} session-start`, ...opts }] }],
	};
}

export function getPermissionEntry(): string {
	return `Edit(${getLogPath()})`;
}

function readSettings(settingsPath: string): Record<string, any> {
	try {
		if (fs.existsSync(settingsPath)) {
			return JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		}
	} catch {
		// fall through
	}
	return {};
}

function writeSettings(settingsPath: string, settings: Record<string, any>): void {
	const dir = path.dirname(settingsPath);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

function settingsPath(): string {
	const home = process.env.HOME || os.homedir();
	return path.join(home, ".claude", "settings.json");
}

function stripEnglishTutorHooks(existingHooks: Record<string, any>): Record<string, any> {
	const cleaned: Record<string, any> = {};
	for (const [event, entries] of Object.entries(existingHooks)) {
		if (!Array.isArray(entries)) {
			cleaned[event] = entries;
			continue;
		}
		const filtered = entries.filter((entry: any) => {
			const inner = entry.hooks || [];
			return !inner.some((h: any) => typeof h.command === "string" && h.command.includes(MARKER));
		});
		if (filtered.length > 0) cleaned[event] = filtered;
	}
	return cleaned;
}

/**
 * Create the practice log if it doesn't already exist. Empty log = Claude's
 * Edit tool fails on first use (Edit can't operate on missing files), and
 * appending corrections silently fails. Bootstrapping with a stub header
 * means the very first correction succeeds.
 */
function ensureLogExists(): string {
	const logPath = getLogPath();
	if (fs.existsSync(logPath)) return logPath;
	fs.mkdirSync(path.dirname(logPath), { recursive: true });
	const stub =
		"# English Practice Log\n\n" +
		"Tracks grammar/spelling mistakes spotted during Claude Code sessions.\n" +
		"Generated and appended to by santree's english-tutor hook.\n";
	fs.writeFileSync(logPath, stub);
	return logPath;
}

export function installHooks(): { settingsPath: string; logPath: string } {
	const settingsFile = settingsPath();
	const settings = readSettings(settingsFile);

	const existing = stripEnglishTutorHooks(settings.hooks || {});
	const required = getHooksJson();

	for (const [event, hookEntries] of Object.entries(required)) {
		const current = existing[event];
		existing[event] = Array.isArray(current)
			? [...current, ...(hookEntries as any[])]
			: (hookEntries as any[]);
	}
	settings.hooks = existing;

	const permissions = settings.permissions || {};
	const allow: string[] = Array.isArray(permissions.allow) ? permissions.allow : [];
	const entry = getPermissionEntry();
	if (!allow.includes(entry)) allow.push(entry);
	permissions.allow = allow;
	settings.permissions = permissions;

	writeSettings(settingsFile, settings);
	const logPath = ensureLogExists();
	return { settingsPath: settingsFile, logPath };
}

/**
 * Remove hooks and permission entry. Intentionally does NOT delete the log
 * file — that's the user's accumulated practice history.
 */
export function uninstallHooks(): string {
	const settingsFile = settingsPath();
	const settings = readSettings(settingsFile);

	if (settings.hooks) {
		settings.hooks = stripEnglishTutorHooks(settings.hooks);
	}

	if (settings.permissions && Array.isArray(settings.permissions.allow)) {
		const entry = getPermissionEntry();
		settings.permissions.allow = settings.permissions.allow.filter((e: string) => e !== entry);
	}

	writeSettings(settingsFile, settings);
	return settingsFile;
}

export function getInstallSnippet(): Record<string, unknown> {
	return {
		hooks: getHooksJson(),
		permissions: { allow: [getPermissionEntry()] },
	};
}
