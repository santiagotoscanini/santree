import { useEffect, useState } from "react";
import { Text, Box } from "ink";
import Spinner from "ink-spinner";
import { exec } from "child_process";
import { promisify } from "util";
import { findMainRepoRoot, getCurrentBranch, extractTicketId } from "../../lib/git.js";
import { getTicketContent } from "../../lib/linear.js";

const execAsync = promisify(exec);

export const description = "Open the current Linear ticket in the browser";

type Status = "checking" | "done" | "error";

export default function LinearOpen() {
	const [status, setStatus] = useState<Status>("checking");
	const [message, setMessage] = useState("");

	useEffect(() => {
		async function run() {
			await new Promise((r) => setTimeout(r, 50));

			const repoRoot = findMainRepoRoot();
			if (!repoRoot) {
				setStatus("error");
				setMessage("Not inside a git repository");
				return;
			}

			const branch = getCurrentBranch();
			if (!branch) {
				setStatus("error");
				setMessage("Could not determine current branch");
				return;
			}

			const ticketId = extractTicketId(branch);
			if (!ticketId) {
				setStatus("error");
				setMessage("No ticket ID found in branch name (expected pattern like TEAM-123)");
				return;
			}

			const issue = await getTicketContent(ticketId, repoRoot);
			if (!issue?.url) {
				setStatus("error");
				setMessage(
					`Could not fetch ticket ${ticketId}. Check auth with: santree linear auth --status`,
				);
				return;
			}

			try {
				const openCmd =
					process.platform === "darwin"
						? "open"
						: process.platform === "win32"
							? "start"
							: "xdg-open";
				await execAsync(`${openCmd} "${issue.url}"`);
				setStatus("done");
				setMessage(`Opened ${ticketId} in browser`);
			} catch {
				setStatus("error");
				setMessage("Failed to open browser");
			}
		}

		run();
	}, []);

	useEffect(() => {
		if (status === "done" || status === "error") {
			const timer = setTimeout(() => process.exit(status === "error" ? 1 : 0), 100);
			return () => clearTimeout(timer);
		}
	}, [status]);

	return (
		<Box flexDirection="column" padding={1}>
			{status === "checking" && (
				<Box>
					<Text color="cyan">
						<Spinner type="dots" />
					</Text>
					<Text> Opening Linear ticket...</Text>
				</Box>
			)}
			{status === "done" && (
				<Text color="green" bold>
					✓ {message}
				</Text>
			)}
			{status === "error" && (
				<Text color="red" bold>
					✗ {message}
				</Text>
			)}
		</Box>
	);
}
