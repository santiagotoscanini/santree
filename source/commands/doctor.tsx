import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useState } from "react";
import { exec, execSync } from "child_process";
import { promisify } from "util";
import { createRequire } from "module";
import * as fs from "fs";
import * as path from "path";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json");
import { findMainRepoRoot, getSantreeDir, getInitScriptPath } from "../lib/git.js";
import { getIssueTracker } from "../lib/trackers/index.js";
import type { IssueTracker } from "../lib/trackers/types.js";
import { getMultiplexer } from "../lib/multiplexer/index.js";
import { resolveClaudeBinary } from "../lib/ai.js";
import {
	CURRENT_VERSION,
	CLAUDE_CODE_PACKAGE,
	SANTREE_PACKAGE,
	getLatestVersionFor,
	isUpdateAvailable,
	detectPackageManager,
	getInstallCommandFor,
} from "../lib/version.js";

const execAsync = promisify(exec);

export const description = "Check system requirements and integrations";

type ToolStatus = {
	name: string;
	description: string;
	required: boolean;
	installed: boolean;
	version?: string;
	path?: string;
	authStatus?: string;
	hint?: string;
	latestVersion?: string;
	updateHint?: string;
};

type TrackerCheckStatus = {
	displayName: string;
	authenticated: boolean;
	accountLabel?: string;
	expiresAt?: number;
	repoLinked?: boolean;
	hint?: string;
};

type RemoteControlStatus = {
	enabled: boolean;
	hint?: string;
};

type StatuslineStatus = {
	claudeSettingsConfigured: boolean;
	currentCommand?: string;
	hint?: string;
};

type SessionSignalStatus = {
	configured: boolean;
	missingHooks: string[];
	hint?: string;
};

type EnglishTutorStatus = {
	configured: boolean;
	missingHooks: string[];
	missingPermission: boolean;
	hint?: string;
};

type SantreeSetupStatus = {
	isGitRepo: boolean;
	mainRepoRoot?: string;
	santreeFolderExists: boolean;
	initShExists: boolean;
	initShExecutable: boolean;
	worktreesIgnored: boolean;
	metadataIgnored: boolean;
	hints: string[];
};

/**
 * Executes a command asynchronously and returns the output, or null if it fails.
 */
async function tryExec(command: string): Promise<string | null> {
	try {
		const { stdout } = await execAsync(command);
		return stdout.trim();
	} catch {
		return null;
	}
}

/**
 * Gets the path of a command using `which`.
 */
async function getPath(command: string): Promise<string | null> {
	return tryExec(`which ${command}`);
}

/**
 * Checks if a tool is installed and gets its version.
 */
async function checkTool(
	name: string,
	description: string,
	required: boolean,
	versionCommand: string,
	hint: string,
): Promise<ToolStatus> {
	const path = await getPath(name);

	if (!path) {
		return {
			name,
			description,
			required,
			installed: false,
			hint,
		};
	}

	const version = await tryExec(versionCommand);

	return {
		name,
		description,
		required,
		installed: true,
		version: version || "unknown",
		path,
	};
}

/**
 * Reports the active multiplexer (tmux/cmux/none) and verifies the underlying
 * binary is reachable. Detection is auto — each adapter's `isActive()` checks
 * its own runtime env (`$TMUX`, `$CMUX_SURFACE_ID`).
 */
