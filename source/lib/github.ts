import { execSync, exec } from "child_process";
import { promisify } from "util";
import { run, runAsync } from "./exec.js";

const execAsync = promisify(exec);

export interface PRInfo {
	number: string;
	state: "OPEN" | "MERGED" | "CLOSED";
	isDraft: boolean;
	url?: string;
}

/**
 * Get PR info for a branch using the GitHub CLI (async).
 * Runs: `gh pr view "<branchName>" --json number,state,url,isDraft`
 * Returns null if no PR exists for the branch or gh CLI fails.
 */
export async function getPRInfoAsync(branchName: string): Promise<PRInfo | null> {
	try {
		const { stdout } = await execAsync(
			`gh pr view "${branchName}" --json number,state,url,isDraft`,
		);
		const data = JSON.parse(stdout);
		return {
			number: String(data.number ?? ""),
			state: data.state ?? "OPEN",
			isDraft: data.isDraft ?? false,
			url: data.url,
		};
	} catch {
		return null;
	}
}

/** GitHub's mergeability signals for a PR (subset we act on). */
export interface PRMergeState {
	/** "MERGEABLE" | "CONFLICTING" | "UNKNOWN" */
	mergeable: string;
	/** "BEHIND" | "BLOCKED" | "CLEAN" | "DIRTY" | "DRAFT" | "HAS_HOOKS" | "UNKNOWN" | "UNSTABLE" */
	mergeStateStatus: string;
	/** True when the branch has conflicts with its base that need resolving. */
	hasConflicts: boolean;
}

/**
 * Fetch a PR's mergeability for a branch. `CONFLICTING` (or a `DIRTY` merge-state)
 * means the branch conflicts with its base and needs a merge/resolve before CI can
 * pass. Returns null if no PR exists or gh fails. GitHub computes mergeability
 * asynchronously, so `mergeable` is `UNKNOWN` briefly after a push — callers should
 * treat `UNKNOWN` as "don't know yet", not "no conflicts".
 */
export async function getPRMergeStateAsync(branchName: string): Promise<PRMergeState | null> {
	try {
		const { stdout } = await execAsync(
			`gh pr view "${branchName}" --json mergeable,mergeStateStatus`,
		);
		const data = JSON.parse(stdout);
		const mergeable = String(data.mergeable ?? "UNKNOWN");
		const mergeStateStatus = String(data.mergeStateStatus ?? "UNKNOWN");
		return {
			mergeable,
			mergeStateStatus,
			hasConflicts: mergeable === "CONFLICTING" || mergeStateStatus === "DIRTY",
		};
	} catch {
		return null;
	}
}

/**
 * Classify a CI check as something an AI agent can plausibly fix on its own
 * ("fixable" — tests, types, lint, format, coverage) vs. one that needs a human or
 * infra ("manual" — deploys, releases, image builds, e2e, security scans). Matched
 * case-insensitively against the check's name + workflow. **Unknown ⇒ "manual"**:
 * the fix loop should only touch failures it's confident about and stop otherwise.
 * Extend the keyword lists as new check conventions appear (cf. HIDDEN_STATE_NAMES).
 */
// Trailing \b only (no leading boundary) so test-runner prefixes and plurals
// match: "pytest", "tests", "rspec", "codecov" all count as fixable.
export const FIXABLE_CHECK_PATTERN =
	/(tests?|specs?|jest|vitest|mocha|junit|phpunit|lint|format|prettier|eslint|ruff|black|gofmt|rustfmt|type[\s-]?check|tsc|mypy|pyright|coverage|cov)\b/i;
export const MANUAL_CHECK_PATTERN =
	/\b(deploy|release|publish|build[\s-]?image|docker|e2e|end[\s-]?to[\s-]?end|integration|smoke|terraform|infra|migrat|codeql|security|scan|sign|notariz)\b/i;

