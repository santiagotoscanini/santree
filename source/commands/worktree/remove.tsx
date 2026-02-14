import { useEffect, useState } from "react";
import { Text, Box, useInput, useApp } from "ink";
import Spinner from "ink-spinner";
import { z } from "zod";
import { removeWorktree, findMainRepoRoot } from "../../lib/git.js";

export const description = "Remove a worktree and its branch";

export const options = z.object({
	force: z.boolean().optional().describe("Skip confirmation prompt"),
});

export const args = z.tuple([z.string().describe("Branch name to remove")]);

type Props = {
	options: z.infer<typeof options>;
	args: z.infer<typeof args>;
};

type Status = "checking" | "confirming" | "removing" | "done" | "cancelled" | "error";

export default function Remove({ args, options }: Props) {
	const [branchName] = args;
	const { exit } = useApp();
	const [status, setStatus] = useState<Status>("checking");
	const [message, setMessage] = useState("");
	const [repoRoot, setRepoRoot] = useState<string | null>(null);

	useInput((input) => {
		if (status !== "confirming") return;

		if (input === "y" || input === "Y") {
			doRemove();
		} else if (input === "n" || input === "N" || input === "\x03") {
			setStatus("cancelled");
			setMessage("Cancelled");
			setTimeout(() => exit(), 100);
		}
	});

	async function doRemove() {
		if (!repoRoot) return;

		setStatus("removing");
		setMessage(`Removing worktree ${branchName}...`);

		const result = await removeWorktree(branchName, repoRoot, true);

		if (result.success) {
			setStatus("done");
			setMessage(`Removed worktree and branch: ${branchName}`);
		} else {
			setStatus("error");
			setMessage(result.error ?? "Unknown error");
		}
	}

	useEffect(() => {
		async function run() {
			await new Promise((r) => setTimeout(r, 100));

			const root = findMainRepoRoot();
			if (!root) {
				setStatus("error");
				setMessage("Not inside a git repository");
				return;
			}
			setRepoRoot(root);

			if (options.force) {
				setStatus("removing");
				setMessage(`Removing worktree ${branchName}...`);
				const result = await removeWorktree(branchName, root, true);
				if (result.success) {
					setStatus("done");
					setMessage(`Removed worktree and branch: ${branchName}`);
				} else {
					setStatus("error");
					setMessage(result.error ?? "Unknown error");
				}
				return;
			}

			setStatus("confirming");
		}

		run();
	}, [branchName]);

	useEffect(() => {
		if (status === "done" || status === "error") {
			const timer = setTimeout(() => process.exit(status === "error" ? 1 : 0), 100);
			return () => clearTimeout(timer);
		}
	}, [status]);

	const isLoading = status === "checking" || status === "removing";

	return (
		<Box flexDirection="column" padding={1} width="100%">
			<Box marginBottom={1}>
				<Text bold color="cyan">
					🗑️ Remove
				</Text>
			</Box>

			<Box
				flexDirection="column"
				borderStyle="round"
				borderColor={status === "error" ? "red" : status === "done" ? "green" : "yellow"}
				paddingX={1}
				width="100%"
			>
				<Box gap={1}>
					<Text dimColor>branch:</Text>
					<Text color="red" bold>
						{branchName}
					</Text>
				</Box>
			</Box>

			<Box marginTop={1}>
				{isLoading && (
					<Box>
						<Text color="yellow">
							<Spinner type="dots" />
						</Text>
						<Text> {message || "Removing..."}</Text>
					</Box>
				)}

				{status === "confirming" && (
					<Text bold color="yellow">
						Remove this worktree and delete the branch? [y/N]:{" "}
					</Text>
				)}

				{status === "done" && (
					<Text color="green" bold>
						✓ {message}
					</Text>
				)}

				{status === "cancelled" && <Text color="yellow">✗ {message}</Text>}

				{status === "error" && (
					<Text color="red" bold>
						✗ {message}
					</Text>
				)}
			</Box>
		</Box>
	);
}
