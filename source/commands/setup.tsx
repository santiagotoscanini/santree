import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { z } from "zod";
import {
	buildContext,
	buildSteps,
	type SetupStep,
	type SetupContext,
	type StepResult,
} from "../lib/setup/steps.js";

export const description = "Guided setup — configure editor, diff tool, Claude Code & this repo";

export const options = z.object({
	dryRun: z.boolean().default(false).describe("Preview what would change without writing anything"),
	yes: z.boolean().default(false).describe("Apply all recommended steps non-interactively"),
});

type Props = { options: z.infer<typeof options> };

type Phase = "detecting" | "select" | "configure" | "applying" | "done";

interface AppliedResult {
	step: SetupStep;
	result: StepResult;
}

export default function Setup({ options: opts }: Props) {
	const dryRun = opts.dryRun;
	const [phase, setPhase] = useState<Phase>("detecting");
	const [steps, setSteps] = useState<SetupStep[]>([]);
	const [ctx, setCtx] = useState<SetupContext | null>(null);

	// select phase
	const [cursor, setCursor] = useState(0);
	const [selected, setSelected] = useState<Set<number>>(new Set());

	// configure phase
	const [configQueue, setConfigQueue] = useState<number[]>([]);
	const [configPos, setConfigPos] = useState(0);
	const [optionCursor, setOptionCursor] = useState(0);
	const [choices, setChoices] = useState<Record<string, string>>({});

	// applying phase
	const [applyIdx, setApplyIdx] = useState(0);
	const [applyOrder, setApplyOrder] = useState<number[]>([]);
	const [applied, setApplied] = useState<AppliedResult[]>([]);
	const [running, setRunning] = useState<string | null>(null);

	// ── Detect ────────────────────────────────────────────────────────────────
	useEffect(() => {
		(async () => {
			await new Promise((r) => setTimeout(r, 80)); // let the spinner paint first
			const c = buildContext(dryRun);
			const all = buildSteps(c).filter((s) => s.detect === "actionable");
			setCtx(c);
			setSteps(all);
			if (all.length === 0) {
				setPhase("done");
				return;
			}
			const rec = new Set<number>();
			all.forEach((s, i) => {
				if (s.recommended) rec.add(i);
			});
			setSelected(rec);
			if (opts.yes) {
				beginApply(all, rec, {});
			} else {
				setPhase("select");
			}
		})();
	}, []);

	function beginApply(allSteps: SetupStep[], sel: Set<number>, picked: Record<string, string>) {
		const order = [...sel].sort((a, b) => a - b);
		// For steps with options that weren't interactively chosen, default to the
		// first option (used by --yes and single-option steps).
		const merged = { ...picked };
		for (const i of order) {
			const s = allSteps[i]!;
			if (s.options && s.options.length > 0 && merged[s.id] === undefined) {
				merged[s.id] = s.options[0]!.value;
			}
		}
		setChoices(merged);
		setApplyOrder(order);
		setApplyIdx(0);
		setApplied([]);
		setPhase("applying");
	}

	// ── Select phase input ──────────────────────────────────────────────────────
	useInput(
		(input, key) => {
			if (key.escape) process.exit(0);
			else if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
			else if (key.downArrow) setCursor((c) => Math.min(steps.length - 1, c + 1));
			else if (input === " ") {
				setSelected((s) => {
					const next = new Set(s);
					if (next.has(cursor)) next.delete(cursor);
					else next.add(cursor);
					return next;
				});
			} else if (key.return) {
				// Steps needing an interactive choice (>1 option).
				const queue = [...selected]
					.sort((a, b) => a - b)
					.filter((i) => (steps[i]!.options?.length ?? 0) > 1);
				if (queue.length > 0) {
					setConfigQueue(queue);
					setConfigPos(0);
					setOptionCursor(0);
					setPhase("configure");
				} else {
					beginApply(steps, selected, {});
				}
			}
		},
		{ isActive: phase === "select" },
	);

	// ── Configure phase input ───────────────────────────────────────────────────
	useInput(
		(_input, key) => {
			if (key.escape) {
				setPhase("select");
				return;
			}
			const stepIdx = configQueue[configPos]!;
			const step = steps[stepIdx]!;
			const optCount = step.options!.length;
			if (key.upArrow) setOptionCursor((c) => Math.max(0, c - 1));
			else if (key.downArrow) setOptionCursor((c) => Math.min(optCount - 1, c + 1));
			else if (key.return) {
				const value = step.options![optionCursor]!.value;
				const nextChoices = { ...choices, [step.id]: value };
				setChoices(nextChoices);
				if (configPos + 1 < configQueue.length) {
					setConfigPos((p) => p + 1);
					setOptionCursor(0);
				} else {
					beginApply(steps, selected, nextChoices);
				}
			}
		},
		{ isActive: phase === "configure" },
	);

	// ── Applying phase ──────────────────────────────────────────────────────────
	useEffect(() => {
		if (phase !== "applying") return;
		if (applyIdx >= applyOrder.length) {
			setRunning(null);
			setPhase("done");
			return;
		}
		const step = steps[applyOrder[applyIdx]!]!;
		setRunning(step.title);
		let cancelled = false;
		(async () => {
			await new Promise((r) => setTimeout(r, 60)); // paint "running" frame
			let result: StepResult;
			try {
				result = await step.apply(choices[step.id]);
			} catch (e) {
				result = { ok: false, message: e instanceof Error ? e.message : String(e) };
			}
			if (cancelled) return;
			setApplied((prev) => [...prev, { step, result }]);
			setApplyIdx((i) => i + 1);
		})();
		return () => {
			cancelled = true;
		};
	}, [phase, applyIdx]);

	// ── Exit ────────────────────────────────────────────────────────────────────
	useEffect(() => {
		if (phase === "done") {
			const t = setTimeout(() => process.exit(0), 120);
			return () => clearTimeout(t);
		}
	}, [phase]);

	// ── Render ──────────────────────────────────────────────────────────────────
	const title = (
		<Box marginBottom={1}>
			<Text bold color="cyan">
				santree setup
			</Text>
			{dryRun && <Text color="yellow"> (dry run — nothing will be written)</Text>}
		</Box>
	);

	if (phase === "detecting") {
		return (
			<Box flexDirection="column" padding={1}>
				{title}
				<Box>
					<Text color="cyan">
						<Spinner type="dots" />
					</Text>
					<Text> Detecting your setup…</Text>
				</Box>
			</Box>
		);
	}

	if (phase === "done" && steps.length === 0) {
		return (
			<Box flexDirection="column" padding={1}>
				{title}
				<Text color="green">✓ Everything's already configured — you're all set.</Text>
				{!ctx?.repoRoot && (
					<Text dimColor>
						Tip: run this again inside a git repo to configure repo-specific bits.
					</Text>
				)}
			</Box>
		);
	}

	if (phase === "select") {
		let lastScope: string | null = null;
		return (
			<Box flexDirection="column" padding={1}>
				{title}
				<Text>What should I set up? (Space toggles, Enter applies)</Text>
				<Box flexDirection="column" marginTop={1}>
					{steps.map((s, i) => {
						const head = s.scope !== lastScope;
						lastScope = s.scope;
						const box = selected.has(i) ? "[x]" : "[ ]";
						const isCur = i === cursor;
						return (
							<Box flexDirection="column" key={s.id}>
								{head && <Text dimColor>{s.scope === "global" ? "Global" : "This repo"}</Text>}
								<Text>
									<Text color={isCur ? "cyan" : undefined} bold={isCur}>
										{isCur ? "> " : "  "}
										{box}
									</Text>{" "}
									{s.title}
									{s.kind === "spawn" && <Text color="yellow"> ⤷ runs a command</Text>}
								</Text>
								{isCur && <Text dimColor>{"      " + s.detail}</Text>}
							</Box>
						);
					})}
				</Box>
				<Box marginTop={1}>
					<Text dimColor>↑/↓ move · Space toggle · Enter apply · Esc cancel</Text>
				</Box>
			</Box>
		);
	}

	if (phase === "configure") {
		const step = steps[configQueue[configPos]!]!;
		return (
			<Box flexDirection="column" padding={1}>
				{title}
				<Text bold>{step.title}</Text>
				<Text>{step.optionPrompt || "Pick one:"}</Text>
				<Box flexDirection="column" marginTop={1}>
					{step.options!.map((o, i) => (
						<Text key={o.value}>
							<Text color={i === optionCursor ? "cyan" : undefined} bold={i === optionCursor}>
								{i === optionCursor ? "> " : "  "}
							</Text>
							{o.label}
						</Text>
					))}
				</Box>
				<Box marginTop={1}>
					<Text dimColor>
						↑/↓ select · Enter confirm
						{configQueue.length > 1 ? `  (${configPos + 1}/${configQueue.length})` : ""}
					</Text>
				</Box>
			</Box>
		);
	}

	// applying / done
	return (
		<Box flexDirection="column" padding={1}>
			{title}
			{applied.map(({ step, result }, i) => (
				<Text key={i} color={result.ok ? "green" : "red"}>
					{result.ok ? "✓" : "✗"} {step.title} <Text dimColor>— {result.message}</Text>
				</Text>
			))}
			{phase === "applying" && running && (
				<Box>
					<Text color="cyan">
						<Spinner type="dots" />
					</Text>
					<Text> {running}…</Text>
				</Box>
			)}
			{phase === "done" && (
				<Box marginTop={1} flexDirection="column">
					<Text color="green" bold>
						Done. Run `santree doctor` to verify.
					</Text>
					{!dryRun && ctx?.shell && (
						<Text dimColor>
							Restart your shell (or `source {ctx.shell.rcPath}`) to load the changes.
						</Text>
					)}
				</Box>
			)}
		</Box>
	);
}
