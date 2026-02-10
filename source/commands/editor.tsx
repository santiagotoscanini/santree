import { useEffect, useState } from "react";
import { Text, Box } from "ink";
import { z } from "zod";
import { findMainRepoRoot } from "../lib/git.js";
import { execSync, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

export const description = "Open workspace file in VSCode or Cursor";

export const options = z.object({
	editor: z
		.string()
		.optional()
		.describe("Editor command (code, cursor)"),
});

type Props = {
	options: z.infer<typeof options>;
};

type Status =
	| { state: "loading" }
	| { state: "done"; repo: string; file: string; editor: string }
	| { state: "error"; message: string };

export default function Editor({ options: opts }: Props) {
	const [status, setStatus] = useState<Status>({ state: "loading" });

	useEffect(() => {
		const repoRoot = findMainRepoRoot();
		if (!repoRoot) {
			setStatus({ state: "error", message: "Not inside a git repository" });
			return;
		}

		// Find *.code-workspace file
		let workspaceFile: string | null = null;
		try {
			const entries = fs.readdirSync(repoRoot);
			const wsFiles = entries
				.filter((f) => f.endsWith(".code-workspace"))
				.sort();
			if (wsFiles.length > 0) {
				workspaceFile = wsFiles[0]!;
			}
		} catch {
			setStatus({ state: "error", message: "Failed to read repository root" });
			return;
		}

		if (!workspaceFile) {
			setStatus({
				state: "error",
				message: `No .code-workspace file found in ${repoRoot}`,
			});
			return;
		}

		// Resolve editor: --editor flag > SANTREE_EDITOR env > "code" default
		const editor =
			opts.editor || process.env.SANTREE_EDITOR || "code";

		// Validate editor exists in PATH
		try {
			execSync(`which ${editor}`, { stdio: "ignore" });
		} catch {
			setStatus({
				state: "error",
				message: `Editor "${editor}" not found in PATH`,
			});
			return;
		}

		// Spawn editor detached
		const fullPath = path.join(repoRoot, workspaceFile);
		const child = spawn(editor, [fullPath], {
			detached: true,
			stdio: "ignore",
		});
		child.unref();

		setStatus({ state: "done", repo: repoRoot, file: workspaceFile, editor });
	}, []);

	if (status.state === "loading") {
		return null;
	}

	return (
		<Box flexDirection="column" padding={1} width="100%">
			<Box marginBottom={1}>
				<Text bold color="cyan">
					Editor
				</Text>
			</Box>

			<Box
				flexDirection="column"
				borderStyle="round"
				borderColor={status.state === "error" ? "red" : "green"}
				paddingX={1}
				width="100%"
			>
				{status.state === "done" && (
					<>
						<Box gap={1}>
							<Text dimColor>repo:</Text>
							<Text dimColor>{status.repo}</Text>
						</Box>
						<Box gap={1}>
							<Text dimColor>file:</Text>
							<Text color="cyan" bold>
								{status.file}
							</Text>
						</Box>
						<Box gap={1}>
							<Text dimColor>editor:</Text>
							<Text dimColor>{status.editor}</Text>
						</Box>
					</>
				)}

				{status.state === "error" && (
					<Box gap={1}>
						<Text dimColor>error:</Text>
						<Text color="red">{status.message}</Text>
					</Box>
				)}
			</Box>

			<Box marginTop={1}>
				{status.state === "done" && (
					<Text color="green" bold>
						✓ Opened workspace in {status.editor}
					</Text>
				)}
				{status.state === "error" && (
					<Text color="red" bold>
						✗ {status.message}
					</Text>
				)}
			</Box>
		</Box>
	);
}
