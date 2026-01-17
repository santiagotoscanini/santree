import { argument } from "pastel";
import { z } from "zod/v4";
import { readFileSync } from "fs";
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

/**
 * Reads the shell initialization script from the shell/ directory.
 * These scripts provide a wrapper function that enables:
 * - Automatic directory switching after create/switch commands
 * - Recovery when current worktree directory is deleted
 */
function getShellScript(shell: "zsh" | "bash"): string {
	const extension = shell === "zsh" ? "zsh" : "bash";
	const scriptPath = join(__dirname, "..", "..", "shell", `init.${extension}`);
	return readFileSync(scriptPath, "utf-8");
}

export default function ShellInit({ args }: Props) {
	const [shell] = args;
	const script = getShellScript(shell);
	console.log(script);
	return null;
}
