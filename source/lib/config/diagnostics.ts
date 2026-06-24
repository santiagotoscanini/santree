import { run } from "../exec.js";
import { which } from "../setup/tools.js";
import { getMultiplexer } from "../multiplexer/index.js";
import { getAiAgent } from "../agents/index.js";
import { findMainRepoRoot } from "../git.js";
import { getIssueTracker } from "../trackers/index.js";
import {
	CURRENT_VERSION,
	SANTREE_PACKAGE,
	getLatestVersionFor,
	isUpdateAvailable,
	detectPackageManager,
	getInstallCommandFor,
} from "../version.js";

/**
 * Read-only diagnostics for `santree config`. These are the facts santree can
 * *report* but not change from the panel (tool versions, update availability,
 * auth state). The panel renders them as non-selectable info rows; `--check`
 * prints them flat. Configurable settings live in `lib/setup/steps.ts` instead.
 */

/** A read-only status row — santree reports it, you can't toggle it here. */
export interface InfoRow {
	id: string;
	title: string;
	description: string;
	scope: "system" | "global" | "repo";
	required: boolean;
	ok: boolean;
	/** Dim sub-lines (version, path, account, …). */
	lines: string[];
	/** Yellow call-to-action when not ok. */
	hint?: string;
}

/**
 * Extra detail attached to a configurable step row by id (version / auth / a
 * yellow update hint). Lets an already-configured step render doctor-style
 * without the step catalog itself doing network I/O.
 */
export interface StepDetail {
	lines: string[];
	hint?: string;
}

export interface DiagnosticsData {
	infoRows: InfoRow[];
	/** Keyed by SetupStep id (gh, claude, tracker). */
	stepDetail: Map<string, StepDetail>;
	/** True when an active multiplexer was detected (tmux/cmux). */
	muxActive: boolean;
}

function tryRun(cmd: string): string | null {
	return run(`${cmd} 2>/dev/null`);
}

function checkGit(): InfoRow {
	const p = which("git");
	if (!p) {
		return {
			id: "git",
			title: "git",
			description: "Version control",
			scope: "system",
			required: true,
			ok: false,
			lines: [],
			hint: "Install: brew install git",
		};
	}
	const version = tryRun("git --version | head -1");
	return {
		id: "git",
		title: "git",
		description: "Version control",
		scope: "system",
		required: true,
		ok: true,
		lines: [`Version: ${version || "unknown"}`, `Path: ${p}`],
	};
}

function checkNode(): InfoRow {
	const version = process.versions.node;
	const major = Number(version.split(".")[0] || "0");
	const ok = major >= 20;
	return {
		id: "node",
		title: "node",
		description: "JavaScript runtime (>= 20 required)",
		scope: "system",
		required: true,
		ok,
		lines: [`Version: v${version}`, `Path: ${process.execPath}`],
		hint: ok ? undefined : "Santree needs Node.js >= 20. Upgrade: https://nodejs.org",
	};
}

async function checkSantreeSelf(): Promise<InfoRow> {
	const latest = await getLatestVersionFor(SANTREE_PACKAGE);
	const updatable = !!latest && isUpdateAvailable(CURRENT_VERSION, latest);
	const lines = [`Version: ${CURRENT_VERSION}`];
	if (latest) lines.push(`Latest: ${latest}${updatable ? " ⬆ update available" : ""}`);
	return {
		id: "santree",
		title: "santree",
		description: "Santree CLI (this app)",
		scope: "system",
		required: true,
		ok: true,
		lines,
		hint: updatable ? "Run: santree update" : undefined,
	};
}

function checkMultiplexer(): InfoRow {
	const mux = getMultiplexer();
	if (mux.kind === "tmux") {
		const version = tryRun("tmux -V");
		return {
			id: "multiplexer",
			title: "tmux",
			description: "Active multiplexer — new-window flows enabled",
			scope: "system",
			required: false,
			ok: true,
			lines: [`Version: ${version || "unknown"}`, `Path: ${which("tmux") || "unknown"}`],
		};
	}
	// cmux
	const version = tryRun("cmux --version");
	const ping = tryRun("cmux ping");
	return {
		id: "multiplexer",
		title: "cmux",
		description: "Active multiplexer — new-window flows enabled",
		scope: "system",
		required: false,
		ok: !!ping,
		lines: [`Version: ${version || "unknown"}`, `Path: ${which("cmux") || "unknown"}`],
		hint: ping ? undefined : "cmux app not reachable — open cmux.app.",
	};
}

