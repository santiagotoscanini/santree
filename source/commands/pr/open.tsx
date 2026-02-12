import { useEffect, useState } from "react";
import { Text, Box } from "ink";
import Spinner from "ink-spinner";
import { exec } from "child_process";
import { promisify } from "util";
import { getCurrentBranch, isInWorktree } from "../../lib/git.js";
import { ghCliAvailable } from "../../lib/github.js";

const execAsync = promisify(exec);

export const description = "Open the current PR in the browser";

type Status = "checking" | "done" | "error";

export default function PROpen() {
	const [status, setStatus] = useState<Status>("checking");
	const [message, setMessage] = useState("");

	useEffect(() => {
		async function run() {
			await new Promise((r) => setTimeout(r, 50));

			if (!ghCliAvailable()) {
				setStatus("error");
				setMessage("GitHub CLI (gh) is not installed. Install with: brew install gh");
				return;
			}

			if (!isInWorktree()) {
				setStatus("error");
				setMessage("Not inside a worktree");
				return;
			}

			const branch = getCurrentBranch();
			if (!branch) {
				setStatus("error");
				setMessage("Could not determine current branch");
				return;
			}

			try {
				await execAsync(`gh pr view "${branch}" --web`);
				setStatus("done");
				setMessage("Opened PR in browser");
			} catch {
				setStatus("error");
				setMessage(`No PR found for branch ${branch}`);
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
					<Text> Opening PR...</Text>
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
