import { useEffect, useRef, useState } from "react";
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
import { loadDiagnostics, type DiagnosticsData, type InfoRow } from "../lib/config/diagnostics.js";
import { getConfiguredEditor, getConfiguredDiffTool } from "../lib/config-store.js";
import { pruneSessionSignalHooks } from "../lib/claude-config.js";
import TrackerPicker from "../lib/config/TrackerPicker.js";
import { findMainRepoRoot } from "../lib/git.js";
import { getActiveTrackerKind, isRepoTrackerConfigured } from "../lib/trackers/index.js";
import { getRepoLinearOrg } from "../lib/trackers/linear/index.js";
import type { IssueTrackerKind } from "../lib/trackers/types.js";

export const description =
	"Inspect and configure santree — tools, Claude Code integration, and this repo";

export const options = z.object({
	check: z
		.boolean()
		.default(false)
		.describe("Print a read-only status report and exit (non-interactive)"),
	yes: z.boolean().default(false).describe("Apply all recommended changes non-interactively"),
	dryRun: z.boolean().default(false).describe("Preview changes without writing anything"),
});

type Props = { options: z.infer<typeof options> };

// ── Row model ────────────────────────────────────────────────────────────────
// Every line in the panel is a Row. `info` rows are read-only (santree can
// report but not change them); the rest are interactive.
type RowKind = "toggle" | "select" | "action" | "tracker" | "info";
type Scope = "system" | "global" | "repo";

interface Row {
	id: string;
	kind: RowKind;
	title: string;
	detail: string;
	scope: Scope;
	ok: boolean;
	required: boolean;
	recommended: boolean;
	/** toggle: currently enabled. */
	on?: boolean;
	/** select/info: current value summary. */
	value?: string;
	lines: string[];
	hint?: string;
	/** Underlying configurable step (absent on pure-info rows). */
	step?: SetupStep;
}

// Presentation scope — overrides the catalog's coarse global/repo so install
// tools land under "System" next to the read-only version rows.
const SYSTEM_STEP_IDS = new Set(["claude", "gh", "tmux"]);
const REPO_STEP_IDS = new Set(["tracker", "gitignore", "scaffold"]);

function presScope(id: string): Scope {
	if (SYSTEM_STEP_IDS.has(id)) return "system";
	if (REPO_STEP_IDS.has(id)) return "repo";
	return "global";
}

const ROW_ORDER = [
	// System
	"santree",
	"node",
	"git",
	"multiplexer",
	"claude",
	"gh",
	"tmux",
	"workspace-editor",
	// Global
	"editor",
	"diff-tool",
	"statusline",
	"remote-control",
	// This repo
	"tracker",
	"gitignore",
	"scaffold",
];

const SCOPE_TITLES: Record<Scope, string> = {
	system: "System",
	global: "Global (editor & Claude Code)",
	repo: "This repo",
};

/** Current resolved value for the value-bearing select rows (env override → config file). */
function currentConfigValue(id: string): string | undefined {
	if (id === "editor") return getConfiguredEditor();
	if (id === "diff-tool") return getConfiguredDiffTool();
	return undefined;
}

function infoToRow(info: InfoRow): Row {
	return {
		id: info.id,
		kind: "info",
		title: info.title,
		detail: info.description,
		scope: info.scope,
		ok: info.ok,
		required: info.required,
		recommended: false,
		lines: info.lines,
		hint: info.hint,
		value: info.lines[0] ? compact(info.lines[0]) : undefined,
	};
}

function stepToRow(s: SetupStep, detail?: { lines: string[]; hint?: string }): Row {
	const ok = s.detect === "ok";
	let kind: RowKind;
	if (s.id === "tracker") kind = "tracker";
	else if (s.unapply) kind = "toggle";
	else if (s.options && s.options.length) kind = "select";
	else kind = ok ? "info" : "action";

	const row: Row = {
		id: s.id,
		kind,
		title: s.title,
		detail: s.detail,
		scope: presScope(s.id),
		ok,
		required: s.id === "gh" || s.id === "claude",
		recommended: s.recommended,
		on: s.unapply ? ok : undefined,
		lines: detail?.lines ?? [],
		hint: detail?.hint,
		step: s,
	};
	if (kind === "select") row.value = currentConfigValue(s.id) || (ok ? "set" : "not set");
	if (kind === "tracker") row.value = ok ? compact(detail?.lines?.[0] || "") : "not configured";
	if (kind === "info" && detail?.lines?.[0]) row.value = compact(detail.lines[0]);
	return row;
}

