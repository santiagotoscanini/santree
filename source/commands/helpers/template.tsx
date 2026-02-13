import { useEffect, useState, useRef } from "react";
import { Text, Box, useApp } from "ink";
import Spinner from "ink-spinner";
import { argument } from "pastel";
import { z } from "zod/v4";
import {
	findRepoRoot,
	findMainRepoRoot,
	getCurrentBranch,
	extractTicketId,
} from "../../lib/git.js";
import { renderTicket } from "../../lib/prompts.js";
import { getTicketContent } from "../../lib/linear.js";
import {
	resolveAIContext,
	renderAIPrompt,
	fetchAndRenderPR,
	fetchAndRenderDiff,
} from "../../lib/ai.js";

export const description = "Render a template to stdout";

export const args = z.tuple([
	z.enum(["linear", "git-changes", "pr", "fix-pr", "review"]).describe(
		argument({
			name: "type",
			description: "Template type (linear, git-changes, pr, fix-pr, or review)",
		}),
	),
]);

type Props = {
	args: z.infer<typeof args>;
};

type Status = "loading" | "done" | "error";

export default function Template({ args }: Props) {
	const [type] = args;
	const { exit } = useApp();
	const [status, setStatus] = useState<Status>("loading");
	const [message, setMessage] = useState("");
	const hasRun = useRef(false);

	useEffect(() => {
		if (hasRun.current) return;
		hasRun.current = true;

		async function run() {
			await new Promise((r) => setTimeout(r, 50));

			const repoRoot = findRepoRoot();
			if (!repoRoot) {
				setStatus("error");
				setMessage("Not inside a git repository");
				setTimeout(() => exit(), 100);
				return;
			}

			const branch = getCurrentBranch();
			if (!branch) {
				setStatus("error");
				setMessage("Could not determine current branch");
				setTimeout(() => exit(), 100);
				return;
			}

			if (type === "git-changes") {
				const output = await fetchAndRenderDiff(branch);

				process.stdout.write(output);
				setStatus("done");
				setTimeout(() => exit(), 100);
			} else if (type === "pr") {
				const output = await fetchAndRenderPR(branch);
				if (!output) {
					setStatus("error");
					setMessage(`No pull request found for branch '${branch}'`);
					setTimeout(() => exit(), 100);
					return;
				}

				process.stdout.write(output);
				setStatus("done");
				setTimeout(() => exit(), 100);
			} else if (type === "fix-pr" || type === "review") {
				const result = await resolveAIContext();
				if (!result.ok) {
					setStatus("error");
					setMessage(result.error);
					setTimeout(() => exit(), 100);
					return;
				}

				const ctx = result.context;
				const diffContent = await fetchAndRenderDiff(branch);

				if (type === "fix-pr") {
					const prFeedback = await fetchAndRenderPR(branch);
					if (!prFeedback) {
						setStatus("error");
						setMessage(`No pull request found for branch '${branch}'`);
						setTimeout(() => exit(), 100);
						return;
					}
					const output = renderAIPrompt("fix-pr", ctx, {
						pr_feedback: prFeedback,
						diff_content: diffContent,
					});
					process.stdout.write(output);
				} else {
					const output = renderAIPrompt("review", ctx, {
						diff_content: diffContent,
					});
					process.stdout.write(output);
				}

				setStatus("done");
				setTimeout(() => exit(), 100);
			} else {
				const ticketId = extractTicketId(branch);
				if (!ticketId) {
					setStatus("error");
					setMessage(
						"Could not extract ticket ID from branch name. Expected format: user/TEAM-123-description",
					);
					setTimeout(() => exit(), 100);
					return;
				}

				const mainRoot = findMainRepoRoot() ?? repoRoot;
				const ticket = await getTicketContent(ticketId, mainRoot);
				if (!ticket) {
					setStatus("error");
					setMessage(
						`Could not fetch Linear ticket ${ticketId}. Run 'santree linear auth' to authenticate.`,
					);
					setTimeout(() => exit(), 100);
					return;
				}

				process.stdout.write(renderTicket(ticket));
				setStatus("done");
				setTimeout(() => exit(), 100);
			}
		}

		run();
	}, [type]);

	if (status === "done") return null;

	const spinnerTexts: Record<string, string> = {
		linear: "Fetching Linear ticket...",
		"git-changes": "Gathering changes...",
		pr: "Fetching PR feedback...",
		"fix-pr": "Building fix-pr prompt...",
		review: "Building review prompt...",
	};
	const spinnerText = spinnerTexts[type] ?? "Loading...";

	return (
		<Box>
			{status === "loading" && (
				<>
					<Text color="cyan">
						<Spinner type="dots" />
					</Text>
					<Text> {spinnerText}</Text>
				</>
			)}
			{status === "error" && (
				<Text color="red" bold>
					{message}
				</Text>
			)}
		</Box>
	);
}
