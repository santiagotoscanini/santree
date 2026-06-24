import { claudeAgent } from "./claude/index.js";
import { codexAgent } from "./codex/index.js";
import { getConfiguredAgent } from "../config-store.js";
import type { AiAgent, AiAgentKind } from "./types.js";

export type { AiAgent, AiAgentKind, LaunchOpts, HeadlessOpts, RunResult } from "./types.js";

const AGENTS: Record<AiAgentKind, AiAgent> = {
	claude: claudeAgent,
	codex: codexAgent,
};

/**
 * Resolve the active AI agent backend. Selection order (mirrors getIssueTracker):
 *   1. SANTREE_AGENT env override (`claude` | `codex`).
 *   2. `agent` in santree's global config (`~/.config/santree/config.json`).
 *   3. Default: Claude Code.
 *
 * This is a *global* preference (which CLI you have installed), not per-repo —
 * so it lives in config-store, not `.santree/metadata.json`.
 */
export function getAiAgent(): AiAgent {
	const env = process.env["SANTREE_AGENT"]?.toLowerCase();
	if (env === "claude") return claudeAgent;
	if (env === "codex") return codexAgent;

	const configured = getConfiguredAgent();
	return AGENTS[configured] ?? claudeAgent;
}

export function getActiveAgentKind(): AiAgentKind {
	return getAiAgent().kind;
}

/** All known agent kinds, for building the config selector. */
export const AGENT_KINDS: AiAgentKind[] = ["claude", "codex"];

export function getAgent(kind: AiAgentKind): AiAgent {
	return AGENTS[kind] ?? claudeAgent;
}
