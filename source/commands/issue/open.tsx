import { useEffect, useState } from "react";
import { Text, Box } from "ink";
import Spinner from "ink-spinner";
import { exec } from "child_process";
import { promisify } from "util";
import { findMainRepoRoot, getCurrentBranch } from "../../lib/git.js";
import { getIssueTracker } from "../../lib/trackers/index.js";

const execAsync = promisify(exec);

export const description = "Open the current branch's issue in the browser";

type Status = "checking" | "done" | "error";

export default function IssueOpen() {
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

			const tracker = getIssueTracker(repoRoot);
			const ticketId = tracker.extractIdFromBranch(branch);
			if (!ticketId) {
				setStatus("error");
				setMessage(`No ${tracker.issueNoun} ID found in branch '${branch}'`);
				return;
			}

			const result = await tracker.getIssue(ticketId, repoRoot);
			if (!result.ok || !result.value.url) {
				const auth = await tracker.getAuthStatus(repoRoot);
				setStatus("error");
				setMessage(
					`Could not fetch ${tracker.issueNoun} ${ticketId}.${auth.hint ? ` ${auth.hint}` : ""}`,
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
				await execAsync(`${openCmd} "${result.value.url}"`);
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
					<Text> Opening issue...</Text>
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
