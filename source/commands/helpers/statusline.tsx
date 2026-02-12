import { useEffect, useRef } from "react";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

export const description = "Statusline wrapper for Claude Code";

// ANSI color codes
const c = {
	cyan: "\x1b[01;36m",
	green: "\x1b[01;32m",
	yellow: "\x1b[01;33m",
	magenta: "\x1b[01;35m",
	red: "\x1b[01;31m",
	blue: "\x1b[01;34m",
	dim: "\x1b[02m",
	reset: "\x1b[00m",
};

// Read stdin synchronously
function readStdin(): string {
	try {
		return fs.readFileSync(0, "utf-8");
	} catch {
		return "";
	}
}

/**
 * Parse JSON input from Claude Code statusline hook.
 * See: https://code.claude.com/docs/en/statusline
 */
function parseInput(input: string) {
	try {
		const data = JSON.parse(input);
		return {
			cwd: data?.workspace?.current_dir || process.cwd(),
			model: data?.model?.display_name || null,
			usedPercentage: data?.context_window?.used_percentage ?? null,
		};
	} catch {
		return { cwd: process.cwd(), model: null, usedPercentage: null };
	}
}

// Run git command in directory
function git(cwd: string, args: string): string | null {
	try {
		return execSync(`git -C "${cwd}" --no-optional-locks ${args}`, {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

// Check if directory is a git repo
function isGitRepo(cwd: string): boolean {
	try {
		execSync(`git -C "${cwd}" rev-parse --git-dir`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

// Check if directory is a worktree (not main repo)
function isWorktree(cwd: string): boolean {
	try {
		const gitDir = execSync(`git -C "${cwd}" rev-parse --git-dir`, {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "ignore"],
		}).trim();
		const gitCommonDir = execSync(`git -C "${cwd}" rev-parse --git-common-dir`, {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "ignore"],
		}).trim();
		return path.resolve(cwd, gitDir) !== path.resolve(cwd, gitCommonDir);
	} catch {
		return false;
	}
}

// Check if directory is a santree-managed worktree
function isSantreeWorktree(cwd: string): boolean {
	return cwd.includes("/.santree/worktrees/");
}

// Extract ticket ID from branch name (e.g., feature/TEAM-123-desc -> TEAM-123)
function extractTicketId(branch: string): string | null {
	const match = branch.match(/([a-zA-Z]+)-(\d+)/);
	return match ? `${match[1]!.toUpperCase()}-${match[2]}` : null;
}

// Extract description from branch name (e.g., feature/TEAM-123-add-auth -> add-auth)
function extractDescription(branch: string): string | null {
	// Remove prefix like feature/, fix/, etc.
	const withoutPrefix = branch.replace(/^[^/]+\//, "");
	// Remove ticket ID pattern and get the rest
	const match = withoutPrefix.match(/[a-zA-Z]+-\d+-(.+)/);
	return match ? match[1]!.replace(/-/g, " ") : null;
}

// Count lines in output
function countLines(output: string | null): number {
	if (!output) return 0;
	return output.split("\n").filter(Boolean).length;
}

// Get git changes summary
function getGitChanges(cwd: string): {
	staged: number;
	unstaged: number;
	untracked: number;
} {
	return {
		staged: countLines(git(cwd, "diff --cached --name-only")),
		unstaged: countLines(git(cwd, "diff --name-only")),
		untracked: countLines(git(cwd, "ls-files --others --exclude-standard")),
	};
}

// Format changes compactly
function formatChanges(changes: { staged: number; unstaged: number; untracked: number }): string {
	const parts: string[] = [];
	if (changes.staged > 0) parts.push(`${c.green}+${changes.staged}${c.reset}`);
	if (changes.unstaged > 0) parts.push(`${c.yellow}~${changes.unstaged}${c.reset}`);
	if (changes.untracked > 0) parts.push(`${c.red}?${changes.untracked}${c.reset}`);
	return parts.length > 0 ? parts.join(" ") : `${c.dim}clean${c.reset}`;
}

// Build statusline for santree worktree
function buildSantreeStatusline(
	cwd: string,
	model: string | null,
	usedPercentage: number | null,
): string {
	const parts: string[] = [];
	const branch = git(cwd, "rev-parse --abbrev-ref HEAD") || "unknown";

	// Ticket ID (prominent)
	const ticketId = extractTicketId(branch);
	if (ticketId) {
		parts.push(`${c.magenta}${ticketId}${c.reset}`);
	}

	// Description or branch
	const description = extractDescription(branch);
	if (description) {
		parts.push(`${c.cyan}${description}${c.reset}`);
	} else {
		parts.push(`${c.cyan}${branch}${c.reset}`);
	}

	// Git changes
	const changes = getGitChanges(cwd);
	parts.push(formatChanges(changes));

	// Model
	if (model) {
		parts.push(`${c.blue}${model}${c.reset}`);
	}

	// Usable context % (accounting for 80% auto-compact threshold)
	if (usedPercentage !== null) {
		const usable = Math.round(usedPercentage * 1.25);
		const color = usable >= 80 ? c.red : usable >= 60 ? c.yellow : c.green;
		parts.push(`${color}${usable}%${c.reset}`);
	}

	return parts.join(" | ");
}

// Build statusline for regular git repo
function buildGitStatusline(
	cwd: string,
	model: string | null,
	usedPercentage: number | null,
): string {
	const parts: string[] = [];

	// Repo name
	const home = process.env.HOME || "";
	const repoName = cwd.replace(`${home}/repos/`, "").replace(home, "~");
	parts.push(`${c.cyan}${repoName}${c.reset}`);

	// Branch
	const branch = git(cwd, "rev-parse --abbrev-ref HEAD") || "unknown";
	parts.push(`${c.green}${branch}${c.reset}`);

	// Git changes
	const changes = getGitChanges(cwd);
	parts.push(formatChanges(changes));

	// Model
	if (model) {
		parts.push(`${c.blue}${model}${c.reset}`);
	}

	// Usable context %
	if (usedPercentage !== null) {
		const usable = Math.round(usedPercentage * 1.25);
		const color = usable >= 80 ? c.red : usable >= 60 ? c.yellow : c.green;
		parts.push(`${color}${usable}%${c.reset}`);
	}

	return parts.join(" | ");
}

// Build statusline for non-git directory
function buildPlainStatusline(
	cwd: string,
	model: string | null,
	usedPercentage: number | null,
): string {
	const parts: string[] = [];

	// Directory
	const home = process.env.HOME || "";
	parts.push(`${c.cyan}${cwd.replace(home, "~")}${c.reset}`);

	// Model
	if (model) {
		parts.push(`${c.blue}${model}${c.reset}`);
	}

	// Usable context %
	if (usedPercentage !== null) {
		const usable = Math.round(usedPercentage * 1.25);
		const color = usable >= 80 ? c.red : usable >= 60 ? c.yellow : c.green;
		parts.push(`${color}${usable}%${c.reset}`);
	}

	return parts.join(" | ");
}

export default function Statusline() {
	const hasRun = useRef(false);

	useEffect(() => {
		if (hasRun.current) return;
		hasRun.current = true;

		const input = readStdin();
		const { cwd, model, usedPercentage } = parseInput(input);

		let output: string;

		if (!isGitRepo(cwd)) {
			// Not a git repo
			output = buildPlainStatusline(cwd, model, usedPercentage);
		} else if (isWorktree(cwd) && isSantreeWorktree(cwd)) {
			output = buildSantreeStatusline(cwd, model, usedPercentage);
		} else {
			// Regular git repo
			output = buildGitStatusline(cwd, model, usedPercentage);
		}

		process.stdout.write(output);
		process.exit(0);
	}, []);

	return null;
}
