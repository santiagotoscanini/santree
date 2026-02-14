import { execSync, exec } from "child_process";
import { promisify } from "util";
import { run, runAsync } from "./exec.js";

const execAsync = promisify(exec);

export interface PRInfo {
	number: string;
	state: "OPEN" | "MERGED" | "CLOSED";
	url?: string;
}

/**
 * Get PR info for a branch using the GitHub CLI (async).
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
 * Fetch CI check results for a pull request (async).
 */
export async function getPRChecksAsync(prNumber: string): Promise<PRCheck[] | null> {
	const output = await runAsync(
		`gh pr checks ${prNumber} --json name,state,bucket,link,description,workflow`,
	);
	if (!output) return null;
	try {
		return JSON.parse(output);
	} catch {
		return null;
	}
}

/**
 * Fetch reviews for a pull request (async).
 */
export async function getPRReviewsAsync(prNumber: string): Promise<PRReview[] | null> {
	const output = await runAsync(`gh pr view ${prNumber} --json reviews`);
	if (!output) return null;
	try {
		const data = JSON.parse(output);
		return data.reviews ?? null;
	} catch {
		return null;
	}
}

/**
 * Fetch inline review comments for a pull request via the GitHub API (async).
 */
export async function getPRReviewCommentsAsync(
	prNumber: string,
): Promise<PRReviewComment[] | null> {
	const output = await runAsync(
		`gh api repos/{owner}/{repo}/pulls/${prNumber}/comments --paginate`,
	);
	if (!output) return null;
	try {
		return JSON.parse(output);
	} catch {
		return null;
	}
}

/**
 * Fetch structured conversation comments on a pull request (async).
 */
export async function getPRConversationCommentsAsync(
	prNumber: string,
): Promise<PRConversationComment[] | null> {
	const output = await runAsync(`gh pr view ${prNumber} --json comments`);
	if (!output) return null;
	try {
		const data = JSON.parse(output);
		return (data.comments ?? []).map((c: any) => ({
			author: c.author?.login ?? "unknown",
			body: c.body ?? "",
			createdAt: c.createdAt ?? "",
		}));
	} catch {
		return null;
	}
}

/**
 * Fetch details for a failed CI check (async): which step failed and the failed step's log.
 */
export async function getFailedCheckDetailsAsync(check: PRCheck): Promise<FailedCheckDetail> {
	const detail: FailedCheckDetail = {
		name: check.name,
		workflow: check.workflow,
		description: check.description,
		link: check.link,
		failed_step: null,
		log: null,
	};

	const urlMatch = check.link?.match(/job\/(\d+)/);
	if (!urlMatch) return detail;
	const jobId = urlMatch[1];

	let stepStartMs = 0;
	let stepEndMs = 0;

	const jobOutput = await runAsync(`gh api repos/{owner}/{repo}/actions/jobs/${jobId}`);
	if (jobOutput) {
		try {
			const job = JSON.parse(jobOutput);
			const failedStep = job.steps?.find((s: any) => s.conclusion === "failure");
			if (failedStep) {
				detail.failed_step = failedStep.name;
				stepStartMs = new Date(failedStep.started_at).getTime();
				stepEndMs = new Date(failedStep.completed_at).getTime() + 999;
			}
		} catch {}
	}

	if (!stepStartMs) return detail;

	const logOutput = await runAsync(
		`gh api repos/{owner}/{repo}/actions/jobs/${jobId}/logs 2>/dev/null`,
	);
	if (logOutput) {
		const lines = logOutput.split("\n");
		const stepLines = lines.filter((line) => {
			const m = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/);
			if (!m) return false;
			const ms = new Date(m[1]!).getTime();
			return ms >= stepStartMs && ms <= stepEndMs;
		});
		const errorIdx = stepLines.findIndex((l) => l.includes("##[error]"));
		const bounded = errorIdx !== -1 ? stepLines.slice(0, errorIdx) : stepLines;
		const segments: string[][] = [];
		let current: string[] = [];
		let inGroup = false;
		for (const raw of bounded) {
			const line = raw.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, "");
			if (line.startsWith("##[group]")) {
				if (current.length) {
					segments.push(current);
					current = [];
				}
				inGroup = true;
				continue;
			}
			if (line.startsWith("##[endgroup]")) {
				inGroup = false;
				continue;
			}
			if (line.startsWith("##[")) continue;
			if (!inGroup) current.push(line);
		}
		if (current.length) segments.push(current);
		if (segments.length) detail.log = segments[segments.length - 1]!.join("\n");
	}

	return detail;
}

export interface PRConversationComment {
	author: string;
	body: string;
	createdAt: string;
}

export interface PRCheck {
	name: string;
	state: string;
	bucket: string;
	link: string;
	description: string;
	workflow: string;
}

export interface FailedCheckDetail {
	name: string;
	workflow: string;
	description: string;
	link: string;
	failed_step: string | null;
	log: string | null;
}

export interface PRReview {
	author: { login: string };
	state: string;
	body: string;
	submittedAt: string;
}

export interface PRReviewComment {
	user: { login: string };
	body: string;
	path: string;
	line: number | null;
	original_line: number | null;
	diff_hunk: string;
	created_at: string;
	in_reply_to_id?: number;
	id: number;
}
