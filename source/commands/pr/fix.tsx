import { useEffect, useState } from "react";
import { Text, Box } from "ink";
import Spinner from "ink-spinner";
import { z } from "zod";
import { resolveAIContext, renderAIPrompt, launchAgent, cleanupImages } from "../../lib/ai.js";
import { findMainRepoRoot, getCurrentBranch, extractTicketId } from "../../lib/git.js";
import { getPRInfoAsync } from "../../lib/github.js";
import { santreeSelfArgv } from "../../lib/setup/apply.js";
import { startFixLoop, signalFixLoop, type FixLoopStatus } from "../../lib/fix-loop.js";

export const description =
	"Fix the PR in a loop: merge conflicts, fixable CI failures, and review comments you reacted 👍 to";

export const options = z.object({
	signal: z
		.string()
		.optional()
		.describe("Internal: update this ticket's fix-loop dashboard marker, then exit"),
});

type Props = { options: z.infer<typeof options> };

type Status = "loading" | "fetching" | "launching" | "signaled" | "error";

const KNOWN_STATUSES = new Set<FixLoopStatus>([
	"running",
	"merging",
	"fixing",
	"waiting-ci",
	"stopped:clean",
	"stopped:stuck",
]);

export default function Fix({ options: opts }: Props) {
	// --signal is a quiet internal marker update — start in its own phase so the
	// full "Fix PR" UI never flashes before the process exits.
	const [status, setStatus] = useState<Status>(opts.signal !== undefined ? "signaled" : "loading");
	const [branch, setBranch] = useState<string | null>(null);
	const [ticketId, setTicketId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		// --signal: lightweight marker update invoked by the loop body. Resolve
		// repo/ticket offline (no tracker fetch) and exit fast.
		if (opts.signal !== undefined) {
			const mainRoot = findMainRepoRoot();
			const br = getCurrentBranch();
			const tid = br ? extractTicketId(br) : null;
			if (mainRoot && tid) {
				const s = (
					KNOWN_STATUSES.has(opts.signal as FixLoopStatus) ? opts.signal : "running"
				) as FixLoopStatus;
				signalFixLoop(mainRoot, tid, s);
			}
			setStatus("signaled");
			setTimeout(() => process.exit(0), 20);
			return;
		}

		async function init() {
			await new Promise((r) => setTimeout(r, 100));

			setStatus("fetching");
			const result = await resolveAIContext();
			if (!result.ok) {
				setStatus("error");
				setError(result.error);
				return;
			}

			const ctx = result.context;
			setBranch(ctx.branch);
			setTicketId(ctx.ticketId);

			const prInfo = await getPRInfoAsync(ctx.branch);
			if (!prInfo) {
				setStatus("error");
				setError(`No pull request found for branch '${ctx.branch}'`);
				return;
			}

			setStatus("launching");

			// The loop refreshes its own context each iteration via `pr context`,
			// so we only build the standing instructions here. Use an absolute
			// santree invocation (the new window's shell may not have it on PATH).
			const self = santreeSelfArgv([]);
			const santreeCmd = [self.cmd, ...self.args].join(" ");
			const body = renderAIPrompt("fix-loop", ctx, {
				branch: ctx.branch,
				santree_cmd: santreeCmd,
			});
			// No interval → `/loop` self-paces via ScheduleWakeup (keeps context
			// across iterations and can genuinely stop on our conditions). Passing
			// an interval (`/loop 5m …`) instead picks cron mode — fresh context
			// each firing, can't self-terminate — which is wrong for a fix loop.
			const prompt = `/loop ${body}`;
			if (ctx.ticketId) startFixLoop(ctx.mainRoot, ctx.ticketId, 5);

			try {
				const child = launchAgent(prompt);

				child.on("error", (err) => {
					setStatus("error");
					setError(`Failed to launch agent: ${err.message}`);
				});

				child.on("close", () => {
					if (ctx.ticketId) cleanupImages(ctx.ticketId);
					process.exit(0);
				});
			} catch (err) {
				setStatus("error");
				setError(err instanceof Error ? err.message : "Failed to launch agent");
				return;
			}
		}

		init();
	}, []);

	if (status === "signaled") {
		return <Text dimColor>fix-loop signal: {opts.signal}</Text>;
	}

	return (
		<Box flexDirection="column" padding={1} width="100%">
			<Box marginBottom={1}>
				<Text bold color="cyan">
					Fix PR — loop
				</Text>
			</Box>

			<Box
				flexDirection="column"
				borderStyle="round"
				borderColor={status === "error" ? "red" : "magenta"}
				paddingX={1}
				width="100%"
			>
				{branch && (
					<Box gap={1}>
						<Text dimColor>branch:</Text>
						<Text color="cyan" bold>
							{branch}
						</Text>
					</Box>
				)}

				{ticketId && (
					<Box gap={1}>
						<Text dimColor>ticket:</Text>
						<Text color="blue" bold>
							{ticketId}
						</Text>
					</Box>
				)}

				<Box gap={1}>
					<Text dimColor>mode:</Text>
					<Text backgroundColor="magenta" color="white" bold>
						{" fix loop "}
					</Text>
				</Box>
			</Box>

			<Box marginTop={1}>
				{(status === "loading" || status === "fetching") && (
					<Box>
						<Text color="cyan">
							<Spinner type="dots" />
						</Text>
						<Text>
							{" "}
							{status === "loading" ? "Loading..." : "Fetching ticket and PR feedback..."}
						</Text>
					</Box>
				)}
				{status === "launching" && (
					<Box flexDirection="column">
						<Text color="green" bold>
							✓ Launching Claude (looping every 5 min)...
						</Text>
						<Text dimColor>{` claude "/loop <fix-loop for ${ticketId}>"`}</Text>
					</Box>
				)}
				{status === "error" && (
					<Text color="red" bold>
						✗ {error}
					</Text>
				)}
			</Box>
		</Box>
	);
}
