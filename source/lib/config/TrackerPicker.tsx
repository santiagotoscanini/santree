import { useState } from "react";
import { Text, Box, useInput } from "ink";
import Spinner from "ink-spinner";
import { setRepoTracker, getIssueTracker } from "../trackers/index.js";
import { setRepoLinearOrg, startOAuthFlow } from "../trackers/linear/index.js";
import { readLinearAuthStore } from "../trackers/auth-store.js";
import { getAuthenticatedUser, getCurrentRepoNwo } from "../trackers/github/auth.js";
import type { IssueTrackerKind } from "../trackers/types.js";

/**
 * Inline issue-tracker picker used by `santree config`'s `select` sub-flow.
 * Extracted from the old standalone `santree tracker` command so the panel can
 * drill into it (up/down/←/Esc) instead of spawning a subprocess. Mutations go
 * straight through `lib/trackers`; on success it calls `onApplied`, on top-level
 * back-out it calls `onCancel`.
 */

type Phase = "pick-tracker" | "pick-org" | "authenticating" | "checking" | "error";

interface OrgChoice {
	slug: string;
	name: string;
}

const AUTH_NEW = "__auth_new__";

const TRACKERS = [
	{ kind: "local" as const, label: "Local", hint: "built-in, file-based — no account needed" },
	{ kind: "linear" as const, label: "Linear", hint: "OAuth workspace" },
	{ kind: "github" as const, label: "GitHub", hint: "GitHub Issues via gh CLI" },
];

interface Props {
	repoRoot: string;
	activeKind: IssueTrackerKind | null;
	activeOrg: string | null;
	onApplied: (message: string) => void;
	onCancel: () => void;
}

