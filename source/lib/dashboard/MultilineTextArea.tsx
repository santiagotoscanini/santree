import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { spawnSync } from "node:child_process";
import { openSync, readSync, closeSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
		const result = spawnSync("osascript", ["-e", script], {
			encoding: "utf-8",
			timeout: 3000,
		});
		if (result.status !== 0 || result.stdout.trim() !== "ok") return null;

		// Defense in depth: verify the file is non-empty and starts with the PNG
		// magic header. Guards against an osascript quirk writing a stub.
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

function offsetToRowCol(value: string, offset: number): [number, number] {
	const lines = value.split("\n");
	let idx = 0;
	for (let r = 0; r < lines.length; r++) {
		const len = lines[r]!.length;
		if (offset <= idx + len) {
			return [r, offset - idx];
		}
		idx += len + 1;
	}
	const last = lines.length - 1;
	return [last, lines[last]!.length];
}

function rowColToOffset(value: string, row: number, col: number): number {
	const lines = value.split("\n");
	const clampedRow = Math.max(0, Math.min(row, lines.length - 1));
	let idx = 0;
	for (let r = 0; r < clampedRow; r++) {
		idx += lines[r]!.length + 1;
	}
	const clampedCol = Math.max(0, Math.min(col, lines[clampedRow]!.length));
	return idx + clampedCol;
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

	// Keep cursor within bounds if value shrinks externally
	useEffect(() => {
		if (cursor > value.length) setCursor(value.length);
	}, [value, cursor]);

	const insertAt = (pos: number, text: string) => {
		onChange(value.slice(0, pos) + text + value.slice(pos));
		setCursor(pos + text.length);
	};

	const deleteBefore = (pos: number) => {
		if (pos === 0) return;
		onChange(value.slice(0, pos - 1) + value.slice(pos));
		setCursor(pos - 1);
	};

	useInput(
		(input, key) => {
			// Ctrl+D submits
			if (key.ctrl && input === "d") {
				onSubmit();
				return;
			}

			// Ctrl+V — try to paste clipboard image as a temp file reference.
			// Regular Cmd+V text paste is handled by the terminal and arrives as
			// normal input below.
			if (key.ctrl && input === "v") {
				const imagePath = pasteClipboardImageToTmp();
				if (imagePath) {
					insertAt(cursor, `![pasted image](${imagePath})`);
				}
				return;
			}

			// ESC cancels (parent disables SGR mouse tracking while mounted
			// so clicks don't masquerade as ESC)
			if (key.escape) {
				onCancel();
				return;
			}

			if (key.backspace || key.delete) {
				deleteBefore(cursor);
				return;
			}

			// Arrow navigation — column is remembered via col-from-current-pos
			if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
				const lines = value.split("\n");
				const [row, col] = offsetToRowCol(value, cursor);

				if (key.upArrow) {
					if (row === 0) setCursor(0);
					else setCursor(rowColToOffset(value, row - 1, col));
				} else if (key.downArrow) {
					if (row === lines.length - 1) setCursor(value.length);
					else setCursor(rowColToOffset(value, row + 1, col));
				} else if (key.leftArrow) {
					setCursor(Math.max(0, cursor - 1));
				} else if (key.rightArrow) {
					setCursor(Math.min(value.length, cursor + 1));
				}
				return;
			}

			if (key.tab) return;

			// Enter inserts a newline at cursor. MUST run before meta/ctrl swallow
			// so Option+Enter / Ctrl+Enter also insert. When a paste carries content
			// alongside \r, append the whole normalized chunk.
			if (key.return) {
				const chunk = input ? input.replace(/\r\n?/g, "\n") : "\n";
				insertAt(cursor, chunk);
				return;
			}

			// Swallow remaining modifier combos
			if (key.ctrl || key.meta) return;

			if (!input) return;

			const normalized = input.replace(/\r\n?/g, "\n");
			insertAt(cursor, normalized);
		},
		{ isActive: focus },
	);

	const [cursorRow, cursorCol] = offsetToRowCol(value, cursor);
	const lines = value.length === 0 ? [""] : value.split("\n");

	// Scroll viewport so the cursor row is always visible
	let scrollStart = 0;
	if (cursorRow >= height) scrollStart = cursorRow - height + 1;
	const visibleLines = lines.slice(scrollStart, scrollStart + height);
	const isEmpty = value.length === 0;

	return (
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
				visibleLines.map((line, i) => {
					const absoluteRow = scrollStart + i;
					const isCursorRow = focus && absoluteRow === cursorRow;

					if (!isCursorRow) {
						return (
							<Box key={i} minHeight={1}>
								<Text>{line}</Text>
							</Box>
						);
					}

					const before = line.slice(0, cursorCol);
					const atCursor = cursorCol < line.length ? line[cursorCol]! : " ";
					const after = cursorCol < line.length ? line.slice(cursorCol + 1) : "";

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
	);
}
