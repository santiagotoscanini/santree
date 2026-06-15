import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { spawnSync } from "node:child_process";
import { openSync, readSync, closeSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editExternally } from "./external-editor.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// macOS clipboard → PNG. Returns the written file path on success, or null if
// the clipboard holds no image, the platform isn't macOS, or the write produced
// a file that isn't actually a PNG. The coercion to «class PNGf» errors when
// the clipboard holds only text — verified against real clipboards.
function pasteClipboardImageToTmp(): string | null {
	if (process.platform !== "darwin") return null;
	const filePath = join(tmpdir(), `santree-paste-${Date.now()}.png`);
	const script = `try
set pngData to the clipboard as «class PNGf»
set theFile to POSIX file "${filePath}"
set fileRef to open for access theFile with write permission
set eof fileRef to 0
write pngData to fileRef
close access fileRef
return "ok"
on error
return "no-image"
end try`;
	try {
		const result = spawnSync("osascript", ["-e", script], { encoding: "utf-8", timeout: 3000 });
		if (result.status !== 0 || result.stdout.trim() !== "ok") return null;

		if (statSync(filePath).size === 0) {
			try {
				unlinkSync(filePath);
			} catch {}
			return null;
		}
		const fd = openSync(filePath, "r");
		const header = Buffer.alloc(8);
		readSync(fd, header, 0, 8, 0);
		closeSync(fd);
		if (!header.equals(PNG_MAGIC)) {
			try {
				unlinkSync(filePath);
			} catch {}
			return null;
		}
		return filePath;
	} catch {
		// osascript unavailable or fs error — silent no-op
	}
	return null;
}

interface MultilineTextAreaProps {
	value: string;
	onChange: (value: string) => void;
	onSubmit: () => void;
	onCancel: () => void;
	placeholder?: string;
	width?: number;
	height?: number;
	focus?: boolean;
}

// ── Word boundary helpers (whitespace-delimited) ────────────────────────────

function prevWordStart(text: string, pos: number): number {
	let p = pos;
	while (p > 0 && /\s/.test(text[p - 1]!)) p--;
	while (p > 0 && /\S/.test(text[p - 1]!)) p--;
	return p;
}

function nextWordEnd(text: string, pos: number): number {
	let p = pos;
	while (p < text.length && /\s/.test(text[p]!)) p++;
	while (p < text.length && /\S/.test(text[p]!)) p++;
	return p;
}

function lineStart(text: string, pos: number): number {
	const before = text.lastIndexOf("\n", pos - 1);
	return before === -1 ? 0 : before + 1;
}

function lineEnd(text: string, pos: number): number {
	const after = text.indexOf("\n", pos);
	return after === -1 ? text.length : after;
}

// ── Visual layout (soft-wrap each logical line at inner width) ──────────────

interface VisualRow {
	logicalLine: number;
	startCol: number;
	text: string;
}

function buildVisualRows(value: string, innerWidth: number): VisualRow[] {
	const lines = value.length === 0 ? [""] : value.split("\n");
	const rows: VisualRow[] = [];
	const w = Math.max(1, innerWidth);
	for (let li = 0; li < lines.length; li++) {
		const line = lines[li]!;
		if (line.length === 0) {
			rows.push({ logicalLine: li, startCol: 0, text: "" });
			continue;
		}
		for (let i = 0; i < line.length; i += w) {
			rows.push({ logicalLine: li, startCol: i, text: line.slice(i, i + w) });
		}
	}
	return rows;
}

function cursorVisualPos(
	rows: VisualRow[],
	value: string,
	cursor: number,
	innerWidth: number,
): { vRow: number; vCol: number } {
	const lines = value.length === 0 ? [""] : value.split("\n");
	let logicalLine = 0;
	let lineStartOffset = 0;
	for (let li = 0; li < lines.length; li++) {
		const len = lines[li]!.length;
		if (cursor <= lineStartOffset + len) {
			logicalLine = li;
			break;
		}
		lineStartOffset += len + 1;
	}
	const colInLine = cursor - lineStartOffset;
	const candidates = rows
		.map((r, i) => ({ r, i }))
		.filter(({ r }) => r.logicalLine === logicalLine);
	for (let ci = 0; ci < candidates.length; ci++) {
		const { r, i } = candidates[ci]!;
		if (colInLine >= r.startCol && colInLine < r.startCol + r.text.length) {
			return { vRow: i, vCol: colInLine - r.startCol };
		}
		if (colInLine === r.startCol + r.text.length) {
			// Cursor sits at the end of this visual row. If the row is exactly width-full
			// AND there's another visual row in the same logical line, the next typed char
			// belongs at the start of that next row — defer.
			if (r.text.length === innerWidth && ci + 1 < candidates.length) {
				continue;
			}
			// Last row of this logical line and exactly width-full → return a virtual row
			// past the end so the cursor is rendered at col 0 of a fresh row instead of
			// overflowing the right edge.
			if (r.text.length === innerWidth) {
				return { vRow: i + 1, vCol: 0 };
			}
			return { vRow: i, vCol: colInLine - r.startCol };
		}
	}
	const last = candidates[candidates.length - 1];
	if (last) return { vRow: last.i, vCol: last.r.text.length };
	return { vRow: 0, vCol: 0 };
}

