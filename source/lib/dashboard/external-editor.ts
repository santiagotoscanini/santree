import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getConfiguredEditor } from "../config-store.js";

// GUI editors that detach by default and need a `--wait` flag to make spawnSync
// block until the file is closed. Terminal editors (vim, nvim, nano, emacs -nw)
// already block, so they aren't listed here.
const GUI_EDITORS_NEEDING_WAIT = new Set([
	"zed",
	"code",
	"code-insiders",
	"cursor",
	"windsurf",
	"subl",
]);

export interface EditExternallyResult {
	ok: boolean;
	content: string;
	cancelled: boolean;
}

/**
 * Open the user's editor on a temp file seeded with `initial`, then return the
 * saved content. Empty buffer is treated as cancel (matches `git commit`).
 *
 * Editor resolution: santree config editor (or SANTREE_EDITOR) > VISUAL > EDITOR > "vim".
 */
export function editExternally(initial: string, ext = "md"): EditExternallyResult {
	const editorRaw =
		getConfiguredEditor() || process.env["VISUAL"] || process.env["EDITOR"] || "vim";
	const filePath = path.join(os.tmpdir(), `santree-edit-${Date.now()}.${ext.replace(/^\./, "")}`);

	try {
		fs.writeFileSync(filePath, initial);
	} catch {
		return { ok: false, content: initial, cancelled: false };
	}

	const parts = editorRaw.split(/\s+/).filter(Boolean);
	const cmd = parts[0] ?? "vim";
	const baseArgs = parts.slice(1);
	const needsWait =
		GUI_EDITORS_NEEDING_WAIT.has(path.basename(cmd)) &&
		!baseArgs.includes("--wait") &&
		!baseArgs.includes("-w");
	const args = [...baseArgs, ...(needsWait ? ["--wait"] : []), filePath];

	const wasRaw = process.stdin.isTTY ? process.stdin.isRaw : false;
	if (process.stdin.isTTY && process.stdin.setRawMode) {
		try {
			process.stdin.setRawMode(false);
		} catch {}
	}

	const result = spawnSync(cmd, args, { stdio: "inherit" });

	if (process.stdin.isTTY && process.stdin.setRawMode) {
		try {
			process.stdin.setRawMode(wasRaw);
		} catch {}
	}

	if (result.error || result.status !== 0) {
		try {
			fs.unlinkSync(filePath);
		} catch {}
		return { ok: false, content: initial, cancelled: false };
	}

	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return { ok: false, content: initial, cancelled: false };
	}
	try {
		fs.unlinkSync(filePath);
	} catch {}

	if (content.trim().length === 0) {
		return { ok: true, content: "", cancelled: true };
	}
	return { ok: true, content, cancelled: false };
}
