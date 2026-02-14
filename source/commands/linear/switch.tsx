import { useEffect, useState } from "react";
import { Text, Box, useInput } from "ink";
import Spinner from "ink-spinner";
import { findMainRepoRoot, setRepoLinearOrg, getRepoLinearOrg } from "../../lib/git.js";
import { readAuthStore } from "../../lib/linear.js";

export const description = "Switch Linear workspace for this repo";

type Status = "checking" | "choosing" | "done" | "error";

interface OrgChoice {
	slug: string;
	name: string;
}

export default function LinearSwitch() {
	const [status, setStatus] = useState<Status>("checking");
	const [message, setMessage] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [choices, setChoices] = useState<OrgChoice[]>([]);
	const [selected, setSelected] = useState(0);
	const [currentOrg, setCurrentOrg] = useState<string | null>(null);

	useInput((input, key) => {
		if (status !== "choosing") return;

		if (key.upArrow) {
			setSelected((s) => Math.max(0, s - 1));
		} else if (key.downArrow) {
			setSelected((s) => Math.min(choices.length - 1, s + 1));
		} else if (key.return) {
			const choice = choices[selected]!;
			const repoRoot = findMainRepoRoot()!;
			setRepoLinearOrg(repoRoot, choice.slug);
			setMessage(`Switched to ${choice.name} (${choice.slug})`);
			setStatus("done");
		}
	});

	useEffect(() => {
		async function run() {
			await new Promise((r) => setTimeout(r, 100));

			const repoRoot = findMainRepoRoot();
			if (!repoRoot) {
				setError("Not inside a git repository");
				setStatus("error");
				return;
			}

			const store = readAuthStore();
			const orgs = Object.entries(store).map(([slug, tokens]) => ({
				slug,
				name: tokens.org_name,
			}));

			if (orgs.length === 0) {
				setError("No authenticated workspaces. Run: santree linear auth");
				setStatus("error");
				return;
			}

			if (orgs.length === 1) {
				const org = orgs[0]!;
				setRepoLinearOrg(repoRoot, org.slug);
				setMessage(`Linked to ${org.name} (${org.slug})`);
				setStatus("done");
				return;
			}

			setCurrentOrg(getRepoLinearOrg(repoRoot));
			setChoices(orgs);
			setStatus("choosing");
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
					Linear Switch
				</Text>
			</Box>

			{status === "checking" && (
				<Box>
					<Text color="cyan">
						<Spinner type="dots" />
					</Text>
					<Text> Checking...</Text>
				</Box>
			)}

			{status === "choosing" && (
				<Box flexDirection="column">
					<Text>Select a workspace to link to this repo:</Text>
					<Box flexDirection="column" marginTop={1}>
						{choices.map((org, i) => (
							<Text key={org.slug}>
								{i === selected ? (
									<Text color="cyan" bold>
										{"> "}
									</Text>
								) : (
									<Text>{"  "}</Text>
								)}
								{org.name} ({org.slug}){org.slug === currentOrg && <Text dimColor> (current)</Text>}
							</Text>
						))}
					</Box>
					<Box marginTop={1}>
						<Text dimColor>↑/↓ to select, Enter to confirm</Text>
					</Box>
				</Box>
			)}

			{status === "done" && <Text color="green">✓ {message}</Text>}

			{status === "error" && (
				<Text color="red" bold>
					✗ {error}
				</Text>
			)}
		</Box>
	);
}
