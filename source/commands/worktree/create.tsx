import { useEffect, useState } from "react";
import { Text, Box } from "ink";
import Spinner from "ink-spinner";
import { z } from "zod";
import * as fs from "fs";
import {
	createWorktree,
	findMainRepoRoot,
	getDefaultBranch,
	pullLatest,
	hasInitScript,
	getInitScriptPath,
	extractTicketId,
} from "../../lib/git.js";
import { spawnAsync } from "../../lib/exec.js";
import { getMultiplexer } from "../../lib/multiplexer/index.js";

export const description = "Create a new worktree from a branch";

export const options = z.object({
	base: z.string().optional().describe("Base branch to create from"),
	work: z.boolean().optional().describe("Launch Claude after creating"),
	plan: z.boolean().optional().describe("With --work, only plan"),
	"no-pull": z.boolean().optional().describe("Skip pulling latest changes"),
	window: z.boolean().optional().describe("Create a new multiplexer window/workspace (tmux/cmux)"),
	tmux: z.boolean().optional().describe("Alias for --window (deprecated)"),
	name: z.string().optional().describe("Custom window/workspace name"),
});

export const args = z.tuple([z.string().optional().describe("Branch name")]);

type Props = {
	options: z.infer<typeof options>;
	args: z.infer<typeof args>;
};

type Status =
	| "idle"
	| "pulling"
	| "creating"
	| "init-script"
	| "spawning-window"
	| "done"
	| "error";

function getWindowName(branchName: string, customName?: string): string {
	if (customName) return customName;

	// Try to extract ticket ID (e.g., "TEAM-123")
	const ticketId = extractTicketId(branchName);
	if (ticketId) return ticketId;

	// Fallback to last part of branch name
	const parts = branchName.split("/");
	return parts[parts.length - 1] ?? branchName;
}

