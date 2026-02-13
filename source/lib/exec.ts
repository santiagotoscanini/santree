import { execSync, exec, spawn } from "child_process";
import { promisify } from "util";

const execPromise = promisify(exec);

/**
 * Run a shell command and return trimmed stdout, or null on failure.
 */
export function run(
	command: string,
	options?: { cwd?: string; maxBuffer?: number },
): string | null {
	try {
		return execSync(command, { encoding: "utf-8", ...options }).trim();
	} catch {
		return null;
	}
}

/**
 * Run a shell command asynchronously and return trimmed stdout, or null on failure.
 */
export async function runAsync(
	command: string,
	options?: { cwd?: string; maxBuffer?: number },
): Promise<string | null> {
	try {
		const { stdout } = await execPromise(command, { encoding: "utf-8", ...options });
		return stdout.trim();
	} catch {
		return null;
	}
}

/**
 * Spawn a command asynchronously and capture its output.
 * Returns the exit code and combined stdout/stderr.
 */
export function spawnAsync(
	cmd: string,
	args: string[],
	options?: {
		cwd?: string;
		env?: NodeJS.ProcessEnv;
		onOutput?: (data: string) => void;
	},
): Promise<{ code: number; output: string }> {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, {
			cwd: options?.cwd,
			env: options?.env,
			stdio: "pipe",
		});
		let output = "";

		child.stdout?.on("data", (data) => {
			output += data.toString();
			options?.onOutput?.(output);
		});

		child.stderr?.on("data", (data) => {
			output += data.toString();
			options?.onOutput?.(output);
		});

		child.on("close", (code) => {
			resolve({ code: code ?? 1, output });
		});

		child.on("error", (err) => {
			resolve({ code: 1, output: err.message });
		});
	});
}