async function checkMultiplexer(): Promise<ToolStatus> {
	const mux = getMultiplexer();
	const description = `Multiplexer (active: ${mux.kind})`;

	if (mux.kind === "none") {
		return {
			name: "multiplexer",
			description,
			required: false,
			installed: false,
			hint: "Run inside tmux or cmux to enable session window renaming. Install tmux: brew install tmux",
		};
	}

	if (mux.kind === "tmux") {
		const path = await getPath("tmux");
		if (!path) {
			return {
				name: "tmux",
				description,
				required: false,
				installed: false,
				hint: "Install: brew install tmux",
			};
		}
		const version = await tryExec("tmux -V");
		return {
			name: "tmux",
			description,
			required: false,
			installed: true,
			version: version || "unknown",
			path,
		};
	}

	// cmux
	const path = await getPath("cmux");
	if (!path) {
		return {
			name: "cmux",
			description,
			required: false,
			installed: false,
			hint: "Install cmux.app from https://cmux.com (cmux is macOS-only).",
		};
	}
	const version = await tryExec("cmux --version 2>/dev/null");
	const ping = await tryExec("cmux ping 2>/dev/null");
	// Note: cmux #1472 (programmatic workspaces with dead PTYs) is a real
	// limitation but only surfaces when a specific dashboard flow tries to
	// auto-execute a command in a freshly-created workspace. Showing it on
	// every doctor run made cmux look broken when it isn't — the limitation
	// is documented in CLAUDE.md and the README. We only flag a hint here
	// when cmux is actually unreachable.
	return {
		name: "cmux",
		description,
		required: false,
		installed: !!ping,
		version: version || "unknown",
		path,
		hint: !ping ? "cmux app not reachable — open cmux.app." : undefined,
	};
}

/**
 * Checks the Claude CLI, preferring cmux's bundled binary when running inside
 * cmux. The standard `checkTool` uses `which claude` which can't locate the
 * cmux shim at /Applications/cmux.app/Contents/Resources/bin/claude — that
 * binary isn't on PATH. See manaflow-ai/cmux#2048.
 */
async function checkClaude(): Promise<ToolStatus> {
	const resolved = resolveClaudeBinary();
	const usingBundled = resolved?.startsWith("/Applications/cmux.app/") ?? false;
	const inCmux = getMultiplexer().kind === "cmux";
	const description = usingBundled ? "Claude Code CLI (cmux-bundled)" : "Claude Code CLI";

	if (!resolved) {
		return {
			name: "claude",
			description,
			required: true,
			installed: false,
			hint: inCmux
				? "Open cmux.app to install its bundled Claude, or install standalone: npm install -g @anthropic-ai/claude-code"
				: "Install: npm install -g @anthropic-ai/claude-code",
		};
	}

	const version = await tryExec(`"${resolved}" --version 2>/dev/null | head -1`);
	return {
		name: "claude",
		description,
		required: true,
		installed: true,
		version: version || "unknown",
		path: resolved,
	};
}

/**
 * Checks GitHub CLI auth status.
 * Uses `gh api user` which works across all gh versions.
 */
async function checkGhAuth(): Promise<ToolStatus> {
	const path = await getPath("gh");

	if (!path) {
		return {
			name: "gh",
			description: "GitHub CLI for PR operations",
			required: true,
			installed: false,
			hint: "Install: brew install gh && gh auth login",
		};
	}

	const version = await tryExec("gh --version | head -1");
	const login = await tryExec("gh api user --jq .login 2>/dev/null");

	if (!login) {
		return {
			name: "gh",
			description: "GitHub CLI for PR operations",
			required: true,
			installed: true,
			version: version || "unknown",
			path,
			hint: "Run: gh auth login",
		};
	}

	return {
		name: "gh",
		description: "GitHub CLI for PR operations",
		required: true,
		installed: true,
		version: version || "unknown",
		path,
		authStatus: `Authenticated as ${login}`,
	};
}

/**
 * Checks the active issue tracker's auth state. The tracker (Linear, GitHub)
 * is resolved from the repo's `_tracker` config (or env / auto-detect).
 * Doctor is the one place that legitimately names the active tracker — it's
 * diagnostic context, not a generic UI string.
 */
async function checkTrackerAuth(): Promise<TrackerCheckStatus> {
	const repoRoot = findMainRepoRoot();
	const tracker: IssueTracker = getIssueTracker(repoRoot);
	const status = await tracker.getAuthStatus(repoRoot);
	return {
		displayName: tracker.displayName,
		authenticated: status.authenticated,
		accountLabel: status.accountLabel,
		expiresAt: status.expiresAt,
		repoLinked: status.repoLinked,
		hint: status.hint,
	};
}

/**
 * Checks if the shell integration is set up by looking for the
 * SANTREE_SHELL_INTEGRATION environment variable exported by the shell scripts.
 */
