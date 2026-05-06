import { useEffect, useState } from "react";
import { Text, Box } from "ink";
import Spinner from "ink-spinner";
import { exec } from "child_process";
import { promisify } from "util";
import { findMainRepoRoot } from "../../lib/git.js";
import { getAuthenticatedUser } from "../../lib/trackers/github/auth.js";
import { setRepoTracker } from "../../lib/trackers/index.js";

const execAsync = promisify(exec);

export const description = "Authenticate with GitHub via the gh CLI";

type Status = "checking" | "logging-in" | "done" | "error";

export default function GithubAuth() {
	const [status, setStatus] = useState<Status>("checking");
	const [message, setMessage] = useState("");
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		async function run() {
			await new Promise((r) => setTimeout(r, 100));

			const repoRoot = findMainRepoRoot();
			if (!repoRoot) {
				setError("Not inside a git repository");
				setStatus("error");
				return;
			}

			let user = await getAuthenticatedUser();
			if (!user) {
				setStatus("logging-in");
				try {
					await execAsync("gh auth login -p https -h github.com -w", { stdio: "inherit" } as any);
				} catch (e) {
					setError(e instanceof Error ? e.message : "gh auth login failed");
					setStatus("error");
					return;
				}
				user = await getAuthenticatedUser();
				if (!user) {
					setError("gh auth login completed but no authenticated user — try `gh auth status`");
					setStatus("error");
					return;
				}
			}

			setRepoTracker(repoRoot, "github");
			setMessage(`Authenticated as @${user.login}; this repo now uses GitHub Issues`);
			setStatus("done");
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
			<Box marginBottom={1}>
				<Text bold color="cyan">
					GitHub Auth
				</Text>
			</Box>

			{status === "checking" && (
				<Box>
					<Text color="cyan">
						<Spinner type="dots" />
					</Text>
					<Text> Checking gh auth status...</Text>
				</Box>
			)}

			{status === "logging-in" && (
				<Box>
					<Text color="cyan">
						<Spinner type="dots" />
					</Text>
					<Text> Running `gh auth login` — follow the browser prompt...</Text>
				</Box>
			)}

			{status === "done" && (
				<Text color="green" bold>
					✓ {message}
				</Text>
			)}

			{status === "error" && (
				<Text color="red" bold>
					✗ {error}
				</Text>
			)}
		</Box>
	);
}
