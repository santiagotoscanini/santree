import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { run } from "../exec.js";

/**
 * Ignore-rule management for santree's per-repo files.
 *
 * We add SPECIFIC entries (not a blanket `.santree/`) so `.santree/issues/`
 * stays version-controlled for the Local tracker. Trailing slashes mark
 * directories (see santree's own .gitignore convention).
 */

export const SANTREE_IGNORE_ENTRIES = [
	".santree/worktrees/",
	".santree/metadata.json",
	".santree/session-states/",
];

export type IgnoreTarget = "gitignore" | "exclude";

export function ignoreTargetPath(repoRoot: string, target: IgnoreTarget): string {
	if (target === "exclude") {
		// Resolve the real excludes file (handles non-standard git dirs).
		const rel = run("git rev-parse --git-path info/exclude", { cwd: repoRoot });
		return rel ? path.resolve(repoRoot, rel) : path.join(repoRoot, ".git", "info", "exclude");
	}
	return path.join(repoRoot, ".gitignore");
}

function isGitIgnored(relPath: string, repoRoot: string): boolean {
	try {
		execSync(`git check-ignore -q "${relPath}"`, { cwd: repoRoot, stdio: "ignore" });
		return true; // exit 0 = ignored
	} catch {
		return false;
	}
}

/** Entries that are not yet ignored by git (so we don't write duplicates). */
export function missingIgnoreEntries(repoRoot: string): string[] {
	return SANTREE_IGNORE_ENTRIES.filter((e) => !isGitIgnored(e, repoRoot));
}

/**
 * Append the still-missing santree entries to the chosen target file. Returns
 * the entries actually written (skips any already present as literal lines).
 */
export function addIgnoreEntries(repoRoot: string, target: IgnoreTarget): string[] {
	const filePath = ignoreTargetPath(repoRoot, target);
	const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
	const existingLines = new Set(
		existing
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean),
	);

	const toAdd = missingIgnoreEntries(repoRoot).filter((e) => !existingLines.has(e));
	if (toAdd.length === 0) return [];

	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
	const header = existing.includes("# santree") ? "" : "\n# santree\n";
	fs.appendFileSync(filePath, prefix + header + toAdd.join("\n") + "\n");
	return toAdd;
}
