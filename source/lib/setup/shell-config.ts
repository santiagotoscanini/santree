import * as fs from "fs";
import * as path from "path";

/**
 * Shell-config detection + idempotent editing for `santree setup`.
 *
 * Everything santree writes to a user's shell rc lives inside a single managed
 * block (nvm/conda style) so re-running setup replaces the block rather than
 * appending duplicates. Individual lines inside the block are tagged with a
 * trailing `# santree:<key>` comment so each setup step can upsert just its own
 * line without disturbing the others.
 */

export type ShellName = "zsh" | "bash" | "unknown";

export interface ShellConfig {
	shell: ShellName;
	/** rc file the managed block is written to (interactive shell init). */
	rcPath: string;
	/** Files scanned to detect pre-existing `export FOO=...` lines (rc + env files). */
	scanPaths: string[];
}

const BLOCK_START = "# >>> santree >>>";
const BLOCK_END = "# <<< santree <<<";
const BLOCK_HEADER =
	"# Managed by `santree setup` — safe to re-run; edits here may be overwritten.";

/**
 * Resolve the rc file the managed block should live in, honoring ZDOTDIR (zsh)
 * so users with an XDG-based setup (~/.config/zsh, no ~/.zshrc) get the block in
 * the right place.
 */
export function resolveShellConfig(shellEnv = process.env.SHELL || ""): ShellConfig {
	const home = process.env.HOME || "";
	const base = path.basename(shellEnv);

	if (base.includes("zsh")) {
		const dir = process.env.ZDOTDIR || home;
		return {
			shell: "zsh",
			rcPath: path.join(dir, ".zshrc"),
			scanPaths: [
				path.join(dir, ".zshrc"),
				path.join(dir, ".zshenv"),
				path.join(home, ".zshenv"),
				path.join(home, ".zprofile"),
			],
		};
	}

	if (base.includes("bash")) {
		return {
			shell: "bash",
			rcPath: path.join(home, ".bashrc"),
			scanPaths: [
				path.join(home, ".bashrc"),
				path.join(home, ".bash_profile"),
				path.join(home, ".profile"),
			],
		};
	}

	// Fall back to zsh conventions (the default macOS shell).
	const dir = process.env.ZDOTDIR || home;
	return {
		shell: "unknown",
		rcPath: path.join(dir, ".zshrc"),
		scanPaths: [path.join(dir, ".zshrc"), path.join(dir, ".zshenv"), path.join(home, ".zshenv")],
	};
}

function tagFor(key: string): string {
	return `# santree:${key}`;
}

function readFileSafe(filePath: string): string {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return "";
	}
}

interface BlockSplit {
	before: string;
	body: string[]; // lines between the markers (excluding markers + header)
	after: string;
	exists: boolean;
}

function splitBlock(content: string): BlockSplit {
	const startIdx = content.indexOf(BLOCK_START);
	if (startIdx === -1) {
		return { before: content, body: [], after: "", exists: false };
	}
	const endMarkerIdx = content.indexOf(BLOCK_END, startIdx);
	if (endMarkerIdx === -1) {
		// Malformed (start without end) — treat everything from start as the block.
		const before = content.slice(0, startIdx);
		return { before, body: [], after: "", exists: true };
	}
	const before = content.slice(0, startIdx);
	const after = content.slice(endMarkerIdx + BLOCK_END.length);
	const inner = content.slice(startIdx + BLOCK_START.length, endMarkerIdx);
	const body = inner
		.split("\n")
		.map((l) => l.trimEnd())
		.filter((l) => l.length > 0 && l !== BLOCK_HEADER);
	return { before, body, after, exists: true };
}

function renderBlock(body: string[]): string {
	return [BLOCK_START, BLOCK_HEADER, ...body, BLOCK_END].join("\n");
}

/**
 * Upsert a single tagged line into the managed block, creating the block (and
 * the rc file) if needed. The line for `key` is replaced if present, else
 * appended. `line` is the raw shell statement WITHOUT the trailing tag comment.
 */
export function upsertManagedLine(rcPath: string, key: string, line: string): void {
	const content = readFileSafe(rcPath);
	const { before, body, after, exists } = splitBlock(content);
	const tag = tagFor(key);
	const tagged = `${line} ${tag}`;

	const idx = body.findIndex((l) => l.trimEnd().endsWith(tag));
	const nextBody = idx === -1 ? [...body, tagged] : body.map((l, i) => (i === idx ? tagged : l));

	let output: string;
	if (exists) {
		output = before + renderBlock(nextBody) + after;
	} else {
		// Append a fresh block, keeping a single trailing newline.
		const trimmed = content.replace(/\n+$/, "");
		const prefix = trimmed.length > 0 ? trimmed + "\n\n" : "";
		output = prefix + renderBlock(nextBody) + "\n";
	}

	const dir = path.dirname(rcPath);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(rcPath, output.endsWith("\n") ? output : output + "\n");
}

/**
 * Detect whether `name` is already exported by the user's shell config (any of
 * `scanPaths`) or the current environment. Used so setup doesn't clobber an
 * export the user already maintains by hand (e.g. SANTREE_EDITOR in .zshenv).
 * Ignores santree's own managed block so a prior setup run isn't mistaken for a
 * hand-maintained export.
 */
export function isEnvVarSet(name: string, cfg: ShellConfig): boolean {
	if (process.env[name]) return true;
	const re = new RegExp(`^\\s*export\\s+${name}=`, "m");
	for (const p of cfg.scanPaths) {
		const content = readFileSafe(p);
		if (!content) continue;
		// Strip our own managed block before scanning hand-maintained exports.
		const { before, after } = splitBlock(content);
		const userContent = p === cfg.rcPath ? before + after : content;
		if (re.test(userContent)) return true;
	}
	return false;
}

export function envKey(name: string): string {
	return `env:${name}`;
}
