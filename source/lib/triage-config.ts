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

/** Builds the prompt handed to Claude for investigating a ticket. Skill name
 * wins when both are set: `/<skill> <ticketId>`. Otherwise the free-form
 * template with every `{ticket_id}` replaced. Returns null when unconfigured. */
export function buildInvestigatePrompt(
	cfg: TriageInvestigateConfig,
	ticketId: string,
): string | null {
	if (cfg.skillName) return `/${cfg.skillName} ${ticketId}`;
	if (cfg.prompt) return cfg.prompt.replace(/\{ticket_id\}/g, ticketId);
	return null;
}

/** POSIX single-quote a shell argument. */
function shellSingleQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Builds the shell command line launched in the new multiplexer window:
 * `<claudeBin> '<prompt>'`. The multiplexer escapes the whole line again for
 * its send-keys step; this layer just needs the prompt to survive as a single
 * argv entry so a slash command (`/skill TEAM-1`) reaches Claude intact. */
export function buildInvestigateCommand(claudeBin: string, prompt: string): string {
	return `${claudeBin} ${shellSingleQuote(prompt)}`;
}