export function classifyCheck(check: Pick<PRCheck, "name" | "workflow">): "fixable" | "manual" {
	const haystack = `${check.name} ${check.workflow}`;
	// Manual wins ties: a "deploy tests" job is safer treated as manual.
	if (MANUAL_CHECK_PATTERN.test(haystack)) return "manual";
	if (FIXABLE_CHECK_PATTERN.test(haystack)) return "fixable";
	return "manual";
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
 * Fetch the pull request template from the repo.
 * Checks all standard locations and casings that GitHub supports:
 * .github/, docs/, and repo root — with both lowercase and uppercase filenames.
 * https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/creating-a-pull-request-template-for-your-repository
 * Returns the decoded template content, or null if none exists.
 */
export function getPRTemplate(): string | null {
	const paths = [
		".github/pull_request_template.md",
		".github/PULL_REQUEST_TEMPLATE.md",
		"docs/pull_request_template.md",
		"docs/PULL_REQUEST_TEMPLATE.md",
		"pull_request_template.md",
		"PULL_REQUEST_TEMPLATE.md",
	];
	for (const path of paths) {
		const output = run(`gh api repos/{owner}/{repo}/contents/${path} --jq .content`);
		if (output) {
			return Buffer.from(output, "base64").toString("utf-8");
		}
	}
	return null;
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

/** Per-process cache of the authenticated GitHub login (the "viewer"). */
let viewerLoginCache: Promise<string | null> | null = null;

/**
 * The authenticated GitHub user's login (GraphQL `viewer`). Cached per process.
 * Used to gate auto-applying a review comment on the PR owner's OWN 👍 — a
 * reviewer can't self-approve their comment for the fix loop.
 */
export function getViewerLoginAsync(): Promise<string | null> {
	if (viewerLoginCache) return viewerLoginCache;
	viewerLoginCache = (async () => {
		try {
			const { stdout } = await execAsync(
				`gh api graphql -f query='{ viewer { login } }' --jq .data.viewer.login`,
			);
			return stdout.trim() || null;
		} catch {
			return null;
		}
	})();
	return viewerLoginCache;
}

export interface PRReviewThreadComment {
	author: string;
	body: string;
	path: string | null;
	/** Current line, falling back to the original line for outdated comments. */
	line: number | null;
	diffHunk: string;
	createdAt: string;
	/** Logins of users who reacted 👍 (THUMBS_UP) to this comment. */
	thumbsUpBy: string[];
}

/** A PR review thread (an inline comment + its replies) with resolution state. */
export interface PRReviewThread {
	/** GraphQL node id — used to resolve the thread after the fix is applied. */
	id: string;
	isResolved: boolean;
	isOutdated: boolean;
	path: string | null;
	/** Anchor line in the current diff, falling back to the original line. */
	line: number | null;
	comments: PRReviewThreadComment[];
}

/**
 * Fetch a PR's review threads with resolution state and per-comment 👍 reactions.
 * The REST comments endpoint exposes neither, so this goes through GraphQL.
 * Returns null if the repo can't be resolved or gh fails.
 */
export async function getPRReviewThreadsAsync(prNumber: string): Promise<PRReviewThread[] | null> {
	const repo = await getRepoNameAsync();
	if (!repo) return null;
	const [owner, name] = repo.split("/");
	if (!owner || !name) return null;

	// Single-line query (GraphQL ignores whitespace); single-quoted for the shell.
	// `first` bounds keep us well under GitHub's query-complexity cap.
	const query =
		`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){` +
		`pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved isOutdated path line originalLine ` +
		`comments(first:50){nodes{author{login} body path line originalLine diffHunk createdAt ` +
		`reactions(first:50){nodes{content user{login}}}}}}}}}}`;
	const output = await runAsync(
		`gh api graphql -f query='${query}' -f owner='${owner}' -f name='${name}' -F number=${Number(prNumber)}`,
	);
	if (!output) return null;
	try {
		const data = JSON.parse(output);
		const nodes = data?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
		return nodes.map((t: any) => ({
			id: String(t.id),
			isResolved: !!t.isResolved,
			isOutdated: !!t.isOutdated,
			path: t.path ?? null,
			line: t.line ?? t.originalLine ?? null,
			comments: (t.comments?.nodes ?? []).map((c: any) => ({
				author: c.author?.login ?? "unknown",
				body: c.body ?? "",
				path: c.path ?? null,
				line: c.line ?? c.originalLine ?? null,
				diffHunk: c.diffHunk ?? "",
				createdAt: c.createdAt ?? "",
				thumbsUpBy: (c.reactions?.nodes ?? [])
					.filter((r: any) => r.content === "THUMBS_UP")
					.map((r: any) => r.user?.login)
					.filter(Boolean),
			})),
		}));
	} catch {
		return null;
	}
}

/**
 * Filter review threads to the ones the fix loop should act on: **unresolved**
 * AND whose **last comment carries a 👍 from `approver`** (the viewer's own
 * approval). Resolved threads are dropped entirely — resolved means the ask was
 * already applied or deliberately declined. The 👍 gate stops the loop from
 * applying a comment the moment it's left, before the PR owner has vetted it.
 */
export function getApprovedReviewThreads(
	threads: PRReviewThread[],
	approver: string,
): PRReviewThread[] {
	return threads.filter((t) => {
		if (t.isResolved) return false;
		const last = t.comments[t.comments.length - 1];
		return !!last && last.thumbsUpBy.includes(approver);
	});
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

export interface SearchPR {
	number: number;
	title: string;
	repository: { nameWithOwner: string };
	author: { login: string };
	url: string;
	createdAt: string;
	updatedAt: string;
	isDraft: boolean;
	commentsCount: number;
}

export interface PRViewDetail {
	body: string;
	headRefName: string;
	baseRefName: string;
	additions: number;
	deletions: number;
	changedFiles: number;
}

/**
 * Fetch detailed PR info by number (async).
 * Returns body, branch names, and change stats.
 */
export async function getPRViewAsync(prNumber: number): Promise<PRViewDetail | null> {
	try {
		const { stdout } = await execAsync(
			`gh pr view ${prNumber} --json body,headRefName,baseRefName,additions,deletions,changedFiles`,
		);
		return JSON.parse(stdout);
	} catch {
		return null;
	}
}

/**
 * Get the current repo's `owner/name` from the GitHub CLI.
 * Returns null if not in a GitHub repo or gh is unavailable.
 */
export async function getRepoNameAsync(): Promise<string | null> {
	try {
		const { stdout } = await execAsync(`gh repo view --json nameWithOwner --jq .nameWithOwner`);
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

/**
 * Per-process cache of `login → display name`. GitHub display names rarely
 * change inside a dashboard session, and `gh api users/<login>` is a network
 * call we don't want to repeat per refresh. Resolves to `null` for users
 * with no display name set (we'll fall back to login at the call site).
 */
const githubUserNameCache = new Map<string, Promise<string | null>>();

/**
 * Look up a GitHub user's display name (`name` field). Returns null if the
 * user has no display name set, the API call fails, or `gh` isn't available.
 * Caches per process — repeated calls for the same login are free.
 */
export function getGitHubUserNameAsync(login: string): Promise<string | null> {
	const cached = githubUserNameCache.get(login);
	if (cached) return cached;
	const promise = (async () => {
		try {
			const { stdout } = await execAsync(`gh api users/${login} --jq .name`);
			const name = stdout.trim();
			return name && name !== "null" ? name : null;
		} catch {
			return null;
		}
	})();
	githubUserNameCache.set(login, promise);
	return promise;
}

/**
 * Fetch open PRs where the current user's review is still pending (async).
 * Uses the GitHub search API with `user-review-requested:@me` which excludes
 * PRs where you've already submitted a review (unlike `review-requested` which
 * includes stale requests). Scoped to a specific repo.
 * Returns an empty array on failure.
 */
export async function getReviewRequestedPRsAsync(repo: string): Promise<SearchPR[]> {
	try {
		const { stdout } = await execAsync(
			`gh api 'search/issues?q=is:open+is:pr+user-review-requested:@me+archived:false+repo:${repo}&per_page=100' --jq '.items'`,
		);
		const items: any[] = JSON.parse(stdout);
		return items.map((item) => ({
			number: item.number,
			title: item.title,
			repository: {
				nameWithOwner: repo,
			},
			author: { login: item.user?.login ?? "unknown" },
			url: item.html_url ?? item.url,
			createdAt: item.created_at,
			updatedAt: item.updated_at,
			isDraft: item.draft ?? false,
			commentsCount: item.comments ?? 0,
		}));
	} catch {
		return [];
	}
}