function checkShellIntegration(): {
	configured: boolean;
	shell: string | null;
} {
	const shell = process.env.SHELL || "";
	const shellName = shell.includes("zsh") ? "zsh" : shell.includes("bash") ? "bash" : null;

	const configured = process.env.SANTREE_SHELL_INTEGRATION === "1";

	return { configured, shell: shellName };
}

/**
 * Checks if Claude Code Remote Control is enabled for all sessions.
 * Remote Control lets you continue local sessions from any device.
 *
 * This reads from ~/.claude.json (the "global config" / application state file),
 * which is separate from ~/.claude/settings.json (the declarative settings file).
 * See: https://code.claude.com/docs/en/settings#settings-files
 */
function checkRemoteControl(): RemoteControlStatus {
	const home = process.env.HOME || "";
	const configPath = path.join(home, ".claude.json");

	try {
		if (fs.existsSync(configPath)) {
			const content = fs.readFileSync(configPath, "utf-8");
			const config = JSON.parse(content);

			if (config.remoteControlAtStartup === true) {
				return { enabled: true };
			}
		}
	} catch {
		// JSON parse error or file read error
	}

	return {
		enabled: false,
		hint: 'Run /config in Claude Code and enable "Enable Remote Control for all sessions"',
	};
}

/**
 * Checks statusline configuration:
 * If ~/.claude/settings.json has statusLine pointing to santree
 */
async function checkStatusline(): Promise<StatuslineStatus> {
	const home = process.env.HOME || "";
	const claudeSettingsPath = path.join(home, ".claude", "settings.json");

	let claudeSettingsConfigured = false;
	let currentCommand: string | undefined;

	try {
		if (fs.existsSync(claudeSettingsPath)) {
			const content = fs.readFileSync(claudeSettingsPath, "utf-8");
			const settings = JSON.parse(content);

			if (settings.statusLine?.command) {
				currentCommand = String(settings.statusLine.command);
				// Check if it points to santree statusline
				claudeSettingsConfigured =
					currentCommand.includes("santree statusline") ||
					currentCommand.includes("santree helpers statusline");
			}
		}
	} catch {
		// JSON parse error or file read error
	}

	let hint: string | undefined;
	if (!claudeSettingsConfigured) {
		hint =
			'Add to ~/.claude/settings.json: "statusLine": { "type": "command", "command": "santree helpers statusline" }';
	}

	return {
		claudeSettingsConfigured,
		currentCommand,
		hint,
	};
}

/**
 * Checks if session-signal hooks are configured in ~/.claude/settings.json.
 * Looks for hooks on Notification, Stop, UserPromptSubmit, and SessionEnd
 * that run "santree helpers session-signal".
 */
function checkSessionSignalHooks(): SessionSignalStatus {
	const home = process.env.HOME || "";
	const claudeSettingsPath = path.join(home, ".claude", "settings.json");

	const requiredEvents = ["Notification", "Stop", "UserPromptSubmit", "SessionEnd"];
	const missingHooks: string[] = [];

	try {
		if (fs.existsSync(claudeSettingsPath)) {
			const content = fs.readFileSync(claudeSettingsPath, "utf-8");
			const settings = JSON.parse(content);
			const hooks = settings.hooks || {};

			for (const event of requiredEvents) {
				const eventHooks = hooks[event];
				if (!Array.isArray(eventHooks)) {
					missingHooks.push(event);
					continue;
				}
				// Check if any hook entry has a nested hook command containing session-signal
				const found = eventHooks.some((entry: any) => {
					const innerHooks = entry.hooks || [];
					return innerHooks.some(
						(h: any) => typeof h.command === "string" && h.command.includes("session-signal"),
					);
				});
				if (!found) missingHooks.push(event);
			}
		} else {
			missingHooks.push(...requiredEvents);
		}
	} catch {
		missingHooks.push(...requiredEvents);
	}

	if (missingHooks.length === 0) {
		return { configured: true, missingHooks: [] };
	}

	return {
		configured: false,
		missingHooks,
		hint: `Missing: ${missingHooks.join(", ")}. Run: santree helpers session-signal install`,
	};
}

