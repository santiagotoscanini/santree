import { useEffect, useState } from "react";
import { Text, Box } from "ink";
import Spinner from "ink-spinner";
import { z } from "zod";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import nunjucks from "nunjucks";
import { getCurrentBranch, extractTicketId, findRepoRoot } from "../lib/git.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const promptsDir = join(__dirname, "..", "..", "prompts");
nunjucks.configure(promptsDir, { autoescape: false });

export const description = "Launch Claude to work on current ticket";

export const options = z.object({
	plan: z.boolean().optional().describe("Only create implementation plan"),
	review: z.boolean().optional().describe("Review changes against ticket"),
	"fix-pr": z.boolean().optional().describe("Fetch PR comments and fix them"),
});

type Props = {
	options: z.infer<typeof options>;
};

type Status = "loading" | "ready" | "launching" | "error";

type Mode = "implement" | "plan" | "review" | "fix-pr";

function renderPrompt(mode: Mode, context: Record<string, string>): string {
	return nunjucks.render(`${mode}.njk`, context);
}

function getMode(opts: z.infer<typeof options>): Mode {
	if (opts["fix-pr"]) return "fix-pr";
	if (opts.review) return "review";
	if (opts.plan) return "plan";
	return "implement";
}

function getModeLabel(mode: Mode): string {
	switch (mode) {
		case "implement":
			return "implement";
		case "plan":
			return "plan only";
		case "review":
			return "review";
		case "fix-pr":
			return "fix PR";
	}
}

function getModeColor(mode: Mode): string {
	switch (mode) {
		case "implement":
			return "green";
		case "plan":
			return "blue";
		case "review":
			return "yellow";
		case "fix-pr":
			return "magenta";
	}
}

export default function Work({ options }: Props) {
	const [status, setStatus] = useState<Status>("loading");
	const [branch, setBranch] = useState<string | null>(null);
	const [ticketId, setTicketId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [mode, setMode] = useState<Mode>("implement");

	useEffect(() => {
		async function init() {
			// Small delay to allow spinner to render
			await new Promise((r) => setTimeout(r, 100));

			const repoRoot = findRepoRoot();
			if (!repoRoot) {
				setStatus("error");
				setError("Not inside a git repository");
				return;
			}

			const currentBranch = getCurrentBranch();
			if (!currentBranch) {
				setStatus("error");
				setError("Could not determine current branch");
				return;
			}

			setBranch(currentBranch);

			const ticket = extractTicketId(currentBranch);
			if (!ticket) {
				setStatus("error");
				setError(
					"Could not extract ticket ID from branch name. Expected format: user/TEAM-123-description",
				);
				return;
			}

			setTicketId(ticket);
			setMode(getMode(options));
			setStatus("ready");
		}

		init();
	}, [options]);

	useEffect(() => {
		if (status !== "ready" || !ticketId) return;

		setStatus("launching");

		const prompt = renderPrompt(mode, { ticket_id: ticketId });

		const happyCmd = "happy";

		// Build args array
		const args: string[] = [];

		// Allow Linear MCP tools without prompting
		args.push(
			"--allowedTools",
			"mcp__linear__list_comments mcp__linear__get_issue",
		);

		// Add plan mode flag (Claude's native plan mode)
		if (mode === "plan") {
			args.push("--permission-mode", "plan");
		}

		// Add the prompt
		args.push(prompt);

		// Spawn happy directly with prompt as argument (no shell)
		const child = spawn(happyCmd, args, {
			stdio: "inherit",
		});

		child.on("error", (err) => {
			setStatus("error");
			setError(`Failed to launch happy: ${err.message}`);
		});

		child.on("close", () => {
			process.exit(0);
		});
	}, [status, ticketId, mode]);

	const isLoading = status === "loading";

	return (
		<Box flexDirection="column" padding={1} width="100%">
			<Box marginBottom={1}>
				<Text bold color="cyan">
					🤖 Work
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
				{isLoading && (
					<Box>
						<Text color="cyan">
							<Spinner type="dots" />
						</Text>
						<Text> Loading...</Text>
					</Box>
				)}
				{status === "launching" && (
					<Box flexDirection="column">
						<Text color="green" bold>
							✓ Launching Claude (through Happy)...
						</Text>
						<Text dimColor>
							{" "}happy{mode === "plan" ? " --permission-mode plan" : ""} {`"<${getModeLabel(mode)} prompt for ${ticketId}>"`}
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
