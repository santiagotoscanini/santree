import { execSync } from "child_process";
import type {
	AddTabOpts,
	CreateWindowOpts,
	Multiplexer,
	MultiplexerKind,
	SessionResult,
} from "./types.js";
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

interface CmuxPaneSurfaces {
	pane_ref?: string;
	surfaces?: { ref?: string }[];
}

// `list-pane-surfaces --workspace X` reports one pane (the active one) and its
// surfaces (tabs). Enough for our two flows: the work workspace has a single
// pane, and a freshly-created temp workspace has a single pane + single surface.
function paneSurfaces(workspaceRef: string): CmuxPaneSurfaces | null {
	const r = cmuxRun(`cmux --json list-pane-surfaces --workspace ${shellEscape(workspaceRef)}`);
	if (!r.ok) return null;
	try {
		return JSON.parse(r.stdout) as CmuxPaneSurfaces;
	} catch {
		return null;
	}
}

function renameTab(workspaceRef: string, surfaceRef: string, title: string): void {
	cmuxRun(
		`cmux rename-tab --workspace ${shellEscape(workspaceRef)} --surface ${shellEscape(surfaceRef)} ${shellEscape(title)}`,
	);
}

interface CmuxGroup {
	id: string;
	name?: string;
	anchor_workspace_ref?: string;
	member_workspace_refs?: string[];
}

// cmux exposes workspace-group (sidebar folder) operations only over the RPC
// socket, not as first-class subcommands. `cmux rpc <method> '<json>'`.
function cmuxRpc(
	method: string,
	params?: Record<string, unknown>,
): { ok: true; data: unknown } | { ok: false } {
	const arg = params ? ` ${shellEscape(JSON.stringify(params))}` : "";
	const result = cmuxRun(`cmux rpc ${method}${arg}`);
	if (!result.ok) return { ok: false };
	try {
		return { ok: true, data: JSON.parse(result.stdout) };
	} catch {
		return { ok: false };
	}
}

function findGroupIdByName(name: string): string | null {
	const r = cmuxRpc("workspace.group.list");
	if (!r.ok) return null;
	const groups = (r.data as { groups?: CmuxGroup[] })?.groups ?? [];
	return groups.find((g) => g.name === name)?.id ?? null;
}

// Snapshot every workspace's current group membership (ref -> group id), so we
// can detect and undo the side effect described in `createGroup` below.
function snapshotMemberships(): Map<string, string> {
	const map = new Map<string, string>();
	const r = cmuxRpc("workspace.group.list");
	if (!r.ok) return map;
	for (const g of (r.data as { groups?: CmuxGroup[] })?.groups ?? []) {
		if (!g.id) continue;
		for (const ref of g.member_workspace_refs ?? []) map.set(ref, g.id);
	}
	return map;
}

// Create a sidebar group (folder) named `name` and return its id.
//
// Two cmux quirks shape this:
//  1. A group renders as a folder whose header IS its "anchor" workspace
//     (auto-titled with the group name); members nest under it. We must keep
//     that anchor — closing it removes the folder label and cmux flattens the
//     members back to top-level rows (visually ungrouped).
//  2. `workspace.group.create` also pulls the *currently-selected* workspace
//     into the new group as a stray member. We undo that: restore each stray to
//     whatever group it was in before (or detach it if none), so creating a
//     project folder never disturbs the user's existing folders or their
//     dashboard window.
function createGroup(name: string): string | null {
	const before = snapshotMemberships();
	const created = cmuxRpc("workspace.group.create", { name });
	if (!created.ok) return null;
	const group = (created.data as { group?: CmuxGroup })?.group;
	if (!group?.id) return null;
	const anchor = group.anchor_workspace_ref;
	for (const ref of group.member_workspace_refs ?? []) {
		if (ref === anchor) continue;
		const prev = before.get(ref);
		if (prev && prev !== group.id) {
			cmuxRpc("workspace.group.add", { group_id: prev, workspace_id: ref });
		} else {
			cmuxRpc("workspace.group.remove", { group_id: group.id, workspace_id: ref });
		}
	}
	return group.id;
}

