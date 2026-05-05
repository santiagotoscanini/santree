import { useEffect, useState } from "react";
import { Text, Box, useApp } from "ink";
import { z } from "zod";
import { spawn } from "child_process";
import { findRepoRoot, getCurrentBranch, getBaseBranch, getDiffTool } from "../../lib/git.js";
import { run } from "../../lib/exec.js";

export const description = "View worktree diff against its base branch (uses delta if installed)";

export const options = z.object({
	staged: z.boolean().optional().describe("Show only staged changes"),
	unstaged: z.boolean().optional().describe("Show only unstaged changes (working tree vs index)"),
	commits: z.boolean().optional().describe("Show only committed changes (base...HEAD)"),
	base: z.string().optional().describe("Override base branch"),
});

type Props = {
	options: z.infer<typeof options>;
};

type Status =
	| { state: "running" }
	| { state: "error"; message: string }
	| { state: "done"; exitCode: number };

export default function Diff({ options: opts }: Props) {
	const [status, setStatus] = useState<Status>({ state: "running" });
	const { exit } = useApp();

	useEffect(() => {
		const repoRoot = findRepoRoot();
		if (!repoRoot) {
			setStatus({ state: "error", message: "Not inside a git repository" });
			return;
		}

		const branch = getCurrentBranch();
		if (!branch) {
			setStatus({ state: "error", message: "Could not determine current branch" });
			return;
		}

		const baseBranch = opts.base ?? getBaseBranch(branch);

		// Use merge-base (not base tip) so upstream-only changes are excluded —
		// matches GitHub PR diff semantics. Falls back to baseBranch if merge-base
		// can't be resolved (e.g. unrelated histories).
		const mergeBase = run(`git -C "${repoRoot}" merge-base "${baseBranch}" HEAD`) ?? baseBranch;

		// Resolve diff range based on flags. Defaults to merge-base..working-tree
		// (everything on this branch including uncommitted work, branch-only).
		// Honor SANTREE_DIFF_TOOL by overriding core.pager just for this invocation
		// — `-c` config takes precedence over the user's global git config.
		const tool = getDiffTool();
		const args: string[] = ["-C", repoRoot];
		if (tool) {
			args.push("-c", `core.pager=${tool}`);
		}
		args.push("diff");
		if (opts.staged) {
			args.push("--staged");
		} else if (opts.unstaged) {
			// working tree vs index — no extra arg
		} else if (opts.commits) {
			args.push(`${mergeBase}..HEAD`);
		} else {
			args.push(mergeBase);
		}

		const child = spawn("git", args, { stdio: "inherit" });

		child.on("error", (err) => {
			setStatus({ state: "error", message: err.message });
			exit();
		});

		child.on("close", (code) => {
			setStatus({ state: "done", exitCode: code ?? 0 });
			exit();
		});

		return () => {
			if (!child.killed) child.kill();
		};
	}, []);

	if (status.state === "error") {
		return (
			<Box>
				<Text color="red">✗ {status.message}</Text>
			</Box>
		);
	}

	// While running: render nothing so git/delta own the terminal.
	// On done: render nothing — git's output already filled the screen.
	return null;
}
