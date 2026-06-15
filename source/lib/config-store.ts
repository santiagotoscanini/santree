import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Santree's global config file — `$XDG_CONFIG_HOME/santree/config.json`
 * (defaults to `~/.config/santree/config.json`), sitting next to `auth.json`.
 *
 * This is where preferences santree owns live (editor, diff tool) instead of
 * exporting them into the user's shell rc. Writing here takes effect on the
 * next santree run with no shell restart. The matching `SANTREE_EDITOR` /
 * `SANTREE_DIFF_TOOL` env vars still work as a one-off override that wins over
 * the file, so existing shell exports and CI overrides keep behaving.
 */

const CONFIG_DIR = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
const CONFIG_PATH = path.join(CONFIG_DIR, "santree", "config.json");

export interface SantreeConfig {
	/** Editor launched by the dashboard's [e] action and Ctrl+O in text areas. */
	editor?: string;
	/** Unified-diff pager for `worktree diff` and the dashboard [v] overlay. */
	diffTool?: string;
}

export function configStorePath(): string {
	return CONFIG_PATH;
}

export function readConfigStore(): SantreeConfig {
	try {
		const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
		return parsed && typeof parsed === "object" ? (parsed as SantreeConfig) : {};
	} catch {
		return {};
	}
}

function writeConfigStore(cfg: SantreeConfig): void {
	fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
	fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

export function setConfigValue<K extends keyof SantreeConfig>(
	key: K,
	value: SantreeConfig[K],
): void {
	const cfg = readConfigStore();
	cfg[key] = value;
	writeConfigStore(cfg);
}

export function unsetConfigValue(key: keyof SantreeConfig): void {
	const cfg = readConfigStore();
	if (!(key in cfg)) return;
	delete cfg[key];
	writeConfigStore(cfg);
}

/**
 * Resolved editor command: `SANTREE_EDITOR` env override → config file → none.
 * Call sites keep their own final fallback (e.g. `"code"` for GUI-open flows,
 * the `VISUAL`/`EDITOR`/`vim` chain for in-terminal editing).
 */
export function getConfiguredEditor(): string | undefined {
	const env = process.env.SANTREE_EDITOR;
	if (env && env.trim()) return env.trim();
	const stored = readConfigStore().editor;
	return stored && stored.trim() ? stored.trim() : undefined;
}

/**
 * Resolved diff pager: `SANTREE_DIFF_TOOL` env override → config file → none.
 * Restricted to a safe shell-token character set since it ends up in spawn()
 * arguments — even though we never use shell:true, a tight surface defends
 * against accidental misconfigurations.
 */
export function getConfiguredDiffTool(): string | undefined {
	const raw = process.env.SANTREE_DIFF_TOOL ?? readConfigStore().diffTool;
	if (!raw || !raw.trim()) return undefined;
	const tool = raw.trim();
	return /^[a-zA-Z0-9_\-/.+]+$/.test(tool) ? tool : undefined;
}