export default function Create({ options, args }: Props) {
	const [branchName] = args;
	const [status, setStatus] = useState<Status>("idle");
	const [message, setMessage] = useState("");
	const [worktreePath, setWorktreePath] = useState("");
	const [baseBranch, setBaseBranch] = useState<string | null>(null);
	const [muxWindowName, setMuxWindowName] = useState<string | null>(null);

	async function finalize(path: string, branch: string) {
		const wantsWindow = options.window || options.tmux;
		if (wantsWindow) {
			const mux = getMultiplexer();
			if (!mux.isActive()) {
				setMessage("Worktree created, but no active multiplexer");
				setStatus("done");
				console.log(`SANTREE_CD:${path}`);
				return;
			}

			setStatus("spawning-window");
			setMessage("Creating window...");

			const windowName = getWindowName(branch, options.name);
			setMuxWindowName(windowName);

			let runCommand: string | undefined;
			if (options.work) {
				runCommand = options.plan ? "st worktree work --plan" : "st worktree work";
			}

			const result = await mux.createWindow({ name: windowName, cwd: path, command: runCommand });
			if (!result.ok) {
				setMessage(
					`Worktree created, but failed to create window${result.message ? `: ${result.message}` : ""}`,
				);
				setStatus("done");
				console.log(`SANTREE_CD:${path}`);
				return;
			}

			setStatus("done");
			const workInfo = options.work ? (options.plan ? " + Claude (plan)" : " + Claude") : "";
			setMessage(`Worktree and window created!${workInfo}`);
			// Don't output SANTREE_CD when a window is created — user is already in the new window
			return;
		}

		setStatus("done");
		setMessage("Worktree created successfully!");
		console.log(`SANTREE_CD:${path}`);

		if (options.work) {
			const mode = options.plan ? "plan" : "implement";
			console.log(`SANTREE_WORK:${mode}`);
		}
	}

	useEffect(() => {
		async function run() {
			// Small delay to allow spinner to render
			await new Promise((r) => setTimeout(r, 100));

			if (!branchName) {
				setStatus("error");
				setMessage("Branch name is required");
				return;
			}

			const branch = branchName; // Capture for closures

			const mainRepo = findMainRepoRoot();
			if (!mainRepo) {
				setStatus("error");
				setMessage("Not inside a git repository");
				return;
			}

			const base = options.base ?? getDefaultBranch();
			setBaseBranch(base);

			// Pull latest unless --no-pull
			if (!options["no-pull"]) {
				setStatus("pulling");
				setMessage(`Fetching latest changes for ${base}...`);

				const pullResult = pullLatest(base, mainRepo);
				if (!pullResult.success) {
					// Just warn, continue anyway
					setMessage(`Warning: ${pullResult.message}`);
				}
			}

			setStatus("creating");
			setMessage(`Creating worktree from ${base}...`);

			const result = await createWorktree(branch, base, mainRepo);

			if (result.success && result.path) {
				setWorktreePath(result.path);

				// Run init script if it exists
				if (hasInitScript(mainRepo)) {
					setStatus("init-script");
					setMessage("Running init script...");

					const initScript = getInitScriptPath(mainRepo);

					// Check if executable
					try {
						fs.accessSync(initScript, fs.constants.X_OK);
					} catch {
						setMessage("Warning: Init script exists but is not executable");
						await finalize(result.path!, branch);
						return;
					}

					const initResult = await spawnAsync(initScript, [], {
						cwd: result.path,
						env: {
							...process.env,
							SANTREE_WORKTREE_PATH: result.path,
							SANTREE_REPO_ROOT: mainRepo,
						},
					});

					if (initResult.code !== 0) {
						setMessage(`Warning: Init script exited with code ${initResult.code}`);
					}
					await finalize(result.path!, branch);
				} else {
					await finalize(result.path!, branch);
				}
			} else {
				setStatus("error");
				setMessage(result.error ?? "Unknown error");
			}
		}

		run();
	}, [
		branchName,
		options.base,
		options.work,
		options.plan,
		options["no-pull"],
		options.window,
		options.tmux,
		options.name,
	]);

	const isLoading =
		status === "pulling" ||
		status === "creating" ||
		status === "init-script" ||
		status === "spawning-window";

	return (
		<Box flexDirection="column" padding={1} width="100%">
			<Box marginBottom={1}>
				<Text bold color="cyan">
					🌱 Create Worktree
				</Text>
			</Box>

			{branchName && (
				<Box
					flexDirection="column"
					borderStyle="round"
					borderColor={status === "error" ? "red" : status === "done" ? "green" : "blue"}
					paddingX={1}
					width="100%"
				>
					<Box gap={1}>
						<Text dimColor>branch:</Text>
						<Text color="cyan" bold>
							{branchName}
						</Text>
					</Box>

					{baseBranch && (
						<Box gap={1}>
							<Text dimColor>base:</Text>
							<Text color="blue">{baseBranch}</Text>
						</Box>
					)}

					{options["no-pull"] && (
						<Box gap={1}>
							<Text dimColor>skip pull:</Text>
							<Text color="yellow">yes</Text>
						</Box>
					)}

					{options.work && (
						<Box gap={1}>
							<Text dimColor>after:</Text>
							<Text backgroundColor="magenta" color="white">
								{options.plan ? " plan " : " work "}
							</Text>
						</Box>
					)}

					{(options.window || options.tmux) && (
						<Box gap={1}>
							<Text dimColor>window:</Text>
							<Text backgroundColor="green" color="white">
								{` ${options.name || "auto"} `}
							</Text>
						</Box>
					)}
				</Box>
			)}

			<Box marginTop={1}>
				{isLoading && (
					<Box>
						<Text color="cyan">
							<Spinner type="dots" />
						</Text>
						<Text> {message}</Text>
					</Box>
				)}
				{status === "done" && (
					<Box flexDirection="column">
						<Text color="green" bold>
							✓ {message}
						</Text>
						<Text dimColor> {worktreePath}</Text>
						{muxWindowName && <Text dimColor> window: {muxWindowName}</Text>}
					</Box>
				)}
				{status === "error" && (
					<Text color="red" bold>
						✗ {message}
					</Text>
				)}
			</Box>
		</Box>
	);
}
