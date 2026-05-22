import { useEffect, useState } from "react";
import { Text, Box, useInput } from "ink";
import Spinner from "ink-spinner";
import { findMainRepoRoot } from "../../lib/git.js";
import { setRepoTracker, getIssueTracker } from "../../lib/trackers/index.js";
import { setRepoLinearOrg } from "../../lib/trackers/linear/index.js";
import { readLinearAuthStore } from "../../lib/trackers/auth-store.js";
import { getAuthenticatedUser, getCurrentRepoNwo } from "../../lib/trackers/github/auth.js";

export const description = "Pick and configure the issue tracker for this repo";

type Phase = "checking" | "pick-tracker" | "pick-org" | "done" | "error";

interface OrgChoice {
	slug: string;
	name: string;
}

const TRACKERS = [
	{ kind: "local" as const, label: "Local", hint: "built-in, file-based — no account needed" },
	{ kind: "linear" as const, label: "Linear", hint: "OAuth workspace" },
	{ kind: "github" as const, label: "GitHub", hint: "GitHub Issues via gh CLI" },
];

export default function IssueSetup() {
	const [phase, setPhase] = useState<Phase>("checking");
	const [message, setMessage] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [trackerIdx, setTrackerIdx] = useState(0);
	const [orgs, setOrgs] = useState<OrgChoice[]>([]);
	const [orgIdx, setOrgIdx] = useState(0);
	const [repoRoot, setRepoRoot] = useState<string | null>(null);

	useEffect(() => {
		const root = findMainRepoRoot();
		if (!root) {
			setError("Not inside a git repository");
			setPhase("error");
			return;
		}
		setRepoRoot(root);
		setPhase("pick-tracker");
	}, []);

	function finish(label: string) {
		setMessage(label);
		setPhase("done");
	}

	async function chooseTracker(kind: "local" | "linear" | "github") {
		const root = repoRoot!;
		if (kind === "local") {
			setRepoTracker(root, "local");
			finish(`Active tracker for this repo: ${getIssueTracker(root).displayName}`);
			return;
		}
		if (kind === "linear") {
			const store = readLinearAuthStore();
			const list = Object.entries(store).map(([slug, tokens]) => ({
				slug,
				name: tokens.org_name,
			}));
			if (list.length === 0) {
				setError("No authenticated Linear workspaces. Run: santree linear auth");
				setPhase("error");
				return;
			}
			if (list.length === 1) {
				setRepoLinearOrg(root, list[0]!.slug);
				setRepoTracker(root, "linear");
				finish(`Linked to ${list[0]!.name} (${list[0]!.slug})`);
				return;
			}
			setOrgs(list);
			setOrgIdx(0);
			setPhase("pick-org");
			return;
		}
		// github
		setPhase("checking");
		const user = await getAuthenticatedUser();
		if (!user) {
			setError("GitHub CLI not authenticated. Run: santree github auth");
			setPhase("error");
			return;
		}
		setRepoTracker(root, "github");
		const nwo = await getCurrentRepoNwo(root);
		finish(`Active tracker: GitHub (@${user.login}${nwo ? ` · ${nwo}` : ""})`);
	}

	useInput((_input, key) => {
		if (phase === "pick-tracker") {
			if (key.upArrow) setTrackerIdx((i) => Math.max(0, i - 1));
			else if (key.downArrow) setTrackerIdx((i) => Math.min(TRACKERS.length - 1, i + 1));
			else if (key.return) void chooseTracker(TRACKERS[trackerIdx]!.kind);
		} else if (phase === "pick-org") {
			if (key.upArrow) setOrgIdx((i) => Math.max(0, i - 1));
			else if (key.downArrow) setOrgIdx((i) => Math.min(orgs.length - 1, i + 1));
			else if (key.return) {
				const org = orgs[orgIdx]!;
				setRepoLinearOrg(repoRoot!, org.slug);
				setRepoTracker(repoRoot!, "linear");
				finish(`Linked to ${org.name} (${org.slug})`);
			}
		}
	});

	useEffect(() => {
		if (phase === "done" || phase === "error") {
			const timer = setTimeout(() => process.exit(phase === "error" ? 1 : 0), 100);
			return () => clearTimeout(timer);
		}
	}, [phase]);

	return (
		<Box flexDirection="column" padding={1}>
			<Box marginBottom={1}>
				<Text bold color="cyan">
					Issue tracker setup
				</Text>
			</Box>

			{phase === "checking" && (
				<Box>
					<Text color="cyan">
						<Spinner type="dots" />
					</Text>
					<Text> Checking…</Text>
				</Box>
			)}

			{phase === "pick-tracker" && (
				<Box flexDirection="column">
					<Text>Select the issue tracker for this repo:</Text>
					<Box flexDirection="column" marginTop={1}>
						{TRACKERS.map((t, i) => (
							<Text key={t.kind}>
								{i === trackerIdx ? (
									<Text color="cyan" bold>
										{"> "}
									</Text>
								) : (
									<Text>{"  "}</Text>
								)}
								{t.label} <Text dimColor>— {t.hint}</Text>
							</Text>
						))}
					</Box>
					<Box marginTop={1}>
						<Text dimColor>↑/↓ to select, Enter to confirm</Text>
					</Box>
				</Box>
			)}

			{phase === "pick-org" && (
				<Box flexDirection="column">
					<Text>Select a Linear workspace to link:</Text>
					<Box flexDirection="column" marginTop={1}>
						{orgs.map((org, i) => (
							<Text key={org.slug}>
								{i === orgIdx ? (
									<Text color="cyan" bold>
										{"> "}
									</Text>
								) : (
									<Text>{"  "}</Text>
								)}
								{org.name} ({org.slug})
							</Text>
						))}
					</Box>
					<Box marginTop={1}>
						<Text dimColor>↑/↓ to select, Enter to confirm</Text>
					</Box>
				</Box>
			)}

			{phase === "done" && <Text color="green">✓ {message}</Text>}

			{phase === "error" && (
				<Text color="red" bold>
					✗ {error}
				</Text>
			)}
		</Box>
	);
}
