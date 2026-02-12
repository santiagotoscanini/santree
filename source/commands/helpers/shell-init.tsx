import { useEffect, useState, useRef } from "react";
import { argument } from "pastel";
import { z } from "zod/v4";
import { readdirSync, statSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import nunjucks from "nunjucks";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const description = "Output shell integration script";

export const args = z.tuple([
	z
		.enum(["zsh", "bash"])
		.default("zsh")
		.describe(argument({ name: "shell", description: "Shell type (zsh or bash)" })),
]);

type Props = {
	args: z.infer<typeof args>;
};

interface CommandOption {
	name: string;
	description: string;
	completion: "all_branches" | null;
}

interface CommandData {
	name: string;
	funcName: string;
	description: string;
	hasArgs: boolean;
	argCompletion: "worktree_branches" | "shells" | "static" | null;
	argCompletionValues: string;
	options: CommandOption[];
}

const ARG_COMPLETIONS: Record<string, "worktree_branches" | "shells"> = {};

function extractOptions(mod: any): CommandOption[] {
	const options: CommandOption[] = [];
	if (mod.options) {
		const shape = mod.options.shape ?? {};
		for (const [key, value] of Object.entries(shape)) {
			const schema = value as any;
			const desc = schema.description ?? schema._zod?.def?.description ?? "";
			options.push({
				name: key,
				description: desc,
				completion: key === "base" ? "all_branches" : null,
			});
		}
	}
	return options;
}

/**
 * Dynamically loads command modules and extracts their metadata.
 * Handles both top-level files and directory-based command groups.
 */
async function getCommands(): Promise<CommandData[]> {
	const commandsDir = join(__dirname, "..");
	const entries = readdirSync(commandsDir);
	const commands: CommandData[] = [];

	for (const entry of entries) {
		const entryPath = join(commandsDir, entry);
		const stat = statSync(entryPath);

		if (stat.isDirectory()) {
			// Directory-based command group — complete arg to subcommand names
			const subFiles = readdirSync(entryPath).filter((f) => f.endsWith(".js") && f !== "index.js");
			const subNames = subFiles.map((f) => f.replace(".js", ""));
			if (subNames.length === 0) continue;

			let description = "";
			const indexPath = join(entryPath, "index.js");
			if (existsSync(indexPath)) {
				try {
					const indexMod = await import(indexPath);
					description = indexMod.description ?? "";
				} catch {
					// no description
				}
			}

			commands.push({
				name: entry,
				funcName: entry.replace(/-/g, "_"),
				description,
				hasArgs: true,
				argCompletion: "static",
				argCompletionValues: subNames.join(" "),
				options: [],
			});
			continue;
		}

		if (!entry.endsWith(".js")) continue;
		const name = entry.replace(".js", "");

		try {
			const mod = await import(join(commandsDir, entry));
			if (!mod.description) continue;

			commands.push({
				name,
				funcName: name.replace(/-/g, "_"),
				description: mod.description,
				hasArgs: !!mod.args,
				argCompletion: ARG_COMPLETIONS[name] || null,
				argCompletionValues: "",
				options: extractOptions(mod),
			});
		} catch {
			// Skip files that can't be imported
		}
	}

	return commands.sort((a, b) => a.name.localeCompare(b.name));
}

// Configure nunjucks
const templatesDir = join(__dirname, "..", "..", "..", "shell");
nunjucks.configure(templatesDir, { autoescape: false });

export default function ShellInit({ args }: Props) {
	const [shell] = args;
	const [done, setDone] = useState(false);
	const hasOutputRef = useRef(false);

	useEffect(() => {
		async function run() {
			if (hasOutputRef.current) return;
			hasOutputRef.current = true;

			const commands = await getCommands();
			const templateFile = `init.${shell}.njk`;
			const output = nunjucks.render(templateFile, { commands });

			process.stdout.write(output);
			setDone(true);
		}

		run();
	}, [shell]);

	useEffect(() => {
		if (done) {
			process.exit(0);
		}
	}, [done]);

	return null;
}
