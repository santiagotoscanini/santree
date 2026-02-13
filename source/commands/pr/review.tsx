import { useEffect, useState } from "react";
import { Text, Box } from "ink";
import Spinner from "ink-spinner";
import {
	resolveAIContext,
	renderAIPrompt,
	launchAgent,
	cleanupImages,
	fetchAndRenderDiff,
} from "../../lib/ai.js";

export const description = "Review changes against ticket requirements";

type Status = "loading" | "fetching" | "launching" | "error";

export default function Review() {
	const [status, setStatus] = useState<Status>("loading");
	const [branch, setBranch] = useState<string | null>(null);
	const [ticketId, setTicketId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		async function init() {
			await new Promise((r) => setTimeout(r, 100));

			setStatus("fetching");
			const result = await resolveAIContext();

			if (!result.ok) {
				setStatus("error");
				setError(result.error);
				return;
			}

			const ctx = result.context;
			setBranch(ctx.branch);
			setTicketId(ctx.ticketId);

			const diffContent = await fetchAndRenderDiff(ctx.branch);

			setStatus("launching");

			const prompt = renderAIPrompt("review", ctx, {
				diff_content: diffContent,
			});

			try {
				const child = launchAgent(prompt);

				child.on("error", (err) => {
					setStatus("error");
					setError(`Failed to launch agent: ${err.message}`);
				});

				child.on("close", () => {
					if (ctx.ticketId) cleanupImages(ctx.ticketId);
					process.exit(0);
				});
			} catch (err) {
				setStatus("error");
				setError(err instanceof Error ? err.message : "Failed to launch agent");
				return;
			}
		}

		init();
	}, []);

	return (
		<Box flexDirection="column" padding={1} width="100%">
			<Box marginBottom={1}>
				<Text bold color="cyan">
					Review
				</Text>
			</Box>

			<Box
				flexDirection="column"
				borderStyle="round"
				borderColor={status === "error" ? "red" : "yellow"}
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

				<Box gap={1}>
					<Text dimColor>mode:</Text>
					<Text backgroundColor="yellow" color="white" bold>
						{" review "}
					</Text>
				</Box>
			</Box>

			<Box marginTop={1}>
				{(status === "loading" || status === "fetching") && (
					<Box>
						<Text color="cyan">
							<Spinner type="dots" />
						</Text>
						<Text>
							{" "}
							{status === "loading" ? "Loading..." : "Fetching ticket, diff, and PR feedback..."}
						</Text>
					</Box>
				)}
				{status === "launching" && (
					<Box flexDirection="column">
						<Text color="green" bold>
							✓ Launching Claude (through Happy)...
						</Text>
						<Text dimColor> happy {`"<review prompt for ${ticketId}>"`}</Text>
					</Box>
				)}
				{status === "error" && (
					<Text color="red" bold>
						✗ {error}
					</Text>
				)}
			</Box>
		</Box>
	);
}
