import { execSync } from "child_process";
import type {
	AddTabOpts,
	CreateWindowOpts,
	Multiplexer,
	MultiplexerKind,
	SessionResult,
} from "./types.js";
import { shellEscape } from "./types.js";

function tmuxSync(cmd: string): boolean {
	try {
		execSync(cmd, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

export const tmuxMultiplexer: Multiplexer = {
	kind: "tmux" as MultiplexerKind,

	isActive(): boolean {
		return !!process.env["TMUX"];
	},

	async createWindow({ name, cwd, command }: CreateWindowOpts): Promise<SessionResult> {
		if (!this.isActive()) return { ok: false, reason: "not-active" };

		const ok = tmuxSync(`tmux new-window -n ${shellEscape(name)} -c ${shellEscape(cwd)}`);
		if (!ok) return { ok: false, reason: "failed", message: "tmux new-window failed" };

		if (command) {
			// Brief race guard: tmux occasionally drops send-keys if it arrives before the
			// window's shell is up. The dashboard has used this for years.
			await new Promise((r) => setTimeout(r, 100));
			const sent = tmuxSync(`tmux send-keys -t ${shellEscape(name)} ${shellEscape(command)} Enter`);
			if (!sent) return { ok: false, reason: "failed", message: "tmux send-keys failed" };
		}
		return { ok: true };
	},

	async addTab({ windowName, tabName, cwd, command }: AddTabOpts): Promise<SessionResult> {
		// tmux has no in-window tab concept, so a "tab" becomes its own window named
		// `<tabName>-<windowName>` (e.g. fix-loop-TEAM-123).
		return this.createWindow({ name: `${tabName}-${windowName}`, cwd, command });
	},

	async selectWindow(name: string): Promise<SessionResult> {
		if (!this.isActive()) return { ok: false, reason: "not-active" };
		const ok = tmuxSync(`tmux select-window -t ${shellEscape(name)}`);
		return ok ? { ok: true } : { ok: false, reason: "failed" };
	},

	sendCommand(name: string, command: string): SessionResult {
		if (!this.isActive()) return { ok: false, reason: "not-active" };
		const ok = tmuxSync(`tmux send-keys -t ${shellEscape(name)} ${shellEscape(command)} Enter`);
		return ok ? { ok: true } : { ok: false, reason: "failed" };
	},
};