export function MultilineTextArea({
	value,
	onChange,
	onSubmit,
	onCancel,
	placeholder,
	width,
	height = 6,
	focus = true,
}: MultilineTextAreaProps) {
	const [cursor, setCursor] = useState(value.length);

	useEffect(() => {
		if (cursor > value.length) setCursor(value.length);
	}, [value, cursor]);

	const insertAt = (pos: number, text: string) => {
		onChange(value.slice(0, pos) + text + value.slice(pos));
		setCursor(pos + text.length);
	};

	const deleteRange = (from: number, to: number) => {
		if (from === to) return;
		const lo = Math.min(from, to);
		const hi = Math.max(from, to);
		onChange(value.slice(0, lo) + value.slice(hi));
		setCursor(lo);
	};

	useInput(
		(input, key) => {
			// Ctrl+D: submit
			if (key.ctrl && input === "d") {
				onSubmit();
				return;
			}

			// Ctrl+O: escalate to the configured editor / $VISUAL / $EDITOR. On save+close
			// the buffer is replaced and control returns to the textbox so the
			// user can keep editing or submit with Ctrl+D.
			if (key.ctrl && input === "o") {
				const result = editExternally(value, "md");
				if (!result.ok) return;
				if (result.cancelled) return;
				onChange(result.content);
				setCursor(result.content.length);
				return;
			}

			// Ctrl+V: paste clipboard image as a temp file reference.
			if (key.ctrl && input === "v") {
				const imagePath = pasteClipboardImageToTmp();
				if (imagePath) insertAt(cursor, `![pasted image](${imagePath})`);
				return;
			}

			// Ctrl+G: cancel (Emacs abort). Ctrl+C can't be used because Ink's
			// exitOnCtrlC fires at the app level before useInput sees it, exiting
			// the dashboard. Esc is reserved for vim muscle memory (swallowed).
			if (key.ctrl && input === "g") {
				onCancel();
				return;
			}

			// Esc: swallow without cancelling (vim users hit it constantly).
			if (key.escape) return;

			// ── Readline-ish line editing ───────────────────────────────────
			// Ctrl+A: start of line (also what iTerm2 / Ghostty send for Cmd+Left)
			if (key.ctrl && input === "a") {
				setCursor(lineStart(value, cursor));
				return;
			}
			// Ctrl+E: end of line (also what iTerm2 / Ghostty send for Cmd+Right)
			if (key.ctrl && input === "e") {
				setCursor(lineEnd(value, cursor));
				return;
			}
			// Ctrl+W: delete word backwards
			if (key.ctrl && input === "w") {
				deleteRange(prevWordStart(value, cursor), cursor);
				return;
			}
			// Ctrl+U: delete to line start
			if (key.ctrl && input === "u") {
				deleteRange(lineStart(value, cursor), cursor);
				return;
			}
			// Ctrl+K: delete to line end
			if (key.ctrl && input === "k") {
				deleteRange(cursor, lineEnd(value, cursor));
				return;
			}

			// Option+Backspace (meta+backspace): delete word backwards
			if (key.meta && (key.backspace || key.delete)) {
				deleteRange(prevWordStart(value, cursor), cursor);
				return;
			}

			// Option+Left / Option+Right: word jump.
			// Mac terminals (Ghostty/iTerm2/Terminal.app) typically send the emacs-style
			// `\x1bb` / `\x1bf` rather than the meta+arrow CSI sequence, so Ink reports
			// these as `key.meta && input === "b" | "f"`. Cover both forms.
			if (key.meta && (key.leftArrow || input === "b")) {
				setCursor(prevWordStart(value, cursor));
				return;
			}
			if (key.meta && (key.rightArrow || input === "f")) {
				setCursor(nextWordEnd(value, cursor));
				return;
			}
			// Option+Up / Option+Down: doc start/end (used by some Mac terminals)
			if (key.meta && key.upArrow) {
				setCursor(0);
				return;
			}
			if (key.meta && key.downArrow) {
				setCursor(value.length);
				return;
			}

			if (key.backspace || key.delete) {
				if (cursor === 0) return;
				onChange(value.slice(0, cursor - 1) + value.slice(cursor));
				setCursor(cursor - 1);
				return;
			}

			// Plain arrows: visual-row navigation when possible; left/right by 1 char.
			if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
				if (key.leftArrow) {
					setCursor(Math.max(0, cursor - 1));
					return;
				}
				if (key.rightArrow) {
					setCursor(Math.min(value.length, cursor + 1));
					return;
				}
				const innerW = Math.max(1, (width ?? 80) - 4);
				const rows = buildVisualRows(value, innerW);
				const { vRow, vCol } = cursorVisualPos(rows, value, cursor, innerW);
				const targetVRow = key.upArrow ? vRow - 1 : vRow + 1;
				if (targetVRow < 0) {
					setCursor(0);
					return;
				}
				if (targetVRow >= rows.length) {
					setCursor(value.length);
					return;
				}
				const target = rows[targetVRow]!;
				const targetColInLine = target.startCol + Math.min(vCol, target.text.length);
				let offset = 0;
				const lines = value.length === 0 ? [""] : value.split("\n");
				for (let li = 0; li < target.logicalLine; li++) offset += lines[li]!.length + 1;
				setCursor(offset + targetColInLine);
				return;
			}

			// Tab: insert a literal tab character.
			if (key.tab) {
				insertAt(cursor, "\t");
				return;
			}

			// Enter: insert newline (also handles paste containing \r).
			if (key.return) {
				const chunk = input ? input.replace(/\r\n?/g, "\n") : "\n";
				insertAt(cursor, chunk);
				return;
			}

			if (key.ctrl || key.meta) return;
			if (!input) return;

			// Strip OSC sequences (terminal-side responses to OSC 11/52 etc.
			// queries) — they leak into stdin while a refresh is querying
			// the background color and would otherwise type themselves into
			// the buffer. Pattern: anything starting with `]` followed by a
			// number, semicolon, payload, then BEL or ST. We strip both the
			// fully-formed OSC `\x1b]…\x07` and the bracket-only fragment
			// that arrives when Ink consumed the leading ESC as a separate
			// keypress (which it does for almost all OSC responses).
			let cleaned = input
				.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
				.replace(/^\][0-9]+;[^\x07]*\x07?/, "");
			if (!cleaned) return;

			insertAt(cursor, cleaned.replace(/\r\n?/g, "\n"));
		},
		{ isActive: focus },
	);

	const innerWidth = Math.max(1, (width ?? 80) - 4);
	const rows = buildVisualRows(value, innerWidth);
	const { vRow: cursorVRow, vCol: cursorVCol } = cursorVisualPos(rows, value, cursor, innerWidth);
	const totalRows = Math.max(rows.length, cursorVRow + 1);

	let scrollStart = 0;
	if (cursorVRow >= height) scrollStart = cursorVRow - height + 1;
	const visibleRows = rows.slice(scrollStart, scrollStart + height);
	const isEmpty = value.length === 0;
	const hiddenAbove = scrollStart;
	const hiddenBelow = Math.max(0, totalRows - scrollStart - height);

	return (
		<Box flexDirection="column" width={width}>
			<Box
				flexDirection="column"
				width={width}
				borderStyle="round"
				borderColor="cyan"
				paddingX={1}
				minHeight={height + 2}
			>
				{isEmpty && placeholder ? (
					<Box minHeight={1}>
						<Text inverse> </Text>
						<Text dimColor>{placeholder}</Text>
					</Box>
				) : (
					Array.from({ length: height }).map((_, i) => {
						const row = visibleRows[i];
						const absoluteVRow = scrollStart + i;
						const isCursorRow = focus && absoluteVRow === cursorVRow;
						if (!row) {
							// Phantom row past the end (cursor sits on a fresh line at wrap boundary)
							if (isCursorRow) {
								return (
									<Box key={`phantom-${i}`} minHeight={1}>
										<Text inverse> </Text>
									</Box>
								);
							}
							return <Box key={`pad-${i}`} minHeight={1} />;
						}
						if (!isCursorRow) {
							return (
								<Box key={i} minHeight={1}>
									<Text>{row.text}</Text>
								</Box>
							);
						}
						const before = row.text.slice(0, cursorVCol);
						const atCursor = cursorVCol < row.text.length ? row.text[cursorVCol]! : " ";
						const after = cursorVCol < row.text.length ? row.text.slice(cursorVCol + 1) : "";
						return (
							<Box key={i} minHeight={1}>
								<Text>{before}</Text>
								<Text inverse>{atCursor}</Text>
								<Text>{after}</Text>
							</Box>
						);
					})
				)}
			</Box>
			{(hiddenAbove > 0 || hiddenBelow > 0) && (
				<Box justifyContent="space-between" paddingX={1}>
					<Text dimColor>{hiddenAbove > 0 ? `↑ ${hiddenAbove} more above` : ""}</Text>
					<Text dimColor>{hiddenBelow > 0 ? `${hiddenBelow} more below ↓` : ""}</Text>
				</Box>
			)}
		</Box>
	);
}
