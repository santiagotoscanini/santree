import { execSync, exec } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as fs from "fs";
import { run } from "./exec.js";

const execAsync = promisify(exec);

export interface Worktree {
	path: string;
	branch: string;
	commit: string;
	isBare: boolean;
}

/**
 * Find the toplevel directory of the current git repository.
 * Runs: `git rev-parse --show-toplevel`
 * Returns null if not inside a git repo.
 */
export function findRepoRoot(): string | null {
	return run("git rev-parse --show-toplevel");
}

/**
 * Find the root of the main (non-worktree) repository by resolving --git-common-dir.
 * Runs: `git rev-parse --git-common-dir`
 * Returns null if not inside a git repo.
 */
export function findMainRepoRoot(): string | null {
	const gitCommonDir = run("git rev-parse --git-common-dir");
	if (!gitCommonDir) return null;
	return path.dirname(path.resolve(gitCommonDir));
}

/**
 * Check whether the current working directory is inside a git worktree (not the main repo).
 * Compares `git rev-parse --git-dir` vs `--git-common-dir` — they differ inside a worktree.
 * Returns false if not in a git repo or if in the main repo.
 */
export function isInWorktree(): boolean {
	const gitDir = run("git rev-parse --git-dir");
	const gitCommonDir = run("git rev-parse --git-common-dir");
	if (!gitDir || !gitCommonDir) return false;
	return path.resolve(gitDir) !== path.resolve(gitCommonDir);
}

/**
 * Check whether a given path is a git worktree (not a main repo checkout).
 * Runs: `git rev-parse --git-dir` and `--git-common-dir` with cwd set to wtPath.
 * Returns false if the path is not a git repo or is the main repo.
 */
export function isWorktreePath(wtPath: string): boolean {
	const gitDir = run("git rev-parse --git-dir", { cwd: wtPath });
	const gitCommonDir = run("git rev-parse --git-common-dir", { cwd: wtPath });
	if (!gitDir || !gitCommonDir) return false;
	return path.resolve(wtPath, gitDir) !== path.resolve(wtPath, gitCommonDir);
}

/**
 * Get the name of the currently checked-out branch.
 * Runs: `git rev-parse --abbrev-ref HEAD`
 * Returns null if in detached HEAD state or not in a git repo.
 */
export function getCurrentBranch(): string | null {
	return run("git rev-parse --abbrev-ref HEAD");
}

/**
 * Determine the default branch (e.g. main or master) for the origin remote.
 * Runs: `git symbolic-ref refs/remotes/origin/HEAD`
 * Falls back to checking if "main" or "master" branches exist locally.
 * Returns "main" as a last resort.
 */
export function getDefaultBranch(): string {
	const ref = run("git symbolic-ref refs/remotes/origin/HEAD");
	if (ref) return ref.replace("refs/remotes/origin/", "");

	// Fall back to checking if main/master exists
	for (const branch of ["main", "master"]) {
		try {
			execSync(`git rev-parse --verify refs/heads/${branch}`, {
				stdio: "ignore",
			});
			return branch;
		} catch {
			continue;
		}
	}
	return "main";
}

/**
 * List all git worktrees in the current repository.
 * Runs: `git worktree list --porcelain`
 * Returns an empty array on failure.
 */
export function listWorktrees(): Worktree[] {
	const output = run("git worktree list --porcelain");
	if (!output) return [];

	const worktrees: Worktree[] = [];
	let current: Partial<Worktree> = {};

	for (const line of output.split("\n")) {
		if (line.startsWith("worktree ")) {
			current.path = line.replace("worktree ", "");
		} else if (line.startsWith("HEAD ")) {
			current.commit = line.replace("HEAD ", "").slice(0, 8);
		} else if (line.startsWith("branch ")) {
			current.branch = line.replace("branch refs/heads/", "");
		} else if (line === "bare") {
			current.isBare = true;
		} else if (line === "" && current.path) {
			worktrees.push(current as Worktree);
			current = {};
		}
	}

	if (current.path) {
		worktrees.push(current as Worktree);
	}

	return worktrees;
}

/**
 * Get the path to the .santree directory inside a repo root.
 */
export function getSantreeDir(repoRoot: string): string {
	return path.join(repoRoot, ".santree");
}

/**
 * Get the path to the .santree/worktrees directory inside a repo root.
 */
export function getWorktreesDir(repoRoot: string): string {
	return path.join(getSantreeDir(repoRoot), "worktrees");
}

