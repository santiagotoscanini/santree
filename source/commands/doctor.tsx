import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useState } from "react";
import { exec, execSync } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import { findMainRepoRoot, getSantreeDir, getInitScriptPath } from "../lib/git.js";
import { getAuthStatus, getValidTokens } from "../lib/linear.js";

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
};

type LinearAuthCheckStatus = {
	authenticated: boolean;
	orgSlug?: string;
	orgName?: string;
	tokenValid?: boolean;
	repoLinked?: boolean;
	hint?: string;
};

type StatuslineStatus = {
	claudeSettingsConfigured: boolean;
	currentCommand?: string;
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
 * Checks GitHub CLI auth status using JSON output.
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
	const authJson = await tryExec("gh auth status --json hosts 2>/dev/null");

	let authStatus: string | undefined;

	if (authJson) {
		try {
			const auth = JSON.parse(authJson);
			const githubHosts = auth.hosts?.["github.com"];
			const activeAccount = githubHosts?.find((h: { active: boolean }) => h.active);

			if (activeAccount?.login) {
				authStatus = `Authenticated as ${activeAccount.login}`;
			}
		} catch {
			// JSON parse failed, auth might not be configured
		}
	}

	if (!authStatus) {
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
		authStatus,
	};
}

/**
 * Checks Linear API authentication status.
 */
async function checkLinearAuth(): Promise<LinearAuthCheckStatus> {
	const repoRoot = findMainRepoRoot();
	const status = getAuthStatus(repoRoot);

	if (!status.authenticated || !status.orgSlug) {
		return {
			authenticated: false,
			hint: "Run: santree linear auth",
		};
	}

	// Try to validate/refresh tokens
	const valid = await getValidTokens(status.orgSlug);

	return {
		authenticated: true,
		orgSlug: status.orgSlug,
		orgName: status.orgName,
		tokenValid: valid !== null,
		repoLinked: status.repoLinked,
		hint: !valid
			? "Token expired. Run: santree linear auth"
			: !status.repoLinked
				? "Repo not linked. Run: santree linear auth"
				: undefined,
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
					<Text dimColor>Path: {tool.path}</Text>
					{tool.authStatus && <Text dimColor>Auth: {tool.authStatus}</Text>}
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

function LinearRow({ linear }: { linear: LinearAuthCheckStatus }) {
	const isOk = linear.authenticated && linear.tokenValid && linear.repoLinked;

	return (
		<Box flexDirection="column" marginBottom={1}>
			<Box>
				<StatusIcon ok={!!isOk} required={true} />
				<Text> </Text>
				<Text bold>Linear API</Text>
				<Text dimColor> - Linear ticket integration</Text>
			</Box>
			{linear.authenticated ? (
				<Box marginLeft={2} flexDirection="column">
					<Text dimColor>
						Organization: {linear.orgName} ({linear.orgSlug})
					</Text>
					<Text dimColor>Token: {linear.tokenValid ? "valid" : "expired"}</Text>
					<Text dimColor>Repo linked: {linear.repoLinked ? "yes" : "no"}</Text>
					{linear.hint && <Text color="yellow">↳ {linear.hint}</Text>}
				</Box>
			) : (
				<Box marginLeft={2}>
					<Text color="yellow">↳ {linear.hint}</Text>
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
	const [linear, setLinear] = useState<LinearAuthCheckStatus | null>(null);
	const [shellStatus, setShellStatus] = useState<{
		configured: boolean;
		shell: string | null;
	} | null>(null);
	const [statusline, setStatusline] = useState<StatuslineStatus | null>(null);
	const [santreeSetup, setSantreeSetup] = useState<SantreeSetupStatus | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		async function runChecks() {
			const results = await Promise.all([
				checkTool(
					"git",
					"Version control",
					true,
					"git --version | head -1",
					"Install: brew install git",
				),
				checkGhAuth(),
				checkTool("tmux", "Terminal multiplexer", false, "tmux -V", "Install: brew install tmux"),
				checkTool(
					"claude",
					"Claude Code CLI",
					true,
					"claude --version 2>/dev/null | head -1",
					"Install: npm install -g @anthropic-ai/claude-code",
				),
				checkTool(
					"happy",
					"Claude CLI wrapper (used over claude if installed)",
					false,
					"happy --version 2>/dev/null || echo 'installed'",
					"Install: npm install -g happy-coder",
				),
			]);

			// Check for either code or cursor (only need one)
			const [codeCheck, cursorCheck] = await Promise.all([
				checkTool("code", "VSCode editor", false, "code --version | head -1", ""),
				checkTool("cursor", "Cursor editor", false, "cursor --version | head -1", ""),
			]);
			if (codeCheck.installed) {
				results.push({ ...codeCheck, description: "Editor (VSCode)" });
			} else if (cursorCheck.installed) {
				results.push({ ...cursorCheck, description: "Editor (Cursor)" });
			} else {
				results.push({
					name: "code/cursor",
					description: "Editor (VSCode or Cursor)",
					required: false,
					installed: false,
					hint: "Install VSCode (https://code.visualstudio.com) or Cursor (https://cursor.sh)",
				});
			}

			const linearResult = await checkLinearAuth();
			const statuslineResult = await checkStatusline();

			setTools(results);
			setLinear(linearResult);
			setShellStatus(checkShellIntegration());
			setStatusline(statuslineResult);
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
	const linearOk = linear?.authenticated && linear?.tokenValid && linear?.repoLinked;
	const allRequired = requiredMissing.length === 0 && linearOk && shellStatus?.configured;

	return (
		<Box flexDirection="column" padding={1}>
			<Box marginBottom={1}>
				<Text bold color="cyan">
					Santree Doctor
				</Text>
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

			{linear && <LinearRow linear={linear} />}
			{shellStatus && <ShellRow configured={shellStatus.configured} shell={shellStatus.shell} />}
			{santreeSetup && <SantreeSetupRow status={santreeSetup} />}

			<Box marginBottom={1} marginTop={1} flexDirection="column">
				<Text bold underline>
					Aesthetics
				</Text>
			</Box>

			{statusline && <StatuslineRow status={statusline} />}

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
							{requiredMissing.length + (linearOk ? 0 : 1) + (shellStatus?.configured ? 0 : 1)}{" "}
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
