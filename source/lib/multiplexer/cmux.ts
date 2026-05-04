import { execSync } from "child_process";
import type { CreateWindowOpts, Multiplexer, MultiplexerKind, SessionResult } from "./types.js";
import { shellEscape } from "./types.js";

const CMUX_TIMEOUT_MS = 2000;

function cmuxRun(cmd: string): { ok: true; stdout: string } | { ok: false } {
	try {
		const stdout = execSync(cmd, {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "ignore"],
			timeout: CMUX_TIMEOUT_MS,
		});
		return { ok: true, stdout };
	} catch {
		return { ok: false };
	}
}

interface CmuxWorkspace {
	ref?: string;
	title?: string;
	[key: string]: unknown;
}

function findWorkspaceByTitle(title: string): CmuxWorkspace | null {
	// `--json` is a global flag and must precede the subcommand.
	const result = cmuxRun("cmux --json list-workspaces");
	if (!result.ok) return null;
	try {
		const parsed = JSON.parse(result.stdout) as { workspaces?: CmuxWorkspace[] };
		const items = parsed.workspaces ?? [];
		return items.find((w) => w.title === title) ?? null;
	} catch {
		return null;
	}
}

export const cmuxMultiplexer: Multiplexer = {
	kind: "cmux" as MultiplexerKind,

	isActive(): boolean {
		return !!process.env["CMUX_SURFACE_ID"];
	},

	async createWindow({ name, cwd, command }: CreateWindowOpts): Promise<SessionResult> {
		// `new-workspace` accepts --name, --cwd, --command in a single atomic call.
		// `--command` sends "<text>\n" to the new surface after creation. cmux #1472 means
		// programmatically created workspaces have dead PTYs, so the command may not actually
		// execute — but the workspace + name are created, which is the visible win.
		const parts = [`cmux new-workspace --name ${shellEscape(name)} --cwd ${shellEscape(cwd)}`];
		if (command) parts.push(`--command ${shellEscape(command)}`);
		const created = cmuxRun(parts.join(" "));
		if (!created.ok) {
			return { ok: false, reason: "failed", message: "cmux new-workspace failed" };
		}
		return { ok: true };
	},

	async selectWindow(name: string): Promise<SessionResult> {
		const ws = findWorkspaceByTitle(name);
		if (!ws?.ref) {
			return { ok: false, reason: "failed", message: `no cmux workspace named ${name}` };
		}
		const result = cmuxRun(`cmux select-workspace --workspace ${shellEscape(ws.ref)}`);
		return result.ok ? { ok: true } : { ok: false, reason: "failed" };
	},

	renameWindow(currentName: string, newName: string): SessionResult {
		// `workspace-action --action rename --title <text>` defaults to the caller's
		// workspace via $CMUX_WORKSPACE_ID. When `currentName` is provided we look up
		// that specific workspace's ref instead.
		let target = "";
		if (currentName) {
			const ws = findWorkspaceByTitle(currentName);
			if (!ws?.ref) {
				return { ok: false, reason: "failed", message: "cmux workspace not found" };
			}
			target = ` --workspace ${shellEscape(ws.ref)}`;
		}
		const result = cmuxRun(
			`cmux workspace-action --action rename --title ${shellEscape(newName)}${target}`,
		);
		return result.ok ? { ok: true } : { ok: false, reason: "failed" };
	},

	sendCommand(_name: string, _command: string): SessionResult {
		// Blocked by manaflow-ai/cmux#1472 — programmatically created workspaces have
		// dead PTYs, so post-creation `cmux send` / `send-key` silently drop input.
		// Initial command-on-create works via `new-workspace --command`; this path is for
		// follow-up sends to an existing workspace, which doesn't.
		return {
			ok: false,
			reason: "unsupported",
			message: "blocked by manaflow-ai/cmux#1472",
		};
	},

	isSessionAlive(ticketId: string): boolean {
		const result = cmuxRun("cmux --json list-workspaces");
		if (!result.ok) return false;
		try {
			const parsed = JSON.parse(result.stdout) as { workspaces?: CmuxWorkspace[] };
			const items = parsed.workspaces ?? [];
			return items.some((w) => typeof w.title === "string" && w.title.startsWith(ticketId));
		} catch {
			return false;
		}
	},
};