/** "Label: value" → "value"; otherwise the line unchanged. */
function compact(line: string): string {
	const idx = line.indexOf(": ");
	return idx >= 0 ? line.slice(idx + 2) : line;
}

function buildRows(ctx: SetupContext, diag: DiagnosticsData): Row[] {
	const rows: Row[] = [];
	const steps = buildSteps(ctx).filter((s) => s.detect !== "unavailable");
	for (const s of steps) {
		if (s.id === "tmux" && diag.muxActive) continue; // shown as the multiplexer info row
		rows.push(stepToRow(s, diag.stepDetail.get(s.id)));
	}
	for (const info of diag.infoRows) rows.push(infoToRow(info));
	rows.sort((a, b) => {
		const ia = ROW_ORDER.indexOf(a.id);
		const ib = ROW_ORDER.indexOf(b.id);
		return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
	});
	return rows;
}

function rowIcon(row: Row): { char: string; color: string } {
	const on = row.kind === "toggle" ? !!row.on : row.ok;
	if (on) return { char: "✓", color: "green" };
	return row.required ? { char: "✗", color: "red" } : { char: "○", color: "yellow" };
}

function rowSummary(row: Row): string {
	switch (row.kind) {
		case "toggle":
			return row.on ? "on" : "off";
		case "select":
			return row.value || "";
		case "action":
			return row.required ? "missing" : "not installed";
		case "tracker":
			return row.value || "";
		case "info":
			return row.ok ? row.value || "✓" : "—";
	}
}

/** Truncate to a visible width with an ellipsis. Inputs are plain (no ANSI). */
function clamp(s: string, w: number): string {
	if (w <= 0) return "";
	return s.length <= w ? s : s.slice(0, w - 1) + "…";
}

/** Per-row action hint shown in the footer when that row is focused. */
function footerVerb(row: Row | undefined): string {
	switch (row?.kind) {
		case "toggle":
			return "Space toggle";
		case "select":
			return "Enter change";
		case "action":
			return "Enter run";
		case "tracker":
			return "Enter choose";
		default:
			return "read-only";
	}
}

const PANEL_WIDTH = Math.max(40, Math.min((process.stdout.columns || 80) - 2, 96));

// ── Component ────────────────────────────────────────────────────────────────
type Mode = "loading" | "list" | "submenu" | "tracker";