/**
 * Checks if english-tutor hooks are configured. Verifies the UserPromptSubmit
 * and SessionStart hooks plus the scoped Edit permission for the practice log.
 */
function checkEnglishTutorHooks(): EnglishTutorStatus {
	const home = process.env.HOME || "";
	const claudeSettingsPath = path.join(home, ".claude", "settings.json");

	const requiredEvents = ["UserPromptSubmit", "SessionStart"];
	const missingHooks: string[] = [];
	let missingPermission = true;

	const configDir = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
	const expectedPermission = `Edit(${path.join(configDir, "santree", "english-practice-log.md")})`;

	try {
		if (fs.existsSync(claudeSettingsPath)) {
			const settings = JSON.parse(fs.readFileSync(claudeSettingsPath, "utf-8"));
			const hooks = settings.hooks || {};

			for (const event of requiredEvents) {
				const eventHooks = hooks[event];
				if (!Array.isArray(eventHooks)) {
					missingHooks.push(event);
					continue;
				}
				const found = eventHooks.some((entry: any) => {
					const innerHooks = entry.hooks || [];
					return innerHooks.some(
						(h: any) => typeof h.command === "string" && h.command.includes("english-tutor"),
					);
				});
				if (!found) missingHooks.push(event);
			}

			const allow = settings.permissions?.allow;
			if (Array.isArray(allow) && allow.includes(expectedPermission)) {
				missingPermission = false;
			}
		} else {
			missingHooks.push(...requiredEvents);
		}
	} catch {
		missingHooks.push(...requiredEvents);
	}

	if (missingHooks.length === 0 && !missingPermission) {
		return { configured: true, missingHooks: [], missingPermission: false };
	}

	return {
		configured: false,
		missingHooks,
		missingPermission,
		hint: "Run: santree helpers english-tutor install",
	};
}

/**
 * Checks if a path is gitignored (via .gitignore or .git/info/exclude).
 */
function isGitIgnored(filePath: string, cwd: string): boolean {
	try {
		execSync(`git check-ignore -q "${filePath}"`, { cwd, stdio: "ignore" });
		return true; // exit 0 = ignored
	} catch {
		return false; // exit 1 = not ignored
	}
}

/**
 * Checks if the current directory is a git repo and if .santree/init.sh exists and is executable.
 */
function checkSantreeSetup(): SantreeSetupStatus {
	const mainRepoRoot = findMainRepoRoot();

	if (!mainRepoRoot) {
		return {
			isGitRepo: false,
			santreeFolderExists: false,
			initShExists: false,
			initShExecutable: false,
			worktreesIgnored: false,
			metadataIgnored: false,
			hints: ["Not in a git repository"],
		};
	}

	const santreeDir = getSantreeDir(mainRepoRoot);
	const initShPath = getInitScriptPath(mainRepoRoot);

	const santreeFolderExists = fs.existsSync(santreeDir);
	const initShExists = fs.existsSync(initShPath);

	let initShExecutable = false;
	if (initShExists) {
		try {
			fs.accessSync(initShPath, fs.constants.X_OK);
			initShExecutable = true;
		} catch {
			initShExecutable = false;
		}
	}

	// Check gitignore status (use relative paths for git check-ignore)
	const worktreesIgnored = isGitIgnored(".santree/worktrees", mainRepoRoot);
	const metadataIgnored = isGitIgnored(".santree/metadata.json", mainRepoRoot);

	const hints: string[] = [];
	if (!santreeFolderExists) {
		hints.push(`Create .santree folder: mkdir ${santreeDir}`);
	} else if (!initShExists) {
		hints.push(`Create init.sh: touch ${initShPath} && chmod +x ${initShPath}`);
	} else if (!initShExecutable) {
		hints.push(`Make init.sh executable: chmod +x ${initShPath}`);
	}

	if (!worktreesIgnored) {
		hints.push("Add .santree/worktrees to .gitignore");
	}
	if (!metadataIgnored) {
		hints.push("Add .santree/metadata.json to .gitignore");
	}

	return {
		isGitRepo: true,
		mainRepoRoot,
		santreeFolderExists,
		initShExists,
		initShExecutable,
		worktreesIgnored,
		metadataIgnored,
		hints,
	};
}

