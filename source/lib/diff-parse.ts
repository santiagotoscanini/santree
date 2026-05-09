import type { DiffFile, DiffFileStatus } from "./dashboard/types.js";

export interface ParsedDiff {
	files: DiffFile[];
	contentByPath: Record<string, string>;
}

/**
 * Parse a unified diff blob (e.g. `gh pr diff <n>`) into per-file records
 * suitable for DiffOverlay. Each section starts at `^diff --git a/PATH b/PATH`
 * and runs until the next such header (or EOF).
 *
 * Status is derived from the per-file metadata git emits:
 *   - `new file mode …`            → "A"
 *   - `deleted file mode …`        → "D"
 *   - `rename from / rename to`    → "R"
 *   - everything else              → "M"
 *
 * For renames, `path` is the new path and `oldPath` is preserved on the file
 * record so DiffOverlay's tree shows the destination location. Deletes use the
 * old path (the new side doesn't exist).
 *
 * Robustness: an unparseable header (a `diff --git` line that doesn't match the
 * expected `a/PATH b/PATH` shape) is skipped rather than fatal — we'd rather
 * lose one entry than crash the overlay.
 */
export function parseUnifiedDiff(text: string): ParsedDiff {
	const files: DiffFile[] = [];
	const contentByPath: Record<string, string> = {};
	if (!text) return { files, contentByPath };

	const lines = text.split("\n");
	let i = 0;
	while (i < lines.length) {
		while (i < lines.length && !lines[i]!.startsWith("diff --git ")) i++;
		if (i >= lines.length) break;
		const sectionStart = i;
		const headerMatch = lines[i]!.match(/^diff --git a\/(.+?) b\/(.+)$/);
		if (!headerMatch) {
			i++;
			continue;
		}
		const oldPath = headerMatch[1]!;
		const newPath = headerMatch[2]!;
		i++;

		let status: DiffFileStatus = "M";
		while (i < lines.length && !lines[i]!.startsWith("diff --git ")) {
			const line = lines[i]!;
			if (line.startsWith("new file mode")) status = "A";
			else if (line.startsWith("deleted file mode")) status = "D";
			else if (line.startsWith("rename from") || line.startsWith("rename to")) status = "R";
			i++;
		}

		const path = status === "D" ? oldPath : newPath;
		const file: DiffFile = { status, path };
		if (status === "R" && oldPath !== newPath) file.oldPath = oldPath;
		files.push(file);
		contentByPath[path] = lines.slice(sectionStart, i).join("\n");
	}

	return { files, contentByPath };
}