export default function Config({ options: opts }: Props) {
	const dryRun = opts.dryRun;
	const ctxRef = useRef<SetupContext | null>(null);
	const diagRef = useRef<DiagnosticsData | null>(null);

	const [mode, setMode] = useState<Mode>("loading");
	const [rows, setRows] = useState<Row[]>([]);
	const [cursor, setCursor] = useState(0);
	const [submenu, setSubmenu] = useState<{ row: Row; cursor: number } | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [toast, setToast] = useState<{ ok: boolean; message: string } | null>(null);

	// repo context for the tracker picker
	const [repoRoot, setRepoRoot] = useState<string | null>(null);
	const [activeKind, setActiveKind] = useState<IssueTrackerKind | null>(null);
	const [activeOrg, setActiveOrg] = useState<string | null>(null);

	// Every row is focusable so you can inspect read-only rows too; Space/Enter
	// just no-op on `info` rows. This keeps the cursor's travel predictable and
	// lets the detail panel show full info for whatever's highlighted.
	const selectable = rows;
	const current = selectable[cursor];

	// ── Initial load ────────────────────────────────────────────────────────────
	useEffect(() => {
		(async () => {
			await new Promise((r) => setTimeout(r, 80));
			const ctx = buildContext(dryRun);
			ctxRef.current = ctx;
			const diag = await loadDiagnostics();
			diagRef.current = diag;
			const built = buildRows(ctx, diag);

			const root = findMainRepoRoot();
			setRepoRoot(root);
			if (root && isRepoTrackerConfigured(root)) {
				const kind = getActiveTrackerKind(root);
				setActiveKind(kind);
				if (kind === "linear") setActiveOrg(getRepoLinearOrg(root));
			}

			if (opts.check) {
				setRows(built);
				setMode("list"); // rendered read-only; effect below exits
				return;
			}
			// Self-heal: the session-state feature was removed, so strip any
			// leftover session-signal hooks that would otherwise fire a missing
			// command on every Claude event. Skipped in --check (read-only).
			const prunedHooks = dryRun ? 0 : pruneSessionSignalHooks();
			if (opts.yes) {
				await applyRecommended(ctx, built);
				return;
			}
			setRows(built);
			if (prunedHooks > 0) {
				setToast({
					ok: true,
					message: `Removed ${prunedHooks} stale session-signal hook${prunedHooks === 1 ? "" : "s"} from Claude Code settings`,
				});
			}
			setMode("list");
		})();
	}, []);

	// ── --check / --yes exit ─────────────────────────────────────────────────────
	useEffect(() => {
		if (opts.check && mode === "list" && rows.length > 0) {
			const t = setTimeout(() => {
				const requiredMissing = rows.some((r) => r.required && !r.ok);
				process.exit(requiredMissing ? 1 : 0);
			}, 80);
			return () => clearTimeout(t);
		}
	}, [mode, rows, opts.check]);

	async function applyRecommended(ctx: SetupContext, built: Row[]) {
		// Non-interactive: apply recommended, reversible/file-kind steps only.
		// Spawn installs and the tracker picker need a human, so we skip them.
		const results: { title: string; result: StepResult }[] = [];
		for (const row of built) {
			const s = row.step;
			if (!s) continue;
			if (s.id === "tracker") continue;
			if (s.kind === "spawn") continue;
			if (s.detect !== "actionable" || !s.recommended) continue;
			const choice = s.options?.[0]?.value;
			try {
				results.push({ title: s.title, result: await s.apply(choice) });
			} catch (e) {
				results.push({
					title: s.title,
					result: { ok: false, message: e instanceof Error ? e.message : String(e) },
				});
			}
		}
		setRows(
			results.map((r) => ({
				id: r.title,
				kind: "info" as const,
				title: r.title,
				detail: "",
				scope: "global" as const,
				ok: r.result.ok,
				required: false,
				recommended: false,
				lines: [r.result.message],
			})),
		);
		setMode("list");
		setTimeout(() => process.exit(0), 100);
	}

	function rebuildRows() {
		const ctx = ctxRef.current!;
		const diag = diagRef.current!;
		setRows(buildRows(ctx, diag));
	}

	async function applyStep(
		step: SetupStep,
		action: "apply" | "unapply",
		choice: string | undefined,
	) {
		setBusy(`${action === "unapply" ? "Disabling" : "Applying"} ${step.title}…`);
		setToast(null);
		await new Promise((r) => setTimeout(r, 50));
		let result: StepResult;
		try {
			const fn = action === "unapply" ? step.unapply! : step.apply;
			result = await fn(choice);
		} catch (e) {
			result = { ok: false, message: e instanceof Error ? e.message : String(e) };
		}
		// Spawn steps may have installed a tool — refresh version diagnostics.
		if (step.kind === "spawn" || choice?.startsWith("install:")) {
			diagRef.current = await loadDiagnostics();
		}
		rebuildRows();
		setToast({ ok: result.ok, message: result.message });
		setBusy(null);
	}

	function activate(row: Row) {
		if (row.kind === "tracker") {
			setMode("tracker");
			return;
		}
		if (row.kind === "toggle") {
			toggleRow(row);
			return;
		}
		if (row.kind === "select") {
			const opts2 = row.step?.options ?? [];
			if (opts2.length <= 1) {
				void applyStep(row.step!, "apply", opts2[0]?.value);
			} else {
				setSubmenu({ row, cursor: 0 });
				setMode("submenu");
			}
			return;
		}
		if (row.kind === "action") {
			void applyStep(row.step!, "apply", row.step?.options?.[0]?.value);
		}
	}

	function toggleRow(row: Row) {
		const step = row.step!;
		if (row.on) {
			void applyStep(step, "unapply", undefined);
		} else if (step.options && step.options.length > 1) {
			// Turning on a step that needs a choice (e.g. gitignore target).
			setSubmenu({ row, cursor: 0 });
			setMode("submenu");
		} else {
			void applyStep(step, "apply", step.options?.[0]?.value);
		}
	}

	// ── List input ────────────────────────────────────────────────────────────────
	useInput(
		(_input, key) => {
			if (key.escape || key.leftArrow) process.exit(0);
			else if (key.upArrow) {
				setToast(null);
				setCursor((c) => Math.max(0, c - 1));
			} else if (key.downArrow) {
				setToast(null);
				setCursor((c) => Math.min(selectable.length - 1, c + 1));
			} else if (_input === " ") {
				if (current?.kind === "toggle") toggleRow(current);
			} else if (key.return || key.rightArrow) {
				if (current) activate(current);
			}
		},
		{ isActive: mode === "list" && !busy && !opts.check && !opts.yes },
	);

	// ── Submenu input ───────────────────────────────────────────────────────────
	useInput(
		(_input, key) => {
			if (!submenu) return;
			const opts2 = submenu.row.step!.options!;
			if (key.escape || key.leftArrow) {
				setSubmenu(null);
				setMode("list");
			} else if (key.upArrow) {
				setSubmenu((s) => (s ? { ...s, cursor: Math.max(0, s.cursor - 1) } : s));
			} else if (key.downArrow) {
				setSubmenu((s) => (s ? { ...s, cursor: Math.min(opts2.length - 1, s.cursor + 1) } : s));
			} else if (key.return) {
				const choice = opts2[submenu.cursor]!.value;
				const step = submenu.row.step!;
				setSubmenu(null);
				setMode("list");
				void applyStep(step, "apply", choice);
			}
		},
		{ isActive: mode === "submenu" && !busy },
	);

	// ── Render ──────────────────────────────────────────────────────────────────
	const title = (
		<Box marginBottom={1}>
			<Text bold color="cyan">
				santree config
			</Text>
			{dryRun && <Text color="yellow"> (dry run — nothing will be written)</Text>}
			{opts.check && <Text dimColor> — status report</Text>}
		</Box>
	);

	if (mode === "loading") {
		return (
			<Box flexDirection="column" padding={1}>
				{title}
				<Box>
					<Text color="cyan">
						<Spinner type="dots" />
					</Text>
					<Text> Inspecting your setup…</Text>
				</Box>
			</Box>
		);
	}

	if (opts.yes) {
		return (
			<Box flexDirection="column" padding={1}>
				{title}
				{rows.length === 0 ? (
					<Text color="green">Nothing to apply — your setup already matches.</Text>
				) : (
					rows.map((r) => (
						<Text key={r.id} color={r.ok ? "green" : "red"}>
							{r.ok ? "✓" : "✗"} {r.title} <Text dimColor>— {r.lines[0]}</Text>
						</Text>
					))
				)}
			</Box>
		);
	}

	if (mode === "tracker") {
		return (
			<Box flexDirection="column" padding={1}>
				{title}
				<TrackerPicker
					repoRoot={repoRoot!}
					activeKind={activeKind}
					activeOrg={activeOrg}
					onApplied={(message) => {
						const root = repoRoot!;
						setActiveKind(getActiveTrackerKind(root));
						setActiveOrg(getActiveTrackerKind(root) === "linear" ? getRepoLinearOrg(root) : null);
						(async () => {
							diagRef.current = await loadDiagnostics();
							rebuildRows();
						})();
						setToast({ ok: true, message });
						setMode("list");
					}}
					onCancel={() => setMode("list")}
				/>
			</Box>
		);
	}

	if (mode === "submenu" && submenu) {
		const step = submenu.row.step!;
		return (
			<Box flexDirection="column" padding={1}>
				{title}
				<Text bold>{step.title}</Text>
				<Text dimColor>{step.optionPrompt || "Pick one:"}</Text>
				<Box flexDirection="column" marginTop={1}>
					{step.options!.map((o, i) => (
						<Text key={o.value}>
							<Text color={i === submenu.cursor ? "cyan" : undefined} bold={i === submenu.cursor}>
								{i === submenu.cursor ? "> " : "  "}
							</Text>
							{o.label}
						</Text>
					))}
				</Box>
				<Box marginTop={1}>
					<Text dimColor>↑/↓ select · Enter confirm · ← / Esc back</Text>
				</Box>
			</Box>
		);
	}

	// ── --check: flat, read-only report (no cursor, every row expanded) ─────────
	if (opts.check) {
		let lastScope: Scope | null = null;
		return (
			<Box flexDirection="column" padding={1}>
				{title}
				{rows.map((row) => {
					const head = row.scope !== lastScope;
					lastScope = row.scope;
					const icon = rowIcon(row);
					return (
						<Box flexDirection="column" key={row.id}>
							{head && (
								<Box marginTop={1}>
									<Text bold underline>
										{SCOPE_TITLES[row.scope]}
									</Text>
								</Box>
							)}
							<Text>
								<Text color={icon.color}>{icon.char}</Text> <Text bold>{row.title}</Text>
								<Text dimColor> {rowSummary(row)}</Text>
							</Text>
							<Box marginLeft={4} flexDirection="column">
								<Text dimColor>{row.detail}</Text>
								{row.lines.map((l, i) => (
									<Text key={i} dimColor>
										{l}
									</Text>
								))}
								{row.hint && <Text color="yellow">↳ {row.hint}</Text>}
							</Box>
						</Box>
					);
				})}
			</Box>
		);
	}

	// ── Interactive panel ───────────────────────────────────────────────────────
	// A stable, single-line-per-row list (it never reflows on cursor moves) with
	// the focused row's detail rendered in a fixed-height panel below. Highlight
	// is a colored caret + accent label — no inline expand/collapse.
	const labelW = Math.min(
		22,
		rows.reduce((m, r) => Math.max(m, r.title.length), 0),
	);
	const statusLine = current ? current.lines.join("  ·  ") : "";
	let lastScope: Scope | null = null;
	return (
		<Box flexDirection="column" padding={1}>
			{title}
			{rows.map((row) => {
				const head = row.scope !== lastScope;
				lastScope = row.scope;
				const focused = row === current;
				const icon = rowIcon(row);
				const isInfo = row.kind === "info";
				return (
					<Box flexDirection="column" key={row.id}>
						{head && (
							<Box marginTop={1}>
								<Text bold color="cyan">
									{SCOPE_TITLES[row.scope]}
								</Text>
							</Box>
						)}
						<Text>
							<Text color="cyan" bold>
								{focused ? "❯ " : "  "}
							</Text>
							<Text color={icon.color}>{icon.char}</Text>{" "}
							<Text bold={!isInfo} color={focused ? "cyan" : undefined}>
								{row.title.padEnd(labelW)}
							</Text>
							<Text dimColor> {rowSummary(row)}</Text>
						</Text>
					</Box>
				);
			})}

			{/* Fixed-height detail panel — constant height keeps the footer steady. */}
			<Box marginTop={1} flexDirection="column">
				<Text dimColor>{"─".repeat(PANEL_WIDTH)}</Text>
				<Text>
					<Text bold>{current ? current.title : ""}</Text>
					<Text dimColor>
						{current ? "  " + clamp(current.detail, PANEL_WIDTH - current.title.length - 2) : ""}
					</Text>
				</Text>
				<Text dimColor>{statusLine ? clamp(statusLine, PANEL_WIDTH) : " "}</Text>
				{current?.hint ? (
					<Text color="yellow">{clamp("↳ " + current.hint, PANEL_WIDTH)}</Text>
				) : (
					<Text> </Text>
				)}
			</Box>

			{/* Footer — busy → toast → contextual keybar (constant single line). */}
			<Box marginTop={1}>
				{busy ? (
					<Text>
						<Text color="cyan">
							<Spinner type="dots" />
						</Text>{" "}
						{busy}
					</Text>
				) : toast ? (
					<Text color={toast.ok ? "green" : "red"}>
						{toast.ok ? "✓" : "✗"} {toast.message}
					</Text>
				) : (
					<Text dimColor>↑/↓ move · {footerVerb(current)} · ←/Esc quit</Text>
				)}
			</Box>
		</Box>
	);
}