/**
 * Create a new git worktree for a branch, optionally creating the branch from a base.
 * The worktree directory is named after the ticket ID extracted from the branch name.
 * Runs: `git worktree add [-b branchName] <path> <branch|baseBranch>`
 * Returns { success: false, error } if no ticket ID found, path already exists, or git fails.
 */
export async function createWorktree(
	branchName: string,
	baseBranch: string,
	repoRoot: string,
): Promise<{ success: boolean; path?: string; error?: string }> {
	const ticketId = extractTicketId(branchName);
	if (!ticketId) {
		return {
			success: false,
			error: "No ticket ID found in branch name (expected pattern like TEAM-123)",
		};
	}
	const dirName = ticketId;
	const worktreesDir = getWorktreesDir(repoRoot);
	const worktreePath = path.join(worktreesDir, dirName);

	if (fs.existsSync(worktreePath)) {
		return {
			success: false,
			error: `Worktree already exists at ${worktreePath}`,
		};
	}

	// Ensure worktrees directory exists
	fs.mkdirSync(worktreesDir, { recursive: true });

	// Check if branch exists
	let branchExists = false;
	try {
		execSync(`git rev-parse --verify refs/heads/${branchName}`, {
			cwd: repoRoot,
			stdio: "ignore",
		});
		branchExists = true;
	} catch {
		branchExists = false;
	}

	try {
		if (branchExists) {
			await execAsync(`git worktree add "${worktreePath}" "${branchName}"`, {
				cwd: repoRoot,
			});
		} else {
			await execAsync(`git worktree add -b "${branchName}" "${worktreePath}" "${baseBranch}"`, {
				cwd: repoRoot,
			});
		}

		// Save metadata (only when base branch differs from default)
		if (baseBranch !== getDefaultBranch() && ticketId) {
			const all = readAllMetadata(repoRoot);
			all[ticketId] = { base_branch: baseBranch };
			writeAllMetadata(repoRoot, all);
		}

		return { success: true, path: worktreePath };
	} catch (e) {
		return {
			success: false,
			error: e instanceof Error ? e.message : "Unknown error",
		};
	}
}

/**
 * Remove a git worktree by branch name, cleaning up the directory and optionally deleting the branch.
 * Runs: `git worktree remove [--force] <path>` then `git branch -d|-D <branchName>`
 * Returns { success: false, error } if worktree not found or git fails.
 */
export async function removeWorktree(
	branchName: string,
	repoRoot: string,
	force = false,
): Promise<{ success: boolean; error?: string }> {
	// Find the worktree by branch name using git's worktree tracking
	const worktreePath = getWorktreePath(branchName);

	if (!worktreePath) {
		return { success: false, error: `Worktree not found: ${branchName}` };
	}

	try {
		const forceFlag = force ? "--force" : "";
		await execAsync(`git worktree remove ${forceFlag} "${worktreePath}"`, {
			cwd: repoRoot,
		});

		// Clean up any remaining files (untracked files, node_modules, etc.)
		// git worktree remove doesn't delete untracked files
		if (fs.existsSync(worktreePath)) {
			// Fix permissions first (node_modules often has restricted perms)
			try {
				execSync(`chmod -R u+w "${worktreePath}"`, { stdio: "ignore" });
			} catch {
				// Ignore chmod errors
			}
			fs.rmSync(worktreePath, { recursive: true, force: true });
		}

		// Clean up centralized metadata entry
		const ticketId = extractTicketId(branchName);
		if (ticketId) {
			const all = readAllMetadata(repoRoot);
			if (all[ticketId]) {
				delete all[ticketId];
				writeAllMetadata(repoRoot, all);
			}
		}

		// Also delete the branch
		const deleteFlag = force ? "-D" : "-d";
		try {
			await execAsync(`git branch ${deleteFlag} "${branchName}"`, {
				cwd: repoRoot,
			});
		} catch {
			// Branch deletion failed, but worktree was removed
		}

		return { success: true };
	} catch (e) {
		return {
			success: false,
			error: e instanceof Error ? e.message : "Unknown error",
		};
	}
}

/**
 * Extract a ticket ID (e.g. "TEAM-123") from a branch name.
 * Matches the first occurrence of LETTERS-DIGITS in the string.
 * Returns null if no ticket ID pattern is found.
 */
export function extractTicketId(branch: string): string | null {
	const match = branch.match(/([a-zA-Z]+)-(\d+)/);
	if (match) {
		return `${match[1]!.toUpperCase()}-${match[2]}`;
	}
	return null;
}

/**
 * Get the filesystem path for a worktree by its branch name.
 * Uses `git worktree list --porcelain` under the hood.
 * Returns null if no worktree is checked out on that branch.
 */