export default function TrackerPicker({
	repoRoot,
	activeKind,
	activeOrg,
	onApplied,
	onCancel,
}: Props) {
	const [phase, setPhase] = useState<Phase>("pick-tracker");
	const [error, setError] = useState<string | null>(null);
	const startIdx = Math.max(
		0,
		TRACKERS.findIndex((t) => t.kind === activeKind),
	);
	const [trackerIdx, setTrackerIdx] = useState(startIdx);
	const [orgs, setOrgs] = useState<OrgChoice[]>([]);
	const [orgIdx, setOrgIdx] = useState(0);

	function authenticateNewLinear() {
		setPhase("authenticating");
		startOAuthFlow().then((result) => {
			if (!result) {
				setError("Authentication failed or timed out. Please try again.");
				setPhase("error");
				return;
			}
			setRepoLinearOrg(repoRoot, result.orgSlug);
			setRepoTracker(repoRoot, "linear");
			onApplied(`Authenticated as ${result.orgName} (${result.orgSlug})`);
		});
	}

	async function chooseTracker(kind: IssueTrackerKind) {
		if (kind === "local") {
			setRepoTracker(repoRoot, "local");
			onApplied(`Active tracker: ${getIssueTracker(repoRoot).displayName}`);
			return;
		}
		if (kind === "linear") {
			const store = readLinearAuthStore();
			const list = Object.entries(store).map(([slug, tokens]) => ({
				slug,
				name: tokens.org_name,
			}));
			if (list.length === 0) {
				authenticateNewLinear();
				return;
			}
			setOrgs(list);
			const cur = list.findIndex((o) => o.slug === activeOrg);
			setOrgIdx(cur >= 0 ? cur : 0);
			setPhase("pick-org");
			return;
		}
		// github
		setPhase("checking");
		const user = await getAuthenticatedUser();
		if (!user) {
			setError("GitHub CLI not authenticated. Run: gh auth login");
			setPhase("error");
			return;
		}
		setRepoTracker(repoRoot, "github");
		const nwo = await getCurrentRepoNwo(repoRoot);
		onApplied(`Active tracker: GitHub (@${user.login}${nwo ? ` · ${nwo}` : ""})`);
	}

	useInput((_input, key) => {
		if (phase === "error") {
			// Any key returns to the tracker menu.
			setError(null);
			setPhase("pick-tracker");
			return;
		}
		if (phase === "pick-tracker") {
			if (key.escape || key.leftArrow) onCancel();
			else if (key.upArrow) setTrackerIdx((i) => Math.max(0, i - 1));
			else if (key.downArrow) setTrackerIdx((i) => Math.min(TRACKERS.length - 1, i + 1));
			else if (key.return) void chooseTracker(TRACKERS[trackerIdx]!.kind);
		} else if (phase === "pick-org") {
			const max = orgs.length; // index === orgs.length selects AUTH_NEW
			if (key.leftArrow || key.escape) setPhase("pick-tracker");
			else if (key.upArrow) setOrgIdx((i) => Math.max(0, i - 1));
			else if (key.downArrow) setOrgIdx((i) => Math.min(max, i + 1));
			else if (key.return) {
				if (orgIdx === orgs.length) {
					authenticateNewLinear();
					return;
				}
				const org = orgs[orgIdx]!;
				setRepoLinearOrg(repoRoot, org.slug);
				setRepoTracker(repoRoot, "linear");
				onApplied(`Linked to ${org.name} (${org.slug})`);
			}
		}
	});

	return (
		<Box flexDirection="column">
			{phase === "checking" && (
				<Box>
					<Text color="cyan">
						<Spinner type="dots" />
					</Text>
					<Text> Checking…</Text>
				</Box>
			)}

			{phase === "authenticating" && (
				<Box>
					<Text color="cyan">
						<Spinner type="dots" />
					</Text>
					<Text> Authenticating with Linear — follow the browser prompt…</Text>
				</Box>
			)}

			{phase === "pick-tracker" && (
				<Box flexDirection="column">
					<Text>Select the issue tracker for this repo:</Text>
					<Box flexDirection="column" marginTop={1}>
						{TRACKERS.map((t, i) => {
							const active = t.kind === activeKind;
							return (
								<Text key={t.kind}>
									{i === trackerIdx ? (
										<Text color="cyan" bold>
											{"> "}
										</Text>
									) : (
										<Text>{"  "}</Text>
									)}
									{t.label}
									{active ? <Text color="green"> ● in use</Text> : null}{" "}
									<Text dimColor>— {t.hint}</Text>
								</Text>
							);
						})}
					</Box>
					<Box marginTop={1}>
						<Text dimColor>↑/↓ select · Enter confirm · ← / Esc back</Text>
					</Box>
				</Box>
			)}

			{phase === "pick-org" && (
				<Box flexDirection="column">
					<Text>Select a Linear workspace to link:</Text>
					<Box flexDirection="column" marginTop={1}>
						{orgs.map((org, i) => {
							const active = org.slug === activeOrg && activeKind === "linear";
							return (
								<Text key={org.slug}>
									{i === orgIdx ? (
										<Text color="cyan" bold>
											{"> "}
										</Text>
									) : (
										<Text>{"  "}</Text>
									)}
									{org.name} ({org.slug}){active ? <Text color="green"> ● in use</Text> : null}
								</Text>
							);
						})}
						<Text key={AUTH_NEW}>
							{orgIdx === orgs.length ? (
								<Text color="cyan" bold>
									{"> "}
								</Text>
							) : (
								<Text>{"  "}</Text>
							)}
							<Text dimColor>+ Authenticate a new workspace…</Text>
						</Text>
					</Box>
					<Box marginTop={1}>
						<Text dimColor>↑/↓ select · ← back · Enter confirm</Text>
					</Box>
				</Box>
			)}

			{phase === "error" && (
				<Box flexDirection="column">
					<Text color="red" bold>
						✗ {error}
					</Text>
					<Text dimColor>Press any key to go back.</Text>
				</Box>
			)}
		</Box>
	);
}
