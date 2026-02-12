import { useEffect, useState } from "react";
import { Text, Box, useInput, useApp } from "ink";
import Spinner from "ink-spinner";
import { z } from "zod";
import { exec, spawnSync } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import {
	findMainRepoRoot,
	findRepoRoot,
	getCurrentBranch,
	getBaseBranch,
	hasUncommittedChanges,
	getCommitsAhead,
	remoteBranchExists,
	getUnpushedCommits,
	extractTicketId,
	isInWorktree,
	getFirstCommitMessage,
	getCommitLog,
	getDiffStat,
	getDiffContent,
} from "../../lib/git.js";
import {
	ghCliAvailable,
	getPRInfoAsync,
	pushBranch,
	createPR,
	getPRTemplate,
	type PRInfo,
} from "../../lib/github.js";
import { renderPrompt } from "../../lib/prompts.js";

const execAsync = promisify(exec);

export const description = "Create a GitHub pull request";

export const options = z.object({
	fill: z.boolean().optional().describe("Use AI to fill the PR template"),
});

type Props = {
	options: z.infer<typeof options>;
};

type Status =
	| "checking"
	| "pushing"
	| "confirm-reopen"
	| "filling"
	| "creating"
	| "done"
	| "existing"
	| "error";

export default function PR({ options }: Props) {
	const { exit } = useApp();
	const [status, setStatus] = useState<Status>("checking");
	const [message, setMessage] = useState("");
	const [branch, setBranch] = useState<string | null>(null);
	const [baseBranch, setBaseBranch] = useState<string | null>(null);
	const [issueId, setIssueId] = useState<string | null>(null);
	const [closedPrInfo, setClosedPrInfo] = useState<PRInfo | null>(null);
	const [pendingCreate, setPendingCreate] = useState(false);

	useInput((input, key) => {
		if (status !== "confirm-reopen") return;

		if (input === "y" || input === "Y") {
			setClosedPrInfo(null);
			setPendingCreate(true);
		} else if (input === "n" || input === "N" || key.escape) {
			setStatus("error");
			setMessage("Cancelled");
			setTimeout(() => exit(), 100);
		}
	});

	useEffect(() => {
		if (!pendingCreate || !branch || !baseBranch) return;
		setPendingCreate(false);
		openPR();
	}, [pendingCreate]);

	function openPR() {
		if (!branch || !baseBranch) return;

		const title = getFirstCommitMessage(baseBranch) ?? branch;
		let bodyFile: string | undefined;

		if (options.fill) {
			setStatus("filling");
			setMessage("Filling PR template with AI...");

			const prTemplate = getPRTemplate();
			if (!prTemplate) {
				setStatus("error");
				setMessage("No PR template found at .github/pull_request_template.md");
				setTimeout(() => exit(), 100);
				return;
			}

			const commitLog = getCommitLog(baseBranch) ?? "";
			const diffStat = getDiffStat(baseBranch) ?? "";
			const diff = getDiffContent(baseBranch) ?? "";
			const ticketId = extractTicketId(branch);

			const prompt = renderPrompt("fill-pr", {
				pr_template: prTemplate,
				commit_log: commitLog,
				diff_stat: diffStat,
				diff,
				ticket_id: ticketId ?? "",
				branch_name: branch,
			});

			const result = spawnSync("happy", ["-p", prompt, "--output-format", "text"], {
				encoding: "utf-8",
				maxBuffer: 10 * 1024 * 1024,
			});

			if (result.status !== 0) {
				setStatus("error");
				setMessage("Failed to generate PR body with Claude");
				setTimeout(() => exit(), 100);
				return;
			}

			const body = result.stdout.trim();
			bodyFile = join(tmpdir(), `santree-pr-${Date.now()}.md`);
			writeFileSync(bodyFile, body);
		}

		setStatus("creating");
		setMessage("Opening PR in browser...");

		const result = createPR(title, baseBranch, branch, bodyFile);

		if (result === 0) {
			setStatus("done");
			setMessage("Opened PR creation page in browser");
		} else {
			setStatus("error");
			setMessage("Failed to open PR page");
		}
		setTimeout(() => exit(), 100);
	}

	useEffect(() => {
		async function run() {
			// Allow spinner to render first
			await new Promise((r) => setTimeout(r, 50));

			// Check gh CLI is available
			if (!ghCliAvailable()) {
				setStatus("error");
				setMessage("GitHub CLI (gh) is not installed. Install with: brew install gh");
				return;
			}

			// Yield to let spinner animate
			await new Promise((r) => setTimeout(r, 10));

			// Find repos
			const mainRepoRoot = findMainRepoRoot();
			const currentRepo = findRepoRoot();

			if (!mainRepoRoot || !currentRepo) {
				setStatus("error");
				setMessage("Not inside a git repository");
				return;
			}

			// Validate we're in a worktree (not the main repo)
			if (!isInWorktree()) {
				setStatus("error");
				setMessage("Not inside a worktree (you are in the main repository)");
				return;
			}

			// Yield to let spinner animate
			await new Promise((r) => setTimeout(r, 10));

			// Get current branch
			const branchName = getCurrentBranch();
			if (!branchName) {
				setStatus("error");
				setMessage("Could not determine current branch");
				return;
			}
			setBranch(branchName);

			// Check for uncommitted changes
			if (hasUncommittedChanges()) {
				setStatus("error");
				setMessage("You have uncommitted changes. Please commit before creating a PR.");
				return;
			}

			// Yield to let spinner animate
			await new Promise((r) => setTimeout(r, 10));

			// Get base branch from metadata
			const base = getBaseBranch(branchName);
			setBaseBranch(base);

			// Check commits ahead
			const commitsAhead = getCommitsAhead(base);
			if (commitsAhead === 0) {
				setStatus("error");
				setMessage(`No commits ahead of ${base}. Make commits before creating a PR.`);
				return;
			}

			// Yield to let spinner animate
			await new Promise((r) => setTimeout(r, 10));

			// Check if we need to push
			const remoteExists = remoteBranchExists(branchName);
			const unpushed = getUnpushedCommits(branchName);

			if (!remoteExists || unpushed > 0) {
				setStatus("pushing");
				setMessage("Pushing to remote...");

				// Yield before push
				await new Promise((r) => setTimeout(r, 10));

				if (!pushBranch(branchName)) {
					setStatus("error");
					setMessage("Failed to push branch to remote");
					return;
				}
			}

			// Check if PR already exists
			const existingPr = await getPRInfoAsync(branchName);
			if (existingPr) {
				if (existingPr.state === "CLOSED") {
					// Closed PR — let user decide to create a new one
					setClosedPrInfo(existingPr);
					setStatus("confirm-reopen");
					return;
				}
				setStatus("existing");
				setMessage(`PR already exists (#${existingPr.number}) - ${existingPr.state}`);
				if (existingPr.url) {
					try {
						await execAsync(`open "${existingPr.url}"`);
					} catch {
						// Ignore open errors
					}
				}
				setTimeout(() => exit(), 100);
				return;
			}

			// Extract ticket ID from branch name to display in UI
			const ticket = extractTicketId(branchName);
			if (ticket) {
				setIssueId(ticket);
			}
		}

		run();
	}, [options.fill]);

	// Once branch and baseBranch are set and we're still checking, go straight to PR
	useEffect(() => {
		if (status === "checking" && branch && baseBranch && !closedPrInfo) {
			openPR();
		}
	}, [status, branch, baseBranch]);

	const isLoading =
		status === "checking" || status === "pushing" || status === "filling" || status === "creating";

	return (
		<Box flexDirection="column" padding={1} width="100%">
			<Box marginBottom={1}>
				<Text bold color="cyan">
					🔗 Pull Request
				</Text>
			</Box>

			<Box
				flexDirection="column"
				borderStyle="round"
				borderColor={
					status === "error"
						? "red"
						: status === "done"
							? "green"
							: status === "existing"
								? "yellow"
								: "blue"
				}
				paddingX={1}
				width="100%"
			>
				{branch && (
					<Box gap={1}>
						<Text dimColor>branch:</Text>
						<Text color="cyan" bold>
							{branch}
						</Text>
					</Box>
				)}

				{baseBranch && (
					<Box gap={1}>
						<Text dimColor>base:</Text>
						<Text color="blue">{baseBranch}</Text>
					</Box>
				)}

				{issueId && (
					<Box gap={1}>
						<Text dimColor>issue:</Text>
						<Text color="blue" bold>
							{issueId}
						</Text>
					</Box>
				)}
			</Box>

			<Box marginTop={1} flexDirection="column">
				{isLoading && (
					<Box>
						<Text color="cyan">
							<Spinner type="dots" />
						</Text>
						<Text> {message || "Checking..."}</Text>
					</Box>
				)}
				{status === "confirm-reopen" && closedPrInfo && (
					<Box>
						<Text color="yellow">PR #{closedPrInfo.number} was closed. Create a new one? </Text>
						<Text color="green" bold>
							[y]
						</Text>
						<Text> / </Text>
						<Text color="red" bold>
							[n]
						</Text>
					</Box>
				)}
				{status === "done" && (
					<Text color="green" bold>
						✓ {message}
					</Text>
				)}
				{status === "existing" && (
					<Text color="yellow" bold>
						⚠ {message}
					</Text>
				)}
				{status === "error" && (
					<Text color="red" bold>
						✗ {message}
					</Text>
				)}
			</Box>
		</Box>
	);
}
