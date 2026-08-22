import { useEffect, useRef } from "react";
import { useApp } from "ink";
import { option } from "pastel";
import { z } from "zod/v4";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const description =
	"Open $EDITOR on a temp file, then print the path on stdout (compose with --context-file)";

export const options = z.object({
	initial: z
		.string()
		.optional()
		.describe(option({ description: "Pre-fill the editor buffer with this text" })),
	from: z
		.string()
		.optional()
		.describe(option({ description: "Pre-fill the editor buffer with the contents of this file" })),
	ext: z
		.string()
		.default("md")
		.describe(option({ description: "Temp file extension (default: md)" })),
	editor: z
		.string()
		.optional()
		.describe(
			option({ description: "Override the editor command (default: $VISUAL || $EDITOR || vim)" }),
		),
});

type Props = {
	options: z.infer<typeof options>;
};

function resolveEditor(override?: string): { cmd: string; args: string[] } {
	const raw = override ?? process.env["VISUAL"] ?? process.env["EDITOR"] ?? "vim";
	const parts = raw.split(/\s+/).filter(Boolean);
	const cmd = parts[0] ?? "vim";
	return { cmd, args: parts.slice(1) };
}

// Render null and write all UI feedback to stderr so stdout stays clean for
// shell capture: `file=$(st helpers text-editor) && st worktree work --context-file "$file"`.
export default function TextEditor({ options: opts }: Props) {
	const { exit } = useApp();
	const hasRun = useRef(false);

	useEffect(() => {
		if (hasRun.current) return;
		hasRun.current = true;

		const ext = opts.ext.replace(/^\./, "");
		const filePath = path.join(os.tmpdir(), `santree-edit-${Date.now()}.${ext}`);

		const seed = (() => {
			if (opts.from) {
				try {
					return fs.readFileSync(opts.from, "utf-8");
				} catch {
					return opts.initial ?? "";
				}
			}
			return opts.initial ?? "";
		})();

		try {
			fs.writeFileSync(filePath, seed);
		} catch (err) {
			process.stderr.write(`Failed to create temp file: ${(err as Error).message}\n`);
			process.exitCode = 1;
			exit();
			return;
		}

		// Ink put stdin in raw mode on mount; release it for the editor.
		const wasRaw = process.stdin.isTTY ? process.stdin.isRaw : false;
		if (process.stdin.isTTY && process.stdin.setRawMode) {
			try {
				process.stdin.setRawMode(false);
			} catch {}
		}

		const { cmd, args } = resolveEditor(opts.editor);
		const result = spawnSync(cmd, [...args, filePath], { stdio: "inherit" });

		if (process.stdin.isTTY && process.stdin.setRawMode) {
			try {
				process.stdin.setRawMode(wasRaw);
			} catch {}
		}

		if (result.error || result.status !== 0) {
			process.stderr.write(
				result.error
					? `Failed to launch editor '${cmd}': ${result.error.message}\n`
					: `Editor '${cmd}' exited with status ${result.status}\n`,
			);
			try {
				fs.unlinkSync(filePath);
			} catch {}
			process.exitCode = 1;
			exit();
			return;
		}

		let content = "";
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch (err) {
			process.stderr.write(`Failed to read temp file: ${(err as Error).message}\n`);
			process.exitCode = 1;
			exit();
			return;
		}

		// Empty buffer => treat as cancel (matches `git commit` behavior)
		if (content.trim().length === 0) {
			try {
				fs.unlinkSync(filePath);
			} catch {}
			process.stderr.write("Cancelled (empty buffer)\n");
			process.exitCode = 1;
			exit();
			return;
		}

		process.stdout.write(`${filePath}\n`);
		exit();
	}, [opts, exit]);

	return null;
}
