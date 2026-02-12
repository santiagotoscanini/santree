import { useEffect, useState } from "react";
import { Text, Box } from "ink";
import Spinner from "ink-spinner";
import { z } from "zod";
import {
	resolveAIContext,
	renderAIPrompt,
	launchHappy,
	cleanupImages,
	type AIContext,
} from "../../lib/ai.js";

export const description = "Launch Claude to work on current ticket";

export const options = z.object({
	plan: z.boolean().optional().describe("Only create implementation plan"),
});

type Props = {
	options: z.infer<typeof options>;
};

type Status = "loading" | "fetching" | "ready" | "launching" | "error";

type Mode = "implement" | "plan";

function getModeLabel(mode: Mode): string {
	return mode === "plan" ? "plan only" : "implement";
}

function getModeColor(mode: Mode): string {
	return mode === "plan" ? "blue" : "green";
}

export default function Work({ options }: Props) {
	const [status, setStatus] = useState<Status>("loading");
	const [branch, setBranch] = useState<string | null>(null);
	const [ticketId, setTicketId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [mode] = useState<Mode>(options.plan ? "plan" : "implement");
	const [aiContext, setAiContext] = useState<AIContext | null>(null);

	useEffect(() => {
		async function init() {
			// Small delay to allow spinner to render
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
			setAiContext(ctx);
			setStatus("ready");
		}

		init();
	}, [options]);

	useEffect(() => {
		if (status !== "ready" || !aiContext) return;

		setStatus("launching");

		const prompt = renderAIPrompt(mode, aiContext);

		const child = launchHappy(prompt, { planMode: mode === "plan" });

		child.on("error", (err) => {
			setStatus("error");
			setError(`Failed to launch happy: ${err.message}`);
		});

		child.on("close", () => {
			if (aiContext.ticketId) cleanupImages(aiContext.ticketId);
			process.exit(0);
		});
	}, [status, aiContext, mode]);

	return (
		<Box flexDirection="column" padding={1} width="100%">
			<Box marginBottom={1}>
				<Text bold color="cyan">
					Work
				</Text>
			</Box>

			<Box
				flexDirection="column"
				borderStyle="round"
				borderColor={status === "error" ? "red" : getModeColor(mode)}
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
					<Text backgroundColor={getModeColor(mode) as any} color="white" bold>
						{` ${getModeLabel(mode)} `}
					</Text>
				</Box>
			</Box>

			<Box marginTop={1}>
				{status === "loading" && (
					<Box>
						<Text color="cyan">
							<Spinner type="dots" />
						</Text>
						<Text> Loading...</Text>
					</Box>
				)}
				{status === "fetching" && (
					<Box>
						<Text color="cyan">
							<Spinner type="dots" />
						</Text>
						<Text> Fetching ticket from Linear...</Text>
					</Box>
				)}
				{status === "launching" && (
					<Box flexDirection="column">
						<Text color="green" bold>
							✓ Launching Claude (through Happy)...
						</Text>
						<Text dimColor>
							{" "}
							happy{mode === "plan" ? " --permission-mode plan" : ""}{" "}
							{`"<${getModeLabel(mode)} prompt for ${ticketId}>"`}
						</Text>
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
