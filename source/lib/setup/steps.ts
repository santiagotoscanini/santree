import * as fs from "fs";
import { run } from "../exec.js";
import { findMainRepoRoot, getSantreeDir, getInitScriptPath } from "../git.js";
import { isRepoTrackerConfigured } from "../trackers/index.js";
import { getMultiplexer } from "../multiplexer/index.js";
import { resolveClaudeBinary } from "../ai.js";
import { CLAUDE_CODE_PACKAGE, detectPackageManager, getInstallCommandFor } from "../version.js";
import {
	isStatuslineConfigured,
	configureStatusline,
	removeStatusline,
	isRemoteControlEnabled,
	enableRemoteControl,
	disableRemoteControl,
} from "../claude-config.js";
import {
	setConfigValue,
	getConfiguredEditor,
	getConfiguredDiffTool,
	configStorePath,
} from "../config-store.js";
import { detectDiffPagers, detectEditors, getInstaller, which } from "./tools.js";
import {
	missingIgnoreEntries,
	addIgnoreEntries,
	removeIgnoreEntries,
	SANTREE_IGNORE_ENTRIES,
	type IgnoreTarget,
} from "./gitignore.js";
import { spawnTTY } from "./apply.js";

export type DetectState = "ok" | "actionable" | "unavailable";

export interface StepOption {
	value: string;
	label: string;
}

export interface StepResult {
	ok: boolean;
	message: string;
}

export interface SetupStep {
	id: string;
	title: string;
	detail: string;
	scope: "global" | "repo";
	/** "spawn" steps take over the terminal (installs/logins); UI flags them. */
	kind: "file" | "spawn";
	recommended: boolean;
	detect: DetectState;
	/** Pick-one sub-prompt collected before apply; absent = no choice needed. */
	options?: StepOption[];
	optionPrompt?: string;
	apply: (choice: string | undefined) => StepResult | Promise<StepResult>;
	/**
	 * Reverse `apply`, returning the step to its un-configured state. Present only
	 * on steps santree fully owns and can cleanly undo (statusline, remote control,
	 * gitignore). Steps without it have no "off" in the panel.
	 */
	unapply?: (choice: string | undefined) => StepResult | Promise<StepResult>;
}

export interface SetupContext {
	repoRoot: string | null;
	dryRun: boolean;
}

export function buildContext(dryRun: boolean): SetupContext {
	return {
		repoRoot: findMainRepoRoot(),
		dryRun,
	};
}

/**
 * Build the full step catalog with `detect` + `options` resolved against the
 * current machine. The wizard filters to `actionable` steps for the checklist.
 */
