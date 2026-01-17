import { useEffect, useState, useRef } from "react";
import { argument } from "pastel";
import { z } from "zod/v4";
import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const args = z.tuple([
	z
		.enum(["zsh", "bash"])
		.default("zsh")
		.describe(argument({ name: "shell", description: "Shell type (zsh or bash)" })),
]);

type Props = {
	args: z.infer<typeof args>;
};

interface CommandInfo {
	name: string;
	description: string;
	options: { name: string; description: string; hasValue: boolean }[];
	hasArgs: boolean;
}

const COMMAND_DESCRIPTIONS: Record<string, string> = {
	"list": "List all worktrees with status information",
	"create": "Create a new worktree from a branch",
	"switch": "Switch to another worktree",
	"remove": "Remove a worktree and its branch",
	"work": "Launch Claude to work on current ticket",
	"setup": "Run init script in current worktree",
	"sync": "Sync worktree with base branch",
	"clean": "Remove worktrees with merged/closed PRs",
	"doctor": "Check system requirements and integrations",
	"pr": "Create a GitHub pull request",
	"commit": "Stage and commit changes",
	"shell-init": "Output shell integration script",
};

const COMMAND_ALIASES: Record<string, string[]> = {
	"switch": ["switch", "sw"],
	"remove": ["remove", "rm"],
	"work": ["work", "w"],
};

/**
 * Dynamically loads command modules and extracts their options/args.
 */
