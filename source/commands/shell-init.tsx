import { useEffect, useState, useRef } from "react";
import { argument } from "pastel";
import { z } from "zod/v4";
import { readdirSync } from "fs";
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
	argCompletion: "worktree_branches" | "shells" | null;
	options: CommandOption[];
}

const ARG_COMPLETIONS: Record<string, "worktree_branches" | "shells"> = {
	"switch": "worktree_branches",
	"remove": "worktree_branches",
	"shell-init": "shells",
};

/**
 * Dynamically loads command modules and extracts their metadata.
 */
async function getCommands(): Promise<CommandData[]> {
	const commandsDir = __dirname;
	const files = readdirSync(commandsDir).filter(f => f.endsWith(".js"));
	const commands: CommandData[] = [];

	for (const file of files) {
		const name = file.replace(".js", "");

		try {
			const mod = await import(join(commandsDir, file));

			// Skip commands without a description export
			if (!mod.description) continue;

			const options: CommandOption[] = [];

			// Parse options from Zod schema (Zod v4 compatible)
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

			commands.push({
				name,
				funcName: name.replace(/-/g, "_"),
				description: mod.description,
				hasArgs: !!mod.args,
				argCompletion: ARG_COMPLETIONS[name] || null,
				options,
			});
		} catch {
			// Skip files that can't be imported
		}
	}

	return commands.sort((a, b) => a.name.localeCompare(b.name));
}

// Configure nunjucks
const templatesDir = join(__dirname, "..", "..", "shell");
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
