import { useEffect, useState } from "react";
import { Text, Box, useInput } from "ink";
import Spinner from "ink-spinner";
import { z } from "zod";
import {
	findMainRepoRoot,
	setRepoLinearOrg,
	getRepoLinearOrg,
	removeRepoLinearOrg,
} from "../../lib/git.js";
import {
	startOAuthFlow,
	getAuthStatus,
	getValidTokens,
	getTicketContent,
	readAuthStore,
} from "../../lib/linear.js";
import { renderTicket } from "../../lib/prompts.js";

export const description = "Authenticate with Linear";

export const options = z.object({
	logout: z.boolean().optional().describe("Unlink Linear workspace from this repo"),
	status: z.boolean().optional().describe("Show current auth status"),
	test: z
		.string()
		.optional()
		.describe("Fetch a ticket by ID to verify integration (e.g. --test TEAM-123)"),
});

type Props = {
	options: z.infer<typeof options>;
};

type Status = "checking" | "choosing" | "authenticating" | "done" | "error";

interface OrgChoice {
	slug: string;
	name: string;
}

export default function LinearAuth({ options }: Props) {
	const [status, setStatus] = useState<Status>("checking");
	const [message, setMessage] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [choices, setChoices] = useState<OrgChoice[]>([]);
	const [selected, setSelected] = useState(0);

	useInput((input, key) => {
		if (status !== "choosing") return;

		if (key.upArrow) {
			setSelected((s) => Math.max(0, s - 1));
		} else if (key.downArrow) {
			setSelected((s) => Math.min(choices.length, s + 1));
		} else if (key.return) {
			handleChoice();
		}
	});

	function handleChoice() {
		const repoRoot = findMainRepoRoot()!;

		// Last option = "Authenticate new workspace"
		if (selected === choices.length) {
			setStatus("authenticating");
			startOAuthFlow().then((result) => {
				if (!result) {
					setError("Authentication failed or timed out. Please try again.");
					setStatus("error");
					return;
				}
				setRepoLinearOrg(repoRoot, result.orgSlug);
				setMessage(`Authenticated as ${result.orgName} (${result.orgSlug})`);
				setStatus("done");
			});
			return;
		}

		// Link existing org
		const choice = choices[selected]!;
		setRepoLinearOrg(repoRoot, choice.slug);
		setMessage(`Linked repo to ${choice.name} (${choice.slug})`);
		setStatus("done");
	}

	useEffect(() => {
		async function run() {
			await new Promise((r) => setTimeout(r, 100));

			if (options.test) {
				const repoRoot = findMainRepoRoot();
				if (!repoRoot) {
					setError("Not inside a git repository");
					setStatus("error");
					return;
				}

				const issue = await getTicketContent(options.test, repoRoot);
				if (!issue) {
					setError(`Could not fetch ticket ${options.test}. Check auth and ticket ID.`);
					setStatus("error");
					return;
				}

				setMessage(renderTicket(issue).trim());
				setStatus("done");
				return;
			}

			if (options.status) {
				const repoRoot = findMainRepoRoot();
				const authStatus = getAuthStatus(repoRoot);

				if (!authStatus.authenticated) {
					setMessage("Not authenticated with Linear");
					setStatus("done");
					return;
				}

				if (authStatus.orgSlug) {
					const valid = await getValidTokens(authStatus.orgSlug);
					const expiry = valid
						? new Date(valid.expires_at).toLocaleString()
						: "expired (refresh failed)";

					setMessage(
						[
							`Organization: ${authStatus.orgName} (${authStatus.orgSlug})`,
							`Token expires: ${expiry}`,
							`Repo linked: ${authStatus.repoLinked ? "yes" : "no"}`,
						].join("\n"),
					);
				}

				setStatus("done");
				return;
			}

			if (options.logout) {
				const repoRoot = findMainRepoRoot();
				if (!repoRoot) {
					setError("Not inside a git repository");
					setStatus("error");
					return;
				}

				const orgSlug = getRepoLinearOrg(repoRoot);
				if (!orgSlug) {
					setMessage("No Linear workspace linked to this repo");
					setStatus("done");
					return;
				}

				removeRepoLinearOrg(repoRoot);
				setMessage(`Unlinked Linear workspace (${orgSlug}) from this repo`);
				setStatus("done");
				return;
			}

			// Default: link or authenticate
			const repoRoot = findMainRepoRoot();
			if (!repoRoot) {
				setError("Not inside a git repository");
				setStatus("error");
				return;
			}

			// Check if repo already has an org linked
			const existingOrg = getRepoLinearOrg(repoRoot);
			if (existingOrg) {
				const valid = await getValidTokens(existingOrg);
				if (valid) {
					setMessage(`Already linked to ${valid.org_name} (${existingOrg})`);
					setStatus("done");
					return;
				}
			}

			// Check for existing authenticated orgs
			const store = readAuthStore();
			const orgs = Object.entries(store).map(([slug, tokens]) => ({
				slug,
				name: tokens.org_name,
			}));

			if (orgs.length === 0) {
				// No existing orgs, go straight to OAuth
				setStatus("authenticating");
				const result = await startOAuthFlow();
				if (!result) {
					setError("Authentication failed or timed out. Please try again.");
					setStatus("error");
					return;
				}
				setRepoLinearOrg(repoRoot, result.orgSlug);
				setMessage(`Authenticated as ${result.orgName} (${result.orgSlug})`);
				setStatus("done");
				return;
			}

			// Let user choose from existing orgs or authenticate a new one
			setChoices(orgs);
			setStatus("choosing");
		}

		run();
	}, [options]);

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
					Linear Auth
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
								{org.name} ({org.slug})
							</Text>
						))}
						<Text>
							{selected === choices.length ? (
								<Text color="cyan" bold>
									{"> "}
								</Text>
							) : (
								<Text>{"  "}</Text>
							)}
							<Text dimColor>Authenticate new workspace...</Text>
						</Text>
					</Box>
					<Box marginTop={1}>
						<Text dimColor>↑/↓ to select, Enter to confirm</Text>
					</Box>
				</Box>
			)}

			{status === "authenticating" && (
				<Box>
					<Text color="cyan">
						<Spinner type="dots" />
					</Text>
					<Text> Authenticating with Linear (check your browser)...</Text>
				</Box>
			)}

			{status === "done" && (
				<Box flexDirection="column">
					{message.split("\n").map((line, i) => (
						<Text key={i} color="green">
							{i === 0 ? "✓ " : "  "}
							{line}
						</Text>
					))}
				</Box>
			)}

			{status === "error" && (
				<Text color="red" bold>
					✗ {error}
				</Text>
			)}
		</Box>
	);
}