function StatusIcon({ ok, required }: { ok: boolean; required: boolean }) {
	if (ok) {
		return <Text color="green">✓</Text>;
	}
	return required ? <Text color="red">✗</Text> : <Text color="yellow">○</Text>;
}

function ToolRow({ tool }: { tool: ToolStatus }) {
	return (
		<Box flexDirection="column" marginBottom={1}>
			<Box>
				<StatusIcon ok={tool.installed && !tool.hint} required={tool.required} />
				<Text> </Text>
				<Text bold>{tool.name}</Text>
				<Text dimColor> - {tool.description}</Text>
				{!tool.required && <Text dimColor> (optional)</Text>}
			</Box>
			{tool.installed ? (
				<Box marginLeft={2} flexDirection="column">
					<Text dimColor>Version: {tool.version}</Text>
					{tool.latestVersion && tool.version && (
						<Text
							color={isUpdateAvailable(tool.version, tool.latestVersion) ? "yellow" : undefined}
							dimColor={!isUpdateAvailable(tool.version, tool.latestVersion)}
						>
							Latest: {tool.latestVersion}
							{isUpdateAvailable(tool.version, tool.latestVersion) ? " ⬆ update available" : ""}
						</Text>
					)}
					{tool.path && <Text dimColor>Path: {tool.path}</Text>}
					{tool.authStatus && <Text dimColor>Auth: {tool.authStatus}</Text>}
					{tool.updateHint && <Text color="yellow">↳ {tool.updateHint}</Text>}
					{tool.hint && <Text color="yellow">↳ {tool.hint}</Text>}
				</Box>
			) : (
				<Box marginLeft={2}>
					<Text color="yellow">↳ {tool.hint}</Text>
				</Box>
			)}
		</Box>
	);
}

function TrackerRow({ tracker }: { tracker: TrackerCheckStatus }) {
	const isOk = tracker.authenticated && !tracker.hint;
	return (
		<Box flexDirection="column" marginBottom={1}>
			<Box>
				<StatusIcon ok={isOk} required={true} />
				<Text> </Text>
				<Text bold>{tracker.displayName} API</Text>
				<Text dimColor> - Issue tracker integration</Text>
			</Box>
			{tracker.authenticated ? (
				<Box marginLeft={2} flexDirection="column">
					{tracker.accountLabel && <Text dimColor>Account: {tracker.accountLabel}</Text>}
					{tracker.repoLinked !== undefined && (
						<Text dimColor>Repo linked: {tracker.repoLinked ? "yes" : "no"}</Text>
					)}
					{tracker.hint && <Text color="yellow">↳ {tracker.hint}</Text>}
				</Box>
			) : (
				<Box marginLeft={2}>
					<Text color="yellow">↳ {tracker.hint}</Text>
				</Box>
			)}
		</Box>
	);
}

function ShellRow({ configured, shell }: { configured: boolean; shell: string | null }) {
	return (
		<Box flexDirection="column" marginBottom={1}>
			<Box>
				<StatusIcon ok={configured} required={true} />
				<Text> </Text>
				<Text bold>Shell Integration</Text>
				<Text dimColor> - Enables directory switching</Text>
			</Box>
			{configured ? (
				<Box marginLeft={2}>
					<Text dimColor>Shell: {shell}</Text>
				</Box>
			) : (
				<Box marginLeft={2}>
					<Text color="yellow">
						↳ Add to .{shell}rc: eval "$(santree helpers shell-init {shell})"
					</Text>
				</Box>
			)}
		</Box>
	);
}

function StatuslineRow({ status }: { status: StatuslineStatus }) {
	return (
		<Box flexDirection="column" marginBottom={1}>
			<Box>
				<StatusIcon ok={status.claudeSettingsConfigured} required={false} />
				<Text> </Text>
				<Text bold>Claude Statusline</Text>
				<Text dimColor> - Custom statusline in Claude Code</Text>
				<Text dimColor> (optional)</Text>
			</Box>
			<Box marginLeft={2} flexDirection="column">
				{status.currentCommand ? (
					<Text dimColor>Command: {status.currentCommand}</Text>
				) : (
					<Text dimColor>Command: not configured</Text>
				)}
				{status.hint && <Text color="yellow">↳ {status.hint}</Text>}
			</Box>
		</Box>
	);
}

