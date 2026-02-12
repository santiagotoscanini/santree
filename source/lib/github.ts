import { execSync, exec } from "child_process";
import { promisify } from "util";
import { run } from "./exec.js";

const execAsync = promisify(exec);

export interface PRInfo {
	number: string;
	state: "OPEN" | "MERGED" | "CLOSED";
	url?: string;
}

/**
 * Get PR info (number, state, url) for a branch using the GitHub CLI.
 * Runs: `gh pr view "<branchName>" --json number,state,url`
 * Returns null if no PR exists for the branch or gh CLI fails.
 */
export function getPRInfo(branchName: string): PRInfo | null {
	const output = run(`gh pr view "${branchName}" --json number,state,url`);
	if (!output) return null;
	try {
		const data = JSON.parse(output);
		return {
			number: String(data.number ?? ""),
			state: data.state ?? "OPEN",
			url: data.url,
		};
	} catch {
		return null;
	}
}

/**
 * Async version of getPRInfo. Get PR info for a branch using the GitHub CLI.
 * Runs: `gh pr view "<branchName>" --json number,state,url`
 * Returns null if no PR exists for the branch or gh CLI fails.
 */
export async function getPRInfoAsync(branchName: string): Promise<PRInfo | null> {
	try {
		const { stdout } = await execAsync(`gh pr view "${branchName}" --json number,state,url`);
		const data = JSON.parse(stdout);
		return {
			number: String(data.number ?? ""),
			state: data.state ?? "OPEN",
			url: data.url,
		};
	} catch {
		return null;
	}
}

/**
 * Check if the GitHub CLI (gh) is available on PATH.
 * Runs: `which gh`
 * Returns false if gh is not installed.
 */
export function ghCliAvailable(): boolean {
	try {
		execSync("which gh", { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/**
 * Push a branch to origin, optionally with --force-with-lease.
 * Runs: `git push -u origin "<branchName>" [--force-with-lease]`
 * Uses stdio: "inherit" so push progress is shown to the user.
 * Returns false if the push fails.
 */
export function pushBranch(branchName: string, force = false): boolean {
	try {
		const forceFlag = force ? "--force-with-lease" : "";
		execSync(`git push -u origin "${branchName}" ${forceFlag}`.trim(), {
			stdio: "inherit",
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Create a GitHub pull request and open it in the browser.
 * Runs: `gh pr create --title "<title>" --base "<baseBranch>" --head "<headBranch>" --web [--body-file "<bodyFile>"]`
 * Uses stdio: "inherit" so the browser open is handled by gh.
 * Returns 0 on success, 1 on failure.
 */
export function createPR(
	title: string,
	baseBranch: string,
	headBranch: string,
	bodyFile?: string,
): number {
	try {
		const bodyFlag = bodyFile ? `--body-file "${bodyFile}"` : "";
		execSync(
			`gh pr create --title "${title}" --base "${baseBranch}" --head "${headBranch}" --web ${bodyFlag}`.trim(),
			{ stdio: "inherit" },
		);
		return 0;
	} catch {
		return 1;
	}
}

/**
 * Fetch the pull request template from the repo's .github/pull_request_template.md.
 * Runs: `gh api repos/{owner}/{repo}/contents/.github/pull_request_template.md --jq .content`
 * Returns the decoded template content, or null if none exists.
 */
export function getPRTemplate(): string | null {
	const output = run(
		`gh api repos/{owner}/{repo}/contents/.github/pull_request_template.md --jq .content`,
	);
	if (!output) return null;
	return Buffer.from(output, "base64").toString("utf-8");
}

/**
 * Fetch all comments on a pull request.
 * Runs: `gh pr view <prNumber> --json comments --jq '.comments[] | "- \(.author.login): \(.body)"'`
 * Returns empty string if the PR has no comments or on failure.
 */
export function getPRComments(prNumber: string): string {
	return (
		run(
			`gh pr view ${prNumber} --json comments --jq '.comments[] | "- \\(.author.login): \\(.body)"'`,
		) ?? ""
	);
}
