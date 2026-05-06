import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface GhUser {
	login: string;
}

export async function getAuthenticatedUser(): Promise<GhUser | null> {
	try {
		const { stdout } = await execAsync("gh api user --jq .login");
		const login = stdout.trim();
		if (!login) return null;
		return { login };
	} catch {
		return null;
	}
}

export async function getCurrentRepoNwo(cwd?: string): Promise<string | null> {
	try {
		const { stdout } = await execAsync("gh repo view --json nameWithOwner --jq .nameWithOwner", {
			cwd,
		});
		const nwo = stdout.trim();
		return nwo || null;
	} catch {
		return null;
	}
}
