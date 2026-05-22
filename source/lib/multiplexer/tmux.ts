import { execSync } from "child_process";
import type { CreateWindowOpts, Multiplexer, MultiplexerKind, SessionResult } from "./types.js";
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

	isSessionAlive(ticketId: string): boolean {
		try {
			const output = execSync('tmux list-windows -F "#{window_name}\t#{pane_pid}"', {
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "ignore"],
			}).trim();

			for (const line of output.split("\n")) {
				const [name, pidStr] = line.split("\t");
				if (!name?.startsWith(ticketId)) continue;
				if (!pidStr) return false;
				try {
					const ps = execSync(`pgrep -P ${pidStr} -a`, {
						encoding: "utf-8",
						stdio: ["pipe", "pipe", "ignore"],
					}).trim();
					return ps.split("\n").some((proc) => proc.includes("claude"));
				} catch {
					return false;
				}
			}
		} catch {
			// tmux not available
		}
		return false;
	},
};
