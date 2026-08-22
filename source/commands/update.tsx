import { useEffect, useState } from "react";
import { Text, Box, useApp } from "ink";
import Spinner from "ink-spinner";
import { z } from "zod";
import {
	CURRENT_VERSION,
	CLAUDE_CODE_PACKAGE,
	getLatestVersion,
	getLatestVersionFor,
	getInstalledClaudeVersion,
	isUpdateAvailable,
	detectPackageManager,
	getInstallCommand,
	getInstallCommandFor,
	type PackageManager,
} from "../lib/version.js";
import { spawnAsync } from "../lib/exec.js";

interface ClaudeStatus {
	installed: string | null;
	latest: string | null;
}

export const description = "Update santree to the latest version on npm";

export const options = z.object({
	force: z.boolean().optional().describe("Reinstall even if already on the latest version"),
	pm: z
		.enum(["npm", "pnpm", "yarn"])
		.optional()
		.describe("Override package manager auto-detection"),
});

type Props = {
	options: z.infer<typeof options>;
};

type Status = "checking" | "up-to-date" | "installing" | "done" | "error";

const TAIL_LINES = 8;

function tail(text: string, n: number): string[] {
	return text
		.split("\n")
		.filter((l) => l.length > 0)
		.slice(-n);
}

export default function Update({ options }: Props) {
	const { exit } = useApp();
	const [status, setStatus] = useState<Status>("checking");
	const [latest, setLatest] = useState<string | null>(null);
	const [pm, setPm] = useState<PackageManager>("npm");
	const [installCmd, setInstallCmd] = useState<string>("");
	const [output, setOutput] = useState<string>("");
	const [error, setError] = useState<string | null>(null);
	const [claude, setClaude] = useState<ClaudeStatus | null>(null);

	useEffect(() => {
		(async () => {
			await new Promise((r) => setTimeout(r, 80));

			// Check santree + claude versions in parallel.
			const [latestVersion, latestClaude] = await Promise.all([
				getLatestVersion({ force: true }),
				getLatestVersionFor(CLAUDE_CODE_PACKAGE, { force: true }),
			]);
			setLatest(latestVersion);
			setClaude({ installed: getInstalledClaudeVersion(), latest: latestClaude });

			const detectedPm = options.pm ?? detectPackageManager();
			setPm(detectedPm);
			const cmd = getInstallCommand(detectedPm);
			setInstallCmd(cmd.display);

			if (!latestVersion) {
				setStatus("error");
				setError(
					"Could not read the latest version from registry.npmjs.org. Check your network, proxy, or npm registry access.",
				);
				setTimeout(() => exit(), 100);
				return;
			}

			if (!options.force && !isUpdateAvailable(CURRENT_VERSION, latestVersion)) {
				setStatus("up-to-date");
				setTimeout(() => exit(), 100);
				return;
			}

			setStatus("installing");
			const result = await spawnAsync(cmd.cmd, cmd.args, {
				onOutput: (data) => setOutput(data),
			});

			if (result.code === 0) {
				setStatus("done");
			} else {
				setStatus("error");
				setError(`${cmd.display} exited with code ${result.code}`);
			}
			setTimeout(() => exit(), 100);
		})();
	}, []);

	return (
		<Box flexDirection="column" padding={1}>
			<Box marginBottom={1}>
				<Text bold color="cyan">
					Santree Update
				</Text>
			</Box>

			<Box flexDirection="column" gap={0}>
				<Box gap={1}>
					<Text dimColor>current:</Text>
					<Text>v{CURRENT_VERSION}</Text>
				</Box>
				{latest && (
					<Box gap={1}>
						<Text dimColor>latest: </Text>
						<Text color={isUpdateAvailable(CURRENT_VERSION, latest) ? "yellow" : "green"}>
							v{latest}
						</Text>
					</Box>
				)}
				{installCmd && (
					<Box gap={1}>
						<Text dimColor>via: </Text>
						<Text>
							{installCmd} <Text dimColor>(detected: {pm})</Text>
						</Text>
					</Box>
				)}
			</Box>

			<Box marginTop={1}>
				{status === "checking" && (
					<Box gap={1}>
						<Text color="cyan">
							<Spinner type="dots" />
						</Text>
						<Text>Checking npm registry...</Text>
					</Box>
				)}
				{status === "installing" && (
					<Box gap={1}>
						<Text color="cyan">
							<Spinner type="dots" />
						</Text>
						<Text>Running {installCmd}...</Text>
					</Box>
				)}
				{status === "up-to-date" && (
					<Text color="green" bold>
						✓ Already on the latest version
					</Text>
				)}
				{status === "done" && latest && (
					<Text color="green" bold>
						✓ Updated to v{latest}
					</Text>
				)}
				{status === "error" && error && (
					<Text color="red" bold>
						✗ {error}
					</Text>
				)}
			</Box>

			{(status === "installing" || status === "error") && output && (
				<Box
					marginTop={1}
					flexDirection="column"
					borderStyle="single"
					borderColor="gray"
					paddingX={1}
				>
					{tail(output, TAIL_LINES).map((line, i) => (
						<Text key={i} dimColor>
							{line}
						</Text>
					))}
				</Box>
			)}

			{claude && claude.installed && (
				<Box marginTop={1} flexDirection="column">
					{claude.latest && isUpdateAvailable(claude.installed, claude.latest) ? (
						<>
							<Text color="yellow">
								⬆ Claude Code {claude.installed} → {claude.latest} available
							</Text>
							<Text dimColor>
								Run: {getInstallCommandFor(pm, `${CLAUDE_CODE_PACKAGE}@latest`).display}
							</Text>
						</>
					) : claude.latest ? (
						<Text dimColor>✓ Claude Code {claude.installed} is up to date</Text>
					) : null}
				</Box>
			)}
		</Box>
	);
}
