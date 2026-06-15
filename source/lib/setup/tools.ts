import * as os from "os";
import { run } from "../exec.js";

/**
 * Tool detection + installation for `santree config`.
 *
 * macOS (Homebrew) is the only auto-install path today. The `PlatformInstaller`
 * seam keeps the door open for apt/dnf/etc. without touching call sites — add a
 * resolver branch in `getInstaller()` and the steps keep working.
 */

export function isMacOS(): boolean {
	return os.platform() === "darwin";
}

/** Resolve a command on PATH, or null if absent. */
export function which(cmd: string): string | null {
	return run(`which ${cmd}`);
}

/** Known unified-diff pagers, best first. The first one on PATH wins. */
const DIFF_PAGERS = ["delta", "diff-so-fancy", "diff-highlight", "ydiff", "riff"];

export interface DetectedTool {
	command: string;
	path: string;
}

export function detectDiffPagers(): DetectedTool[] {
	const found: DetectedTool[] = [];
	for (const cmd of DIFF_PAGERS) {
		const p = which(cmd);
		if (p) found.push({ command: cmd, path: p });
	}
	return found;
}

/** Editors we know how to launch, in rough order of popularity. */
const KNOWN_EDITORS = ["code", "cursor", "zed", "subl", "windsurf", "nvim", "vim", "nano", "emacs"];

export function detectEditors(): DetectedTool[] {
	const found: DetectedTool[] = [];
	for (const cmd of KNOWN_EDITORS) {
		const p = which(cmd);
		if (p) found.push({ command: cmd, path: p });
	}
	return found;
}

export interface PlatformInstaller {
	/** Human label, e.g. "Homebrew". */
	name: string;
	/** argv for installing `pkg` (cmd + args), suitable for a TTY spawn. */
	installArgv(pkg: string): string[];
}

export function getInstaller(): PlatformInstaller | null {
	if (isMacOS() && which("brew")) {
		return {
			name: "Homebrew",
			installArgv: (pkg) => ["brew", "install", pkg],
		};
	}
	return null;
}
