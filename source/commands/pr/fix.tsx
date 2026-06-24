import { useEffect, useState } from "react";
import { Text, Box } from "ink";
import Spinner from "ink-spinner";
import { z } from "zod";
import {
	resolveAIContext,
	renderAIPrompt,
	launchAgent,
	cleanupImages,
	computeFixContext,
} from "../../lib/ai.js";
import { getAiAgent, type AiAgent } from "../../lib/agents/index.js";
import { findMainRepoRoot, getCurrentBranch, extractTicketId } from "../../lib/git.js";
import { getPRInfoAsync } from "../../lib/github.js";
import { santreeSelfArgv } from "../../lib/setup/apply.js";
import { startFixLoop, signalFixLoop, type FixLoopStatus } from "../../lib/fix-loop.js";

export const description =
	"Run the self-driving fix loop: merge conflicts, fixable CI, and 👍-approved review comments";

export const options = z.object({
	signal: z
		.string()
		.optional()
		.describe("Internal: update this ticket's fix-loop dashboard marker, then exit"),
});

type Props = { options: z.infer<typeof options> };

type Status =
	| "loading"
	| "fetching"
	| "launching"
	| "looping"
	| "done-clean"
	| "done-stuck"
	| "signaled"
	| "error";

const KNOWN_STATUSES = new Set<FixLoopStatus>([
	"running",
	"merging",
	"fixing",
	"waiting-ci",
	"stopped:clean",
	"stopped:stuck",
]);

const INTERVAL_MIN = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * santree-driven fix loop for agents that can't self-pace (Codex — no
 * `ScheduleWakeup`/`/loop`). Each iteration regenerates the stateless brief via
 * `computeFixContext` and acts on its directive: run the agent to fix/merge,
 * wait for CI, or stop. santree owns the scheduling, the marker heartbeat, and
 * the "same actionable state repeated → stuck" judgment the agent can't track
 * across fresh `codex exec` invocations.
 */
async function runDrivenFixLoop(opts: {
	branch: string;
	mainRoot: string;
	ticketId: string | null;
	santreeCmd: string;
	agent: AiAgent;
	onPhase: (label: string, iteration: number) => void;
}): Promise<"clean" | "stuck" | "error"> {
	const { branch, mainRoot, ticketId, santreeCmd, agent, onPhase } = opts;
	const MAX_ITERATIONS = 24;
	const WAIT_MS = INTERVAL_MIN * 60 * 1000; // CI still running → check again later
	const SETTLE_MS = 20 * 1000; // let a push re-trigger CI before re-checking
	const signal = (s: FixLoopStatus) => {
		if (ticketId) signalFixLoop(mainRoot, ticketId, s);
	};

	let prevSig: string | null = null;
	let repeat = 0;

	for (let i = 1; i <= MAX_ITERATIONS; i++) {
		const fix = await computeFixContext(branch, santreeCmd);
		if (!fix) return "error";
		const { brief, directive, signature } = fix;

		if (directive === "stop-clean") {
			signal("stopped:clean");
			return "clean";
		}
		if (directive === "stop-stuck") {
			signal("stopped:stuck");
			return "stuck";
		}
		if (directive === "wait") {
			signal("waiting-ci");
			onPhase("waiting for CI", i);
			await sleep(WAIT_MS);
			continue;
		}

		// directive is "merge" or "work" — actionable.
		if (signature === prevSig) {
			repeat += 1;
			// Same actionable state two iterations running after a fix attempt →
			// the agent isn't making progress; stop rather than spin.
			if (repeat >= 2) {
				signal("stopped:stuck");
				return "stuck";
			}
		} else {
			repeat = 0;
			prevSig = signature;
		}

		signal(directive === "merge" ? "merging" : "fixing");
		onPhase(directive === "merge" ? "resolving conflicts" : "applying fixes", i);
		// The brief instructs the agent to make the fixes, commit, push, and
		// resolve approved threads — Codex does this within its autonomous
		// (workspace-write) sandbox. santree just re-invokes it each iteration.
		await agent.runHeadlessAsync(brief, { readOnly: false });
		await sleep(SETTLE_MS);
	}

	// Ran out of iterations without converging — treat as stuck.
	signal("stopped:stuck");
	return "stuck";
}

export default function Fix({ options: opts }: Props) {
	// --signal is a quiet internal marker update — start in its own phase so the
	// full "Fix PR" UI never flashes before the process exits.
	const [status, setStatus] = useState<Status>(opts.signal !== undefined ? "signaled" : "loading");
	const [branch, setBranch] = useState<string | null>(null);
	const [ticketId, setTicketId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [phase, setPhase] = useState<string>("");
	const [iteration, setIteration] = useState(0);
	const agent = getAiAgent();

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

			// Use an absolute santree invocation — the new window's shell may not
			// have santree on PATH.
			const self = santreeSelfArgv([]);
			const santreeCmd = [self.cmd, ...self.args].join(" ");
			if (ctx.ticketId) startFixLoop(ctx.mainRoot, ctx.ticketId, INTERVAL_MIN);

			if (agent.supportsSelfPacedLoop) {
				// Claude: hand the whole loop to a self-paced `/loop` (no interval →
				// ScheduleWakeup keeps context across iterations and can self-stop).
				setStatus("launching");
				const body = renderAIPrompt("fix-loop", ctx, {
					branch: ctx.branch,
					santree_cmd: santreeCmd,
				});
				const prompt = `/loop ${body}`;
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
				}
				return;
			}

			// Codex (and any agent without a self-paced loop): santree drives it.
			setStatus("looping");
			try {
				const outcome = await runDrivenFixLoop({
					branch: ctx.branch,
					mainRoot: ctx.mainRoot,
					ticketId: ctx.ticketId,
					santreeCmd,
					agent,
					onPhase: (label, i) => {
						setPhase(label);
						setIteration(i);
					},
				});
				if (ctx.ticketId) cleanupImages(ctx.ticketId);
				if (outcome === "error") {
					setStatus("error");
					setError("Lost the pull request while looping");
					return;
				}
				setStatus(outcome === "clean" ? "done-clean" : "done-stuck");
				setTimeout(() => process.exit(0), 50);
			} catch (err) {
				setStatus("error");
				setError(err instanceof Error ? err.message : "Fix loop failed");
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
				borderColor={status === "error" || status === "done-stuck" ? "red" : "magenta"}
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
					<Text dimColor>agent:</Text>
					<Text color="magenta" bold>
						{agent.displayName}
					</Text>
				</Box>

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
							✓ Launching {agent.displayName} (looping every {INTERVAL_MIN} min)...
						</Text>
						<Text dimColor>{` /loop <fix-loop for ${ticketId}>`}</Text>
					</Box>
				)}
				{status === "looping" && (
					<Box>
						<Text color="magenta">
							<Spinner type="dots" />
						</Text>
						<Text>
							{` ${agent.displayName} fix loop — iteration ${iteration}${phase ? `: ${phase}` : ""}`}
						</Text>
					</Box>
				)}
				{status === "done-clean" && (
					<Text color="green" bold>
						✓ Fix loop done — PR is clean
					</Text>
				)}
				{status === "done-stuck" && (
					<Text color="yellow" bold>
						■ Fix loop stopped — only manual issues remain
					</Text>
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