export function getWorktreePath(branchName: string): string | null {
	const worktrees = listWorktrees();
	const wt = worktrees.find((w) => w.branch === branchName);
	return wt?.path ?? null;
}

/**
 * Get path to centralized metadata file: .santree/metadata.json in the repo root.
 */
function getMetadataFilePath(repoRoot: string): string {
	return path.join(getSantreeDir(repoRoot), "metadata.json");
}

/**
 * Read all entries from .santree/metadata.json.
 * Returns an empty object if the file doesn't exist or can't be parsed.
 */
export function readAllMetadata(repoRoot: string): Record<string, any> {
	const filePath = getMetadataFilePath(repoRoot);
	if (!fs.existsSync(filePath)) return {};
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch {
		return {};
	}
}

/**
 * Write all entries to .santree/metadata.json.
 */
export function writeAllMetadata(repoRoot: string, data: Record<string, any>): void {
	const filePath = getMetadataFilePath(repoRoot);
	const dir = path.dirname(filePath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

/**
 * Get the Linear org slug associated with this repo.
 * Stored as `_linear.org` in .santree/metadata.json.
 */
export function getRepoLinearOrg(repoRoot: string): string | null {
	const all = readAllMetadata(repoRoot);
	return all._linear?.org ?? null;
}

/**
 * Associate a Linear org slug with this repo.
 * Stored as `_linear.org` in .santree/metadata.json.
 */
export function setRepoLinearOrg(repoRoot: string, orgSlug: string): void {
	const all = readAllMetadata(repoRoot);
	all._linear = { org: orgSlug };
	writeAllMetadata(repoRoot, all);
}

/**
 * Get the base branch for a given branch name.
 * Looks up metadata first, falls back to the default branch.
 */
export function getBaseBranch(branchName: string): string {
	const metadata = getWorktreeMetadata(branchName);
	return metadata?.base_branch ?? getDefaultBranch();
}

/**
 * Look up worktree metadata by branch name from centralized .santree/metadata.json.
 * Returns null if no metadata found (caller should fall back to default branch).
 */
export function getWorktreeMetadata(branchName: string): { base_branch: string } | null {
	const repoRoot = findMainRepoRoot();
	if (!repoRoot) return null;

	const ticketId = extractTicketId(branchName);
	if (!ticketId) return null;

	const all = readAllMetadata(repoRoot);
	return all[ticketId] ?? null;
}

/**
 * Check if there are any uncommitted changes (staged or unstaged).
 * Runs: `git status --porcelain`
 * Returns false if not in a git repo.
 */
export function hasUncommittedChanges(): boolean {
	const output = run("git status --porcelain");
	return output !== null && output !== "";
}

/**
 * Check if there are staged changes ready to commit.
 * Runs: `git diff --cached --quiet` (exits non-zero if there are staged changes).
 * Returns false if not in a git repo.
 */
export function hasStagedChanges(): boolean {
	try {
		execSync("git diff --cached --quiet", { stdio: "ignore" });
		return false;
	} catch {
		return true;
	}
}

/**
 * Check if there are unstaged modifications or untracked files.
 * Runs: `git diff --quiet` and `git ls-files --others --exclude-standard`
 * Returns false if not in a git repo.
 */
export function hasUnstagedChanges(): boolean {
	try {
		// Check for modified files
		try {
			execSync("git diff --quiet", { stdio: "ignore" });
		} catch {
			return true;
		}
		// Check for untracked files
		const output = run("git ls-files --others --exclude-standard");
		return output !== null && output !== "";
	} catch {
		return false;
	}
}

/**
 * Get a short summary of the working tree status.
 * Runs: `git status --short`
 * Returns empty string on failure.
 */
export function getGitStatus(): string {
	return run("git status --short") ?? "";
}

/**
 * Get a diffstat of staged changes.
 * Runs: `git diff --cached --stat`
 * Returns empty string on failure.
 */
export function getStagedDiffStat(): string {
	return run("git diff --cached --stat") ?? "";
}

/**
 * Count how many commits the current branch is behind origin/baseBranch.
 * Runs: `git rev-list --count HEAD..origin/<baseBranch>`
 * Returns 0 on failure.
 */
export function getCommitsBehind(baseBranch: string): number {
	const output = run(`git rev-list --count HEAD..origin/${baseBranch}`);
	return output ? parseInt(output, 10) || 0 : 0;
}

/**
 * Count how many commits the current branch is ahead of baseBranch.
 * Runs: `git rev-list --count <baseBranch>..HEAD`
 * Returns 0 on failure.
 */
export function getCommitsAhead(baseBranch: string): number {
	const output = run(`git rev-list --count ${baseBranch}..HEAD`);
	return output ? parseInt(output, 10) || 0 : 0;
}

/**
 * Check if a branch exists on the remote (origin).
 * Runs: `git ls-remote --heads origin <branchName>`
 * Returns false on failure.
 */
export function remoteBranchExists(branchName: string): boolean {
	const output = run(`git ls-remote --heads origin ${branchName}`);
	return output !== null && output.includes(branchName);
}

/**
 * Count how many local commits haven't been pushed to origin.
 * Runs: `git rev-list --count origin/<branchName>..HEAD`
 * If no remote tracking branch exists, counts all commits on HEAD.
 * Returns 0 on failure.
 */
export function getUnpushedCommits(branchName: string): number {
	try {
		// Check if remote tracking branch exists
		try {
			execSync(`git rev-parse --verify origin/${branchName}`, {
				stdio: "ignore",
			});
		} catch {
			// No remote branch, count all local commits
			const output = run("git rev-list --count HEAD");
			return output ? parseInt(output, 10) || 0 : 0;
		}

		// Count commits ahead of remote
		const output = run(`git rev-list --count origin/${branchName}..HEAD`);
		return output ? parseInt(output, 10) || 0 : 0;
	} catch {
		return 0;
	}
}

/**
 * Fetch from origin and pull the latest changes on a base branch.
 * Runs: `git fetch origin`, `git checkout <baseBranch>`, `git pull origin <baseBranch>`
 * Returns { success: false, message } if any step fails.
 */
export function pullLatest(
	baseBranch: string,
	repoRoot: string,
): { success: boolean; message: string } {
	try {
		// Fetch from origin
		execSync("git fetch origin", { cwd: repoRoot, stdio: "ignore" });

		// Update the base branch
		execSync(`git checkout ${baseBranch}`, { cwd: repoRoot, stdio: "ignore" });
		execSync(`git pull origin ${baseBranch}`, {
			cwd: repoRoot,
			stdio: "ignore",
		});

		return { success: true, message: "Fetched latest changes" };
	} catch (e) {
		return {
			success: false,
			message: e instanceof Error ? e.message : "Failed to pull latest",
		};
	}
}

/**
 * Check if a .santree/init.sh script exists in the repo.
 */
export function hasInitScript(repoRoot: string): boolean {
	const initScript = path.join(getSantreeDir(repoRoot), "init.sh");
	return fs.existsSync(initScript);
}

/**
 * Get the path to the .santree/init.sh script.
 */
export function getInitScriptPath(repoRoot: string): string {
	return path.join(getSantreeDir(repoRoot), "init.sh");
}

/**
 * Get the subject line of the latest commit.
 * Runs: `git log -1 --format=%s`
 * Returns null if not in a git repo or no commits.
 */
export function getLatestCommitMessage(): string | null {
	return run("git log -1 --format=%s");
}

/**
 * Get the subject line of the first commit on the current branch since baseBranch.
 * Runs: `git log <baseBranch>..HEAD --reverse --format=%s`
 * Returns null if there are no commits ahead of baseBranch.
 */
export function getFirstCommitMessage(baseBranch: string): string | null {
	const output = run(`git log ${baseBranch}..HEAD --reverse --format=%s`);
	if (!output) return null;
	const firstLine = output.split("\n")[0];
	return firstLine || null;
}

/**
 * Get a formatted commit log of all commits since baseBranch.
 * Runs: `git log <baseBranch>..HEAD --format="- %s"`
 * Returns null if there are no commits or on failure.
 */
export function getCommitLog(baseBranch: string): string | null {
	return run(`git log ${baseBranch}..HEAD --format="- %s"`) || null;
}

/**
 * Get a diffstat summary of all changes since baseBranch.
 * Runs: `git diff <baseBranch>..HEAD --stat`
 * Returns null if there are no changes or on failure.
 */
export function getDiffStat(baseBranch: string): string | null {
	return run(`git diff ${baseBranch}..HEAD --stat`) || null;
}

/**
 * Get the full diff of all changes since baseBranch.
 * Runs: `git diff <baseBranch>..HEAD`
 * Uses a 10MB max buffer for large diffs.
 * Returns null if there are no changes or on failure.
 */
export function getDiffContent(baseBranch: string): string | null {
	return run(`git diff ${baseBranch}..HEAD`, { maxBuffer: 10 * 1024 * 1024 }) || null;
}