function checkWorkspaceEditor(): InfoRow {
	const code = which("code");
	const cursor = which("cursor");
	const found = code ? "code" : cursor ? "cursor" : null;
	if (found) {
		const version = tryRun(`${found} --version | head -1`);
		return {
			id: "workspace-editor",
			title: "Workspace editor",
			description: "code/cursor — powers the dashboard's `E workspace` shortcut",
			scope: "system",
			required: false,
			ok: true,
			lines: [`Editor: ${found}`, `Version: ${version || "unknown"}`],
		};
	}
	return {
		id: "workspace-editor",
		title: "Workspace editor",
		description: "code/cursor — powers the dashboard's `E workspace` shortcut",
		scope: "system",
		required: false,
		ok: false,
		lines: [],
		hint: "Optional — only the `.code-workspace` shortcut needs code/cursor. Everything else uses your configured editor.",
	};
}

/** Version + auth detail for the agent CLI and gh step rows. */
async function loadStepDetail(): Promise<Map<string, StepDetail>> {
	const detail = new Map<string, StepDetail>();
	const pm = detectPackageManager();

	// active agent CLI — version + latest + (Claude) cmux-aware update hint
	const agent = getAiAgent();
	const resolved = agent.resolveBinary();
	if (resolved) {
		const version = tryRun(`"${resolved}" --version | head -1`);
		const latest = await getLatestVersionFor(agent.installPackage);
		const lines = [`Version: ${version || "unknown"}`, `Path: ${resolved}`];
		let hint: string | undefined;
		if (latest && version && isUpdateAvailable(version, latest)) {
			lines.push(`Latest: ${latest} ⬆ update available`);
			if (agent.kind === "claude" && resolved.includes("/cmux.app/")) {
				hint = "Bundled with cmux — update cmux.app to get the latest Claude.";
			} else {
				hint = `Run: ${getInstallCommandFor(pm, `${agent.installPackage}@latest`).display}`;
			}
		}
		detail.set("agent-cli", { lines, hint });
	}

	// gh — version + authenticated login
	if (which("gh")) {
		const version = tryRun("gh --version | head -1");
		const login = tryRun("gh api user --jq .login");
		const lines = [`Version: ${version || "unknown"}`];
		if (login) lines.push(`Auth: authenticated as ${login}`);
		detail.set("gh", { lines, hint: login ? undefined : "Run: gh auth login" });
	}

	return detail;
}

/** Active issue tracker auth detail for the tracker row. */
async function loadTrackerDetail(): Promise<StepDetail | null> {
	const repoRoot = findMainRepoRoot();
	if (!repoRoot) return null;
	try {
		const tracker = getIssueTracker(repoRoot);
		const status = await tracker.getAuthStatus(repoRoot);
		const lines = [`Tracker: ${tracker.displayName}`];
		if (status.accountLabel) lines.push(`Account: ${status.accountLabel}`);
		if (status.repoLinked !== undefined)
			lines.push(`Repo linked: ${status.repoLinked ? "yes" : "no"}`);
		return { lines, hint: status.authenticated ? undefined : status.hint };
	} catch {
		return null;
	}
}

/** Run every read-only check. Network calls (npm registry, gh, tracker) run in parallel. */
export async function loadDiagnostics(): Promise<DiagnosticsData> {
	const muxActive = getMultiplexer().kind !== "none";
	const [santree, stepDetail, trackerDetail] = await Promise.all([
		checkSantreeSelf(),
		loadStepDetail(),
		loadTrackerDetail(),
	]);

	if (trackerDetail) stepDetail.set("tracker", trackerDetail);

	const infoRows: InfoRow[] = [santree, checkNode(), checkGit()];
	if (muxActive) infoRows.push(checkMultiplexer());
	infoRows.push(checkWorkspaceEditor());

	return { infoRows, stepDetail, muxActive };
}
