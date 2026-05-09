import { useEffect, useState } from "react";
import { Text, Box, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import {
	findRepoRoot,
	findMainRepoRoot,
	getCurrentBranch,
	extractTicketId,
	getGitStatus,
	getStagedDiffStat,
	getStagedDiffContent,
	hasStagedChanges,
	hasUnstagedChanges,
} from "../../lib/git.js";
import { fillCommitMessage } from "../../lib/ai.js";
import { getIssueTracker } from "../../lib/trackers/index.js";
import { renderTicket } from "../../lib/prompts.js";

export const description = "Stage and commit changes";

export const options = z.object({
	fill: z.boolean().optional().describe("Use AI to draft a short commit message"),
});

type Props = {
	options: z.infer<typeof options>;
};

const execAsync = promisify(exec);

type Status =
	| "loading"
	| "confirm-stage"
	| "filling"
	| "awaiting-message"
	| "committing"
	| "pushing"
	| "done"
	| "no-changes"
	| "error";

export default function Commit({ options }: Props) {
	const { exit } = useApp();
	const [status, setStatus] = useState<Status>("loading");
	const [message, setMessage] = useState("");
	const [branch, setBranch] = useState<string | null>(null);
	const [ticketId, setTicketId] = useState<string | null>(null);
	const [gitStatus, setGitStatus] = useState("");
	const [diffStat, setDiffStat] = useState("");
	const [repoRoot, setRepoRoot] = useState<string | null>(null);
	const [commitInput, setCommitInput] = useState("");

	// Handle confirmation for staging
	useInput((input, key) => {
		if (status === "confirm-stage") {
			if (input === "y" || input === "Y") {
				stageAndContinue();
			} else if (input === "n" || input === "N" || key.escape) {
				if (hasStagedChanges() && repoRoot && branch) {
					// Respect --fill even when the user declines to stage more.
					void openMessagePhase({ repoRoot, branch, ticketId });
				} else {
					setStatus("no-changes");
					setMessage("No staged changes to commit");
					setTimeout(() => exit(), 100);
				}
			}
		}
	});

	async function stageAndContinue() {
		if (!repoRoot || !branch) return;
		try {
			await execAsync("git add -A", { cwd: repoRoot });
			setGitStatus(getGitStatus());
			setDiffStat(getStagedDiffStat());
			await openMessagePhase({ repoRoot, branch, ticketId });
		} catch (e) {
			setStatus("error");
			setMessage(`Failed to stage changes: ${e}`);
		}
	}

	// Routes to either the AI-fill phase or straight to the bare input.
	// Takes context as args so callers in init() (where state isn't yet
	// propagated from the just-fired setStates) can hand in fresh values.
	async function openMessagePhase(ctx: {
		repoRoot: string;
		branch: string;
		ticketId: string | null;
	}) {
		const prefix = ctx.ticketId ? `[${ctx.ticketId}] ` : "";
		if (options.fill) {
			setStatus("filling");
			setMessage("Drafting commit message with Claude...");
			const drafted = await draftWithAI(ctx);
			// Whether Claude succeeds or not, fall through to the input —
			// the user can edit or type from scratch.
			setCommitInput(drafted ?? prefix);
			setStatus("awaiting-message");
			return;
		}
		setCommitInput(prefix);
		setStatus("awaiting-message");
	}

	async function draftWithAI(ctx: {
		repoRoot: string;
		branch: string;
		ticketId: string | null;
	}): Promise<string | null> {
		const diffContent = getStagedDiffContent(ctx.repoRoot);
		if (!diffContent.trim()) return null;
		// Pull ticket context if we can — the prompt uses it to ground the
		// summary in the requested change rather than the literal diff.
		let ticketContent: string | undefined;
		const mainRoot = findMainRepoRoot();
		if (ctx.ticketId && mainRoot) {
			const tracker = getIssueTracker(mainRoot);
			const result = await tracker.getIssue(ctx.ticketId, mainRoot);
			if (result.ok) {
				ticketContent = renderTicket(result.value, tracker.displayName);
			}
		}
		return fillCommitMessage({
			branch: ctx.branch,
			ticketId: ctx.ticketId,
			ticketContent,
			diffContent,
		});
	}

	async function handleCommitSubmit(value: string) {
		const trimmed = value.trim();
		if (!trimmed) {
			setStatus("error");
			setMessage("Empty commit message, cancelled");
			setTimeout(() => exit(), 100);
			return;
		}

		// Prepend ticket ID if not already present
		const commitMessage =
			ticketId && !trimmed.includes(`[${ticketId}]`) ? `[${ticketId}] ${trimmed}` : trimmed;

		setStatus("committing");
		setMessage("Creating commit...");

		try {
			await execAsync(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`, {
				cwd: repoRoot ?? undefined,
			});
		} catch (e: unknown) {
			setStatus("error");
			const errorMsg = e instanceof Error ? e.message : String(e);
			setMessage(`Commit failed: ${errorMsg}`);
			setTimeout(() => exit(), 100);
			return;
		}

		setStatus("pushing");
		setMessage("Pushing to origin...");

		try {
			await execAsync(`git push -u origin "${branch}"`, {
				cwd: repoRoot ?? undefined,
			});
		} catch (e: unknown) {
			setStatus("error");
			const errorMsg = e instanceof Error ? e.message : String(e);
			setMessage(`Push failed: ${errorMsg}`);
			setTimeout(() => exit(), 100);
			return;
		}

		setStatus("done");
		setMessage("Committed and pushed successfully!");
		setTimeout(() => exit(), 100);
	}

	useEffect(() => {
		async function init() {
			await new Promise((r) => setTimeout(r, 100));

			const root = findRepoRoot();
			if (!root) {
				setStatus("error");
				setMessage("Not inside a git repository");
				return;
			}
			setRepoRoot(root);

			const currentBranch = getCurrentBranch();
			if (!currentBranch) {
				setStatus("error");
				setMessage("Could not determine current branch");
				return;
			}
			setBranch(currentBranch);

			const ticket = extractTicketId(currentBranch);
			setTicketId(ticket);

			const statusOutput = getGitStatus();
			if (!statusOutput) {
				setStatus("no-changes");
				setMessage("No changes");
				setTimeout(() => exit(), 100);
				return;
			}
			setGitStatus(statusOutput);

			const unstaged = hasUnstagedChanges();
			const staged = hasStagedChanges();

			if (unstaged) {
				setStatus("confirm-stage");
			} else if (staged) {
				setDiffStat(getStagedDiffStat());
				await openMessagePhase({ repoRoot: root, branch: currentBranch, ticketId: ticket });
			} else {
				setStatus("no-changes");
				setMessage("No changes to commit");
				setTimeout(() => exit(), 100);
			}
		}

		init();
	}, []);

	const isLoading =
		status === "loading" || status === "filling" || status === "committing" || status === "pushing";

	return (
		<Box flexDirection="column" padding={1} width="100%">
			<Box marginBottom={1}>
				<Text bold color="cyan">
					💾 Commit
				</Text>
			</Box>

			<Box
				flexDirection="column"
				borderStyle="round"
				borderColor={status === "error" ? "red" : status === "done" ? "green" : "blue"}
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

				{ticketId && (
					<Box gap={1}>
						<Text dimColor>ticket:</Text>
						<Text color="blue" bold>
							{ticketId}
						</Text>
					</Box>
				)}
			</Box>

			{gitStatus && (
				<Box flexDirection="column" marginTop={1}>
					<Text bold dimColor>
						Changes:
					</Text>
					<Box
						flexDirection="column"
						borderStyle="round"
						borderColor="gray"
						paddingX={1}
						width="100%"
					>
						{gitStatus
							.split("\n")
							.slice(0, 10)
							.map((line, i) => {
								let color: string | undefined;
								if (line.startsWith("A ") || line.startsWith("M ") || line.startsWith("D ")) {
									color = "green";
								} else if (line.startsWith("??")) {
									color = "gray";
								} else if (line.startsWith(" M") || line.startsWith(" D")) {
									color = "yellow";
								}
								return (
									<Text key={i} color={color as any}>
										{line}
									</Text>
								);
							})}
						{gitStatus.split("\n").length > 10 && (
							<Text dimColor>... and {gitStatus.split("\n").length - 10} more</Text>
						)}
					</Box>
				</Box>
			)}

			{diffStat && (
				<Box flexDirection="column" marginTop={1}>
					<Text bold dimColor>
						Staged:
					</Text>
					<Box
						flexDirection="column"
						borderStyle="round"
						borderColor="green"
						paddingX={1}
						width="100%"
					>
						{diffStat.split("\n").map((line, i) => (
							<Text key={i} dimColor>
								{line}
							</Text>
						))}
					</Box>
				</Box>
			)}

			<Box marginTop={1}>
				{isLoading && (
					<Box>
						<Text color="cyan">
							<Spinner type="dots" />
						</Text>
						<Text> {message || "Loading..."}</Text>
					</Box>
				)}
				{status === "confirm-stage" && (
					<Text color="yellow" bold>
						Stage all changes? [y/N]:{" "}
					</Text>
				)}
				{status === "awaiting-message" && (
					<Box>
						<Text color="cyan" bold>
							Commit message:{" "}
						</Text>
						<TextInput
							value={commitInput}
							onChange={setCommitInput}
							onSubmit={handleCommitSubmit}
						/>
					</Box>
				)}
				{status === "done" && (
					<Text color="green" bold>
						✓ {message}
					</Text>
				)}
				{status === "no-changes" && <Text dimColor>✓ {message}</Text>}
				{status === "error" && (
					<Text color="red" bold>
						✗ {message}
					</Text>
				)}
			</Box>
		</Box>
	);
}