// Place an already-created workspace into a sidebar group named `groupName`,
// creating the group on first use. Best-effort: any failure leaves the
// workspace ungrouped but otherwise intact.
function placeWorkspaceInGroup(groupName: string, workspaceRef: string): void {
	const groupId = findGroupIdByName(groupName) ?? createGroup(groupName);
	if (!groupId) return;
	cmuxRpc("workspace.group.add", { group_id: groupId, workspace_id: workspaceRef });
}

export const cmuxMultiplexer: Multiplexer = {
	kind: "cmux" as MultiplexerKind,

	isActive(): boolean {
		return !!process.env["CMUX_SURFACE_ID"];
	},

	async createWindow({
		name,
		cwd,
		command,
		group,
		tabName,
	}: CreateWindowOpts): Promise<SessionResult> {
		// `new-workspace` accepts --name, --cwd, --command in a single atomic call.
		// `--command` sends "<text>\n" to the new surface after creation, which IS
		// the one reliable way to get a live PTY (cmux #1472 only breaks commands on
		// surfaces created *after* the workspace exists).
		const parts = [`cmux new-workspace --name ${shellEscape(name)} --cwd ${shellEscape(cwd)}`];
		if (command) parts.push(`--command ${shellEscape(command)}`);
		const created = cmuxRun(parts.join(" "));
		if (!created.ok) {
			return { ok: false, reason: "failed", message: "cmux new-workspace failed" };
		}
		// Grouping / tab-naming are best-effort and must never fail the launch.
		// `new-workspace` prints the new workspace ref (`OK workspace:N`) to stdout.
		const ref = created.stdout.match(/workspace:\d+/)?.[0];
		if (group && ref) placeWorkspaceInGroup(group, ref);
		if (tabName && ref) {
			const surface = paneSurfaces(ref)?.surfaces?.[0]?.ref;
			if (surface) renameTab(ref, surface, tabName);
		}
		return { ok: true };
	},

	async addTab({ windowName, tabName, cwd, command, group }: AddTabOpts): Promise<SessionResult> {
		const target = findWorkspaceByTitle(windowName);
		// No existing workspace for this ticket — create one named after it, with
		// the command as its (renamed) tab.
		if (!target?.ref) {
			return this.createWindow({ name: windowName, cwd, command, group, tabName });
		}
		const targetPane = paneSurfaces(target.ref)?.pane_ref;
		if (!targetPane) {
			return { ok: false, reason: "failed", message: "could not resolve target pane" };
		}
		// A surface only gets a live PTY when its command is baked in at workspace
		// creation. So we spawn the command in a throwaway workspace, then relocate
		// the (already-running) surface into the target pane and discard the husk.
		const tmpName = `__santree_tab_${windowName}`;
		const tmp = cmuxRun(
			`cmux new-workspace --name ${shellEscape(tmpName)} --cwd ${shellEscape(cwd)} --command ${shellEscape(command)}`,
		);
		if (!tmp.ok) {
			return { ok: false, reason: "failed", message: "could not launch tab command" };
		}
		const tmpRef = tmp.stdout.match(/workspace:\d+/)?.[0];
		const surface = tmpRef ? paneSurfaces(tmpRef)?.surfaces?.[0]?.ref : undefined;
		if (!tmpRef || !surface) {
			return { ok: false, reason: "failed", message: "could not resolve new tab surface" };
		}
		const moved = cmuxRun(
			`cmux move-surface --surface ${shellEscape(surface)} --pane ${shellEscape(targetPane)}`,
		);
		if (!moved.ok) {
			// Leave the command running in its own workspace rather than losing it.
			return { ok: false, reason: "failed", message: "could not move tab into workspace" };
		}
		cmuxRun(`cmux workspace close --workspace ${shellEscape(tmpRef)}`);
		renameTab(target.ref, surface, tabName);
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

	sendCommand(_name: string, _command: string): SessionResult {
		// Blocked by manaflow-ai/cmux#1472 — programmatically created workspaces have
		// dead PTYs, so post-creation `cmux send` / `send-key` silently drop input.
		// Initial command-on-create works via `new-workspace --command`; this path is for
		// follow-up sends to an existing workspace, which doesn't.
		return {
			ok: false,
			reason: "failed",
			message: "blocked by manaflow-ai/cmux#1472",
		};
	},
};