async function getCommands(): Promise<CommandInfo[]> {
	const commandsDir = __dirname;
	const files = readdirSync(commandsDir).filter(f => f.endsWith(".js"));
	const commands: CommandInfo[] = [];

	for (const file of files) {
		const name = file.replace(".js", "");
		if (!COMMAND_DESCRIPTIONS[name]) continue;

		try {
			const mod = await import(join(commandsDir, file));
			const info: CommandInfo = {
				name,
				description: COMMAND_DESCRIPTIONS[name],
				options: [],
				hasArgs: !!mod.args,
			};

			// Parse options from Zod schema (Zod v4 compatible)
			if (mod.options) {
				// Zod v4: shape is directly accessible as a property
				const shape = mod.options.shape ?? {};
				for (const [key, value] of Object.entries(shape)) {
					const schema = value as any;
					// Get description from various possible locations
					const desc = schema.description ?? schema._zod?.def?.description ?? "";
					// Check if it's a string type (has value)
					const typeName = schema._zod?.def?.type ?? schema._def?.typeName ?? "";
					const innerTypeName = schema._zod?.def?.innerType?._zod?.def?.type ?? "";
					const hasValue = typeName === "string" || innerTypeName === "string";
					info.options.push({ name: key, description: desc, hasValue });
				}
			}

			commands.push(info);
		} catch {
			// Skip files that can't be imported
		}
	}

	return commands.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Generates Zsh completion script.
 */
function generateZshCompletions(commands: CommandInfo[]): string {
	const lines: string[] = [
		"# Santree Zsh Completions (auto-generated)",
		"",
		"__santree_get_worktree_branches() {",
		"    local -a branches",
		"    branches=(${(f)\"$(git worktree list --porcelain 2>/dev/null | grep '^branch ' | sed 's/branch refs\\/heads\\///' 2>/dev/null)\"})",
		"    _describe -t branches 'worktree branches' branches",
		"}",
		"",
		"__santree_get_all_branches() {",
		"    local -a branches",
		"    branches=(${(f)\"$(git branch -a 2>/dev/null | sed 's/^[* ] //' | sed 's/remotes\\/origin\\///' | sort -u)\"})",
		"    _describe -t branches 'git branches' branches",
		"}",
		"",
		"_santree_complete() {",
		"    local -a commands",
		"    commands=(",
	];

	for (const cmd of commands) {
		lines.push(`        '${cmd.name}:${cmd.description}'`);
	}

	lines.push(
		"    )",
		"",
		'    if (( CURRENT == 2 )); then',
		"        _describe -t commands 'santree commands' commands",
		"        return",
		"    fi",
		"",
		"    case $words[2] in",
	);

	for (const cmd of commands) {
		const aliases = COMMAND_ALIASES[cmd.name] || [cmd.name];
		lines.push(`        ${aliases.join("|")})`);

		if (cmd.options.length === 0 && !cmd.hasArgs) {
			lines.push("            ;;");
		} else {
			const opts: string[] = [];

			// Add argument completions for specific commands
			if (cmd.name === "switch" || cmd.name === "remove") {
				opts.push("'1:branch:__santree_get_worktree_branches'");
			} else if (cmd.name === "shell-init") {
				opts.push("'1:shell:(zsh bash)'");
			} else if (cmd.hasArgs) {
				opts.push("'1:argument:'");
			}

			for (const opt of cmd.options) {
				let completion = "";
				if (opt.name === "base") {
					completion = ":branch:__santree_get_all_branches";
				} else if (opt.hasValue) {
					completion = ":value:";
				}
				opts.push(`'--${opt.name}[${opt.description}]${completion}'`);
			}

			if (opts.length > 0) {
				lines.push(`            _arguments ${opts.join(" ")}`);
			}
			lines.push("            ;;");
		}
	}

	lines.push(
		"    esac",
		"}",
		"",
		"compdef _santree_complete santree",
	);

	return lines.join("\n");
}

/**
 * Generates Bash completion script.
 */
function generateBashCompletions(commands: CommandInfo[]): string {
	const cmdNames = commands.map(c => c.name).join(" ");

	const lines: string[] = [
		"# Santree Bash Completions (auto-generated)",
		"",
		"_santree_complete() {",
		"    local cur prev commands",
		"    COMPREPLY=()",
		'    cur="${COMP_WORDS[COMP_CWORD]}"',
		'    prev="${COMP_WORDS[COMP_CWORD-1]}"',
		"",
		`    commands="${cmdNames}"`,
		"",
		'    if [[ ${COMP_CWORD} -eq 1 ]]; then',
		'        COMPREPLY=($(compgen -W "${commands}" -- "${cur}"))',
		"        return 0",
		"    fi",
		"",
		'    case "${COMP_WORDS[1]}" in',
	];

	for (const cmd of commands) {
		const opts = cmd.options.map(o => `--${o.name}`).join(" ");
		lines.push(`        ${cmd.name})`);
		if (opts) {
			lines.push(`            COMPREPLY=($(compgen -W "${opts}" -- "\${cur}"))`);
		}
		lines.push("            ;;");
	}

	lines.push(
		"    esac",
		"}",
		"",
		"complete -F _santree_complete santree",
	);

	return lines.join("\n");
}

/**
 * Reads the shell initialization script from the shell/ directory.
 */
function getShellScript(shell: "zsh" | "bash"): string {
	const extension = shell === "zsh" ? "zsh" : "bash";
	const scriptPath = join(__dirname, "..", "..", "shell", `init.${extension}`);
	return readFileSync(scriptPath, "utf-8");
}

export default function ShellInit({ args }: Props) {
	const [shell] = args;
	const [done, setDone] = useState(false);
	const hasOutputRef = useRef(false);

	useEffect(() => {
		async function run() {
			if (hasOutputRef.current) return;
			hasOutputRef.current = true;

			// Get shell wrapper script
			const wrapperScript = getShellScript(shell);

			// Generate completions dynamically
			const commands = await getCommands();
			const completions = shell === "zsh"
				? generateZshCompletions(commands)
				: generateBashCompletions(commands);

			// Output both
			process.stdout.write(wrapperScript + "\n\n" + completions + "\n");

			setDone(true);
		}

		run();
	}, [shell]);

	// Exit after output is complete
	useEffect(() => {
		if (done) {
			process.exit(0);
		}
	}, [done]);

	return null;
}