function RemoteControlRow({ status }: { status: RemoteControlStatus }) {
	return (
		<Box flexDirection="column" marginBottom={1}>
			<Box>
				<StatusIcon ok={status.enabled} required={false} />
				<Text> </Text>
				<Text bold>Remote Control</Text>
				<Text dimColor> - Continue sessions from any device</Text>
				<Text dimColor> (optional)</Text>
			</Box>
			<Box marginLeft={2} flexDirection="column">
				<Text dimColor>Enabled: {status.enabled ? "yes" : "no"}</Text>
				{status.hint && <Text color="yellow">↳ {status.hint}</Text>}
			</Box>
		</Box>
	);
}

function SessionSignalRow({ status }: { status: SessionSignalStatus }) {
	return (
		<Box flexDirection="column" marginBottom={1}>
			<Box>
				<StatusIcon ok={status.configured} required={false} />
				<Text> </Text>
				<Text bold>Session Signal Hooks</Text>
				<Text dimColor> - Surface session state in dashboard/tmux</Text>
				<Text dimColor> (optional)</Text>
			</Box>
			<Box marginLeft={2} flexDirection="column">
				{status.configured ? (
					<Text dimColor>All hooks configured</Text>
				) : (
					<>
						<Text dimColor>Missing: {status.missingHooks.join(", ")}</Text>
						{status.hint && <Text color="yellow">↳ {status.hint}</Text>}
					</>
				)}
			</Box>
		</Box>
	);
}

function EnglishTutorRow({ status }: { status: EnglishTutorStatus }) {
	const missingParts: string[] = [];
	if (status.missingHooks.length > 0) missingParts.push(`hooks: ${status.missingHooks.join(", ")}`);
	if (status.missingPermission) missingParts.push("log Edit permission");
	return (
		<Box flexDirection="column" marginBottom={1}>
			<Box>
				<StatusIcon ok={status.configured} required={false} />
				<Text> </Text>
				<Text bold>English Tutor Hooks</Text>
				<Text dimColor> - Inline grammar corrections</Text>
				<Text dimColor> (optional)</Text>
			</Box>
			<Box marginLeft={2} flexDirection="column">
				{status.configured ? (
					<Text dimColor>Hooks and log permission configured</Text>
				) : (
					<>
						<Text dimColor>Missing: {missingParts.join("; ") || "—"}</Text>
						{status.hint && <Text color="yellow">↳ {status.hint}</Text>}
					</>
				)}
			</Box>
		</Box>
	);
}

function SantreeSetupRow({ status }: { status: SantreeSetupStatus }) {
	const isOk =
		status.santreeFolderExists &&
		status.initShExists &&
		status.initShExecutable &&
		status.worktreesIgnored &&
		status.metadataIgnored;

	if (!status.isGitRepo) {
		return (
			<Box flexDirection="column" marginBottom={1}>
				<Box>
					<StatusIcon ok={false} required={false} />
					<Text> </Text>
					<Text bold>Repository Setup</Text>
					<Text dimColor> - .santree configuration</Text>
					<Text dimColor> (optional)</Text>
				</Box>
				<Box marginLeft={2}>
					<Text dimColor>Not in a git repository</Text>
				</Box>
			</Box>
		);
	}

	return (
		<Box flexDirection="column" marginBottom={1}>
			<Box>
				<StatusIcon ok={isOk} required={false} />
				<Text> </Text>
				<Text bold>Repository Setup</Text>
				<Text dimColor> - .santree configuration</Text>
				<Text dimColor> (optional)</Text>
			</Box>
			<Box marginLeft={2} flexDirection="column">
				<Text dimColor>Main repo: {status.mainRepoRoot}</Text>
				<Text dimColor>.santree folder: {status.santreeFolderExists ? "exists" : "missing"}</Text>
				{status.santreeFolderExists && (
					<Text dimColor>
						init.sh:{" "}
						{status.initShExists
							? status.initShExecutable
								? "executable"
								: "not executable"
							: "missing"}
					</Text>
				)}
				<Text dimColor>.santree/worktrees ignored: {status.worktreesIgnored ? "yes" : "no"}</Text>
				<Text dimColor>
					.santree/metadata.json ignored: {status.metadataIgnored ? "yes" : "no"}
				</Text>
				{status.hints.map((hint, i) => (
					<Text key={i} color="yellow">
						↳ {hint}
					</Text>
				))}
			</Box>
		</Box>
	);
}