export function buildSteps(ctx: SetupContext): SetupStep[] {
	const steps: SetupStep[] = [];
	const { repoRoot, dryRun } = ctx;
	const installer = getInstaller();

	// ── Editor ──────────────────────────────────────────────────────────────────
	{
		const editors = detectEditors();
		const detect: DetectState = getConfiguredEditor()
			? "ok"
			: editors.length > 0
				? "actionable"
				: "unavailable";
		steps.push({
			id: "editor",
			title: "Default editor",
			detail: "Editor opened by the dashboard's [e] action (stored in santree's config)",
			scope: "global",
			kind: "file",
			recommended: true,
			detect,
			options: editors.map((e) => ({ value: e.command, label: e.command })),
			optionPrompt: "Pick your editor:",
			apply: (choice) => {
				const editor = choice || editors[0]?.command || "vim";
				if (dryRun) return { ok: true, message: `Would set editor=${editor}` };
				setConfigValue("editor", editor);
				return { ok: true, message: `Set editor to ${editor} in ${configStorePath()}` };
			},
		});
	}

	// ── Diff tool ───────────────────────────────────────────────────────────────
	{
		const pagers = detectDiffPagers();
		const hasDelta = pagers.some((p) => p.command === "delta");
		const options: StepOption[] = pagers.map((p) => ({ value: p.command, label: p.command }));
		if (installer && !hasDelta) {
			options.push({
				value: "install:delta",
				label: `git-delta — install via ${installer.name}`,
			});
		}
		const detect: DetectState = getConfiguredDiffTool()
			? "ok"
			: options.length > 0
				? "actionable"
				: "unavailable";
		steps.push({
			id: "diff-tool",
			title: "Diff tool",
			detail:
				"Pretty diffs in `worktree diff` and the dashboard [v] overlay (stored in santree's config)",
			scope: "global",
			kind: installer && !hasDelta ? "spawn" : "file",
			recommended: true,
			detect,
			options,
			optionPrompt: "Pick a diff pager:",
			apply: (choice) => {
				const pick = choice || options[0]?.value;
				if (!pick) return { ok: false, message: "No diff pager available" };
				let tool = pick;
				if (pick.startsWith("install:")) {
					tool = pick.slice("install:".length);
					// `install:` options are only offered when an installer exists, but
					// guard explicitly so a broken invariant degrades instead of NPEs.
					if (!installer) return { ok: false, message: "No installer available for git-delta" };
					if (dryRun) {
						return {
							ok: true,
							message: `Would ${installer.installArgv("git-delta").join(" ")} then set diffTool=${tool}`,
						};
					}
					const argv = installer.installArgv("git-delta");
					const code = spawnTTY(argv[0]!, argv.slice(1));
					if (code !== 0)
						return { ok: false, message: "git-delta install failed — diff tool not set" };
				}
				if (dryRun) return { ok: true, message: `Would set diffTool=${tool}` };
				setConfigValue("diffTool", tool);
				return { ok: true, message: `Set diff tool to ${tool} in ${configStorePath()}` };
			},
		});
	}

	// ── Statusline ──────────────────────────────────────────────────────────────
	steps.push({
		id: "statusline",
		title: "Statusline",
		detail: "Worktree-aware statusline (branch, git changes, context usage)",
		scope: "global",
		kind: "file",
		recommended: true,
		detect: isStatuslineConfigured() ? "ok" : "actionable",
		apply: () => {
			if (dryRun)
				return { ok: true, message: "Would configure statusLine in ~/.claude/settings.json" };
			const p = configureStatusline();
			return { ok: true, message: `Configured statusline in ${p}` };
		},
		unapply: () => {
			if (dryRun)
				return { ok: true, message: "Would remove statusLine from ~/.claude/settings.json" };
			const p = removeStatusline();
			return { ok: true, message: `Removed statusline from ${p}` };
		},
	});

	// ── Remote control ──────────────────────────────────────────────────────────
	steps.push({
		id: "remote-control",
		title: "Remote control",
		detail: "Enable remote control at startup (drive sessions from the dashboard)",
		scope: "global",
		kind: "file",
		recommended: false,
		detect: isRemoteControlEnabled() ? "ok" : "actionable",
		apply: () => {
			if (dryRun)
				return { ok: true, message: "Would set remoteControlAtStartup in ~/.claude.json" };
			const p = enableRemoteControl();
			return { ok: true, message: `Enabled remote control in ${p}` };
		},
		unapply: () => {
			if (dryRun)
				return { ok: true, message: "Would unset remoteControlAtStartup in ~/.claude.json" };
			const p = disableRemoteControl();
			return { ok: true, message: `Disabled remote control in ${p}` };
		},
	});

	// ── GitHub CLI install + auth ───────────────────────────────────────────────
	{
		const ghInstalled = !!which("gh");
		// `gh auth status` prints to stderr — redirect so it doesn't leak into the wizard.
		const ghAuthed = ghInstalled && run("gh auth status >/dev/null 2>&1") !== null;
		const detect: DetectState = ghAuthed
			? "ok"
			: ghInstalled || installer
				? "actionable"
				: "unavailable";
		steps.push({
			id: "gh",
			title: "GitHub CLI",
			detail: "Required for PR create / review / checks",
			scope: "global",
			kind: "spawn",
			recommended: true,
			detect,
			apply: () => {
				if (dryRun) {
					const parts =
						!ghInstalled && installer ? `${installer.installArgv("gh").join(" ")} then ` : "";
					return { ok: true, message: `Would ${parts}gh auth login` };
				}
				if (!ghInstalled) {
					if (!installer)
						return { ok: false, message: "Install gh manually: see https://cli.github.com" };
					const argv = installer.installArgv("gh");
					const code = spawnTTY(argv[0]!, argv.slice(1));
					if (code !== 0) return { ok: false, message: "gh install failed" };
				}
				const code = spawnTTY("gh", ["auth", "login"]);
				return code === 0
					? { ok: true, message: "gh authenticated" }
					: { ok: false, message: "gh auth login did not complete" };
			},
		});
	}

	// ── Claude Code CLI ─────────────────────────────────────────────────────────
	{
		const installed = !!resolveClaudeBinary();
		steps.push({
			id: "claude",
			title: "Claude Code",
			detail: "Powers `worktree work`, `pr fix`, `pr review`",
			scope: "global",
			kind: "spawn",
			recommended: true,
			detect: installed ? "ok" : "actionable",
			apply: () => {
				const cmd = getInstallCommandFor(detectPackageManager(), CLAUDE_CODE_PACKAGE);
				if (dryRun) return { ok: true, message: `Would run: ${cmd.display}` };
				const code = spawnTTY(cmd.cmd, cmd.args);
				return code === 0
					? { ok: true, message: "Claude Code CLI installed" }
					: { ok: false, message: `Install failed — run manually: ${cmd.display}` };
			},
		});
	}

	// ── tmux (multiplexer) ──────────────────────────────────────────────────────
	{
		const active = getMultiplexer().kind !== "none";
		const detect: DetectState = active ? "ok" : installer ? "actionable" : "unavailable";
		steps.push({
			id: "tmux",
			title: "tmux",
			detail: "Enables new-window flows: work / fix / review / investigate",
			scope: "global",
			kind: "spawn",
			recommended: false,
			detect,
			apply: () => {
				if (!installer) return { ok: false, message: "Install tmux manually: brew install tmux" };
				if (dryRun)
					return { ok: true, message: `Would ${installer.installArgv("tmux").join(" ")}` };
				const argv = installer.installArgv("tmux");
				const code = spawnTTY(argv[0]!, argv.slice(1));
				return code === 0
					? { ok: true, message: "tmux installed (start a tmux session to use new-window flows)" }
					: { ok: false, message: "tmux install failed" };
			},
		});
	}

	// ── Repo-scoped steps ───────────────────────────────────────────────────────
	if (repoRoot) {
		const santreeDir = getSantreeDir(repoRoot);
		const initSh = getInitScriptPath(repoRoot);

		// .santree scaffold
		{
			const folderOk = fs.existsSync(santreeDir);
			const initOk = fs.existsSync(initSh);
			let execOk = false;
			if (initOk) {
				try {
					fs.accessSync(initSh, fs.constants.X_OK);
					execOk = true;
				} catch {}
			}
			steps.push({
				id: "scaffold",
				title: "Repo scaffold",
				detail: "Create .santree/ and an executable init.sh (runs on worktree create)",
				scope: "repo",
				kind: "file",
				recommended: true,
				detect: folderOk && initOk && execOk ? "ok" : "actionable",
				apply: () => {
					if (dryRun)
						return { ok: true, message: `Would create ${santreeDir} and an executable init.sh` };
					fs.mkdirSync(santreeDir, { recursive: true });
					if (!fs.existsSync(initSh)) {
						fs.writeFileSync(
							initSh,
							"#!/usr/bin/env bash\n# Runs after `santree worktree create`. Add setup steps here.\n",
						);
					}
					fs.chmodSync(initSh, 0o755);
					return { ok: true, message: `Scaffolded ${santreeDir}` };
				},
			});
		}

		// Ignore santree files
		{
			const missing = missingIgnoreEntries(repoRoot);
			steps.push({
				id: "gitignore",
				title: "Gitignore entries",
				detail: `Ignore ${SANTREE_IGNORE_ENTRIES.join(", ")} (keeps .santree/issues/ tracked)`,
				scope: "repo",
				kind: "file",
				recommended: true,
				detect: missing.length === 0 ? "ok" : "actionable",
				options: [
					{ value: "gitignore", label: ".gitignore — shared with your team" },
					{ value: "exclude", label: ".git/info/exclude — local to your clone" },
				],
				optionPrompt: "Where should the ignore rules go?",
				apply: (choice) => {
					const target = (choice === "exclude" ? "exclude" : "gitignore") as IgnoreTarget;
					const where = target === "exclude" ? ".git/info/exclude" : ".gitignore";
					if (dryRun)
						return {
							ok: true,
							message: `Would add ${missing.length} entr${missing.length === 1 ? "y" : "ies"} to ${where}`,
						};
					const added = addIgnoreEntries(repoRoot, target);
					return {
						ok: true,
						message: `Added ${added.length} entr${added.length === 1 ? "y" : "ies"} to ${where}`,
					};
				},
				unapply: () => {
					if (dryRun) return { ok: true, message: "Would remove santree's ignore entries" };
					const removed = removeIgnoreEntries(repoRoot);
					return {
						ok: true,
						message: removed.length
							? `Removed ${removed.length} entr${removed.length === 1 ? "y" : "ies"}`
							: "No santree ignore entries to remove",
					};
				},
			});
		}

		// Issue tracker
		{
			steps.push({
				id: "tracker",
				title: "Issue tracker",
				detail: "Pick + authenticate Linear / GitHub / Local for this repo",
				scope: "repo",
				kind: "file",
				recommended: true,
				detect: isRepoTrackerConfigured(repoRoot) ? "ok" : "actionable",
				// Driven by the config panel's inline TrackerPicker; apply is unused.
				apply: () => ({ ok: true, message: "Pick a tracker from the config panel" }),
			});
		}
	}

	return steps;
}
