import { useEffect, useState } from "react";
import { Text, Box } from "ink";
import { argument } from "pastel";
import { z } from "zod/v4";
import { findMainRepoRoot } from "../../lib/git.js";
import { setRepoTracker, getIssueTracker } from "../../lib/trackers/index.js";

export const description = "Switch the active issue tracker for this repo";

export const args = z.tuple([
	z.enum(["linear", "github"]).describe(
		argument({
			name: "kind",
			description: "Tracker kind: linear or github",
		}),
	),
]);

type Props = {
	args: z.infer<typeof args>;
};

type Status = "switching" | "done" | "error";

export default function IssueSwitch({ args }: Props) {
	const [kind] = args;
	const [status, setStatus] = useState<Status>("switching");
	const [message, setMessage] = useState("");

	useEffect(() => {
		const repoRoot = findMainRepoRoot();
		if (!repoRoot) {
			setMessage("Not inside a git repository");
			setStatus("error");
			return;
		}
		setRepoTracker(repoRoot, kind);
		const tracker = getIssueTracker(repoRoot);
		setMessage(`Active tracker for this repo: ${tracker.displayName}`);
		setStatus("done");
	}, [kind]);

	useEffect(() => {
		if (status === "done" || status === "error") {
			const timer = setTimeout(() => process.exit(status === "error" ? 1 : 0), 50);
			return () => clearTimeout(timer);
		}
	}, [status]);

	return (
		<Box padding={1}>
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
