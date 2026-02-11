import { execSync } from "child_process";

/**
 * Run a shell command and return trimmed stdout, or null on failure.
 */
export function run(command: string, options?: { cwd?: string; maxBuffer?: number }): string | null {
	try {
		return execSync(command, { encoding: "utf-8", ...options }).trim();
	} catch {
		return null;
	}
}