export default function Doctor() {
	const [tools, setTools] = useState<ToolStatus[]>([]);
	const [tracker, setTracker] = useState<TrackerCheckStatus | null>(null);
	const [shellStatus, setShellStatus] = useState<{
		configured: boolean;
		shell: string | null;
	} | null>(null);
	const [remoteControl, setRemoteControl] = useState<RemoteControlStatus | null>(null);
	const [statusline, setStatusline] = useState<StatuslineStatus | null>(null);
	const [sessionSignal, setSessionSignal] = useState<SessionSignalStatus | null>(null);
	const [englishTutor, setEnglishTutor] = useState<EnglishTutorStatus | null>(null);
	const [santreeSetup, setSantreeSetup] = useState<SantreeSetupStatus | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		async function runChecks() {
			const pm = detectPackageManager();

			const [results, latestSantree, latestClaude] = await Promise.all([
				Promise.all([
					checkTool(
						"git",
						"Version control",
						true,
						"git --version | head -1",
						"Install: brew install git",
					),
					checkGhAuth(),
					checkMultiplexer(),
					checkClaude(),
				]),
				getLatestVersionFor(SANTREE_PACKAGE),
				getLatestVersionFor(CLAUDE_CODE_PACKAGE),
			]);

			// Synthetic row for santree itself — surfaces update status.
			const santreeRow: ToolStatus = {
				name: "santree",
				description: "Santree CLI (this app)",
				required: true,
				installed: true,
				version: CURRENT_VERSION,
				latestVersion: latestSantree ?? undefined,
				updateHint:
					latestSantree && isUpdateAvailable(CURRENT_VERSION, latestSantree)
						? "Run: santree update"
						: undefined,
			};
			results.unshift(santreeRow);

			// Augment the claude row with latest-version info from npm registry.
			// When the resolved binary is the cmux-bundled one, npm install can't
			// update it — the bundled binary is shipped inside cmux.app. Show a
			// cmux-aware hint instead of the generic npm command.
			const claudeRow = results.find((r) => r.name === "claude");
			if (claudeRow && claudeRow.installed && latestClaude) {
				claudeRow.latestVersion = latestClaude;
				if (claudeRow.version && isUpdateAvailable(claudeRow.version, latestClaude)) {
					const isCmuxBundled = !!claudeRow.path?.includes("/cmux.app/");
					if (isCmuxBundled) {
						claudeRow.updateHint = "Bundled with cmux — update cmux.app to get the latest Claude.";
					} else {
						const cmd = getInstallCommandFor(pm, `${CLAUDE_CODE_PACKAGE}@latest`);
						claudeRow.updateHint = `Run: ${cmd.display}`;
					}
				}
			}

			// Optional: a syntax-highlighting diff pager — used by `st worktree diff`
			// and the dashboard `v` overlay when SANTREE_DIFF_TOOL is set. Any
			// diff pager works (delta, diff-so-fancy, …); without one set, the
			// dashboard renders inline with santree's own colorizer and the CLI
			// falls back to git's default pager. Delta is the most popular
			// choice so we check for it as a convenience, but it is never a
			// hard dependency.
			const deltaCheck = await checkTool(
				"delta",
				"Recommended diff pager — any diff pager works",
				false,
				"delta --version | head -1",
				"Optional — santree's built-in colorizer handles the dashboard overlay; the CLI falls back to git's default pager. Set SANTREE_DIFF_TOOL to override. To install delta: brew install git-delta",
			);
			results.push(deltaCheck);

			// Optional: a `.code-workspace`-aware editor (VSCode or Cursor).
			// Santree itself works with any editor via $SANTREE_EDITOR — this
			// check exists only because the dashboard's `E workspace` shortcut
			// needs an editor that understands `.code-workspace` files. Missing
			// here just means the shortcut is hidden; everything else still works.
			const workspaceEditorDesc = "Workspace editor (`E workspace` shortcut)";
			const [codeCheck, cursorCheck] = await Promise.all([
				checkTool("code", workspaceEditorDesc, false, "code --version | head -1", ""),
				checkTool("cursor", workspaceEditorDesc, false, "cursor --version | head -1", ""),
			]);
			if (codeCheck.installed) {
				results.push(codeCheck);
			} else if (cursorCheck.installed) {
				results.push(cursorCheck);
			} else {
				results.push({
					name: "code/cursor",
					description: workspaceEditorDesc,
					required: false,
					installed: false,
					hint: "Optional — santree works with any $SANTREE_EDITOR. Only needed for the dashboard's `.code-workspace` shortcut.",
				});
			}

			const trackerResult = await checkTrackerAuth();
			const statuslineResult = await checkStatusline();

			setTools(results);
			setTracker(trackerResult);
			setShellStatus(checkShellIntegration());
			setRemoteControl(checkRemoteControl());
			setStatusline(statuslineResult);
			setSessionSignal(checkSessionSignalHooks());
			setEnglishTutor(checkEnglishTutorHooks());
			setSantreeSetup(checkSantreeSetup());
			setLoading(false);
		}

		runChecks();
	}, []);

	if (loading) {
		return (
			<Box>
				<Text color="cyan">
					<Spinner type="dots" />
				</Text>
				<Text> Checking system requirements...</Text>
			</Box>
		);
	}

	const requiredMissing = tools.filter((t) => t.required && (!t.installed || t.hint));
	const optionalMissing = tools.filter((t) => !t.required && !t.installed);
	const trackerOk = tracker?.authenticated && !tracker?.hint;
	const allRequired = requiredMissing.length === 0 && trackerOk && shellStatus?.configured;

	return (
		<Box flexDirection="column" padding={1}>
			<Box marginBottom={1}>
				<Text bold color="cyan">
					Santree Doctor
				</Text>
				<Text dimColor> v{version}</Text>
			</Box>

			<Box marginBottom={1} flexDirection="column">
				<Text bold underline>
					CLI Tools
				</Text>
			</Box>

			{tools.map((tool) => (
				<ToolRow key={tool.name} tool={tool} />
			))}

			<Box marginBottom={1} marginTop={1} flexDirection="column">
				<Text bold underline>
					Integrations
				</Text>
			</Box>

			{tracker && <TrackerRow tracker={tracker} />}
			{shellStatus && <ShellRow configured={shellStatus.configured} shell={shellStatus.shell} />}
			{santreeSetup && <SantreeSetupRow status={santreeSetup} />}

			<Box marginBottom={1} marginTop={1} flexDirection="column">
				<Text bold underline>
					Claude Code
				</Text>
			</Box>

			{remoteControl && <RemoteControlRow status={remoteControl} />}
			{statusline && <StatuslineRow status={statusline} />}
			{sessionSignal && <SessionSignalRow status={sessionSignal} />}
			{englishTutor && <EnglishTutorRow status={englishTutor} />}

			<Box
				marginTop={1}
				borderStyle="single"
				borderColor={allRequired ? "green" : "yellow"}
				paddingX={2}
			>
				{allRequired ? (
					<Text color="green">All requirements satisfied! Santree is ready to use.</Text>
				) : (
					<Box flexDirection="column">
						<Text color="yellow">
							{requiredMissing.length + (trackerOk ? 0 : 1) + (shellStatus?.configured ? 0 : 1)}{" "}
							required item(s) need attention
						</Text>
						{optionalMissing.length > 0 && (
							<Text dimColor>{optionalMissing.length} optional item(s) not installed</Text>
						)}
					</Box>
				)}
			</Box>
		</Box>
	);
}
