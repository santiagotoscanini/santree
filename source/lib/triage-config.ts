import { readAllMetadata } from "./metadata.js";

/** Per-repo "investigate triage ticket" config, read from
 * `.santree/metadata.json` (`_triage.skill_name` / `_triage.prompt`).
 * metadata.json is gitignored, so this is per-machine — each dev points it at
 * their own skill or prompt without committing it. */
export interface TriageInvestigateConfig {
	/** A Claude slash-command/skill name. Invoked as `/<skill_name> <ticketId>`. */
	skillName: string | null;
	/** A free-form prompt template; `{ticket_id}` is substituted with the ticket. */
	prompt: string | null;
}

export function readTriageInvestigateConfig(repoRoot: string): TriageInvestigateConfig {
	const all = readAllMetadata(repoRoot);
	const t = all["_triage"] as { skill_name?: unknown; prompt?: unknown } | undefined;
	const skillName =
		typeof t?.skill_name === "string" && t.skill_name.trim() ? t.skill_name.trim() : null;
	const prompt = typeof t?.prompt === "string" && t.prompt.trim() ? t.prompt.trim() : null;
	return { skillName, prompt };
}

export function isTriageInvestigateConfigured(cfg: TriageInvestigateConfig): boolean {
	return cfg.skillName !== null || cfg.prompt !== null;
}

/** Builds the prompt handed to the agent for investigating a ticket. Skill name
 * wins when both are set: `/<skill> <ticketId>` — but only for agents that
 * support slash-command skills (Claude). When `slashSkills` is false (Codex),
 * the `skillName` form is skipped and only a free-form `prompt` template is
 * used (with every `{ticket_id}` replaced). Returns null when nothing usable is
 * configured for the active agent. */
export function buildInvestigatePrompt(
	cfg: TriageInvestigateConfig,
	ticketId: string,
	opts?: { slashSkills?: boolean },
): string | null {
	const slashSkills = opts?.slashSkills ?? true;
	if (cfg.skillName && slashSkills) return `/${cfg.skillName} ${ticketId}`;
	if (cfg.prompt) return cfg.prompt.replace(/\{ticket_id\}/g, ticketId);
	return null;
}
