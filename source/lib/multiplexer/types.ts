export type MultiplexerKind = "tmux" | "cmux" | "none";

export type SessionResult =
	| { ok: true }
	| { ok: false; reason: "not-active" | "failed"; message?: string };

export interface CreateWindowOpts {
	name: string;
	cwd: string;
	command?: string;
	/**
	 * Optional sidebar group/folder to place the new window in. Backends that
	 * have no grouping concept (tmux, none) ignore it; cmux files the workspace
	 * under a group of this name (creating it on first use). Used to cluster all
	 * windows for one Linear project together.
	 */
	group?: string;
	/**
	 * Optional name for the window's initial tab/surface. cmux renames the tab
	 * after creation; backends without an in-window tab concept ignore it.
	 */
	tabName?: string;
}

export interface AddTabOpts {
	/** Name of the existing window/workspace to add the tab to. */
	windowName: string;
	/** Name for the new tab. */
	tabName: string;
	cwd: string;
	command: string;
	/**
	 * Group to use only if the target window doesn't exist yet and a fresh one
	 * has to be created as a fallback (cmux only).
	 */
	group?: string;
}

export interface Multiplexer {
	readonly kind: MultiplexerKind;

	isActive(): boolean;

	createWindow(opts: CreateWindowOpts): Promise<SessionResult>;

	/**
	 * Add a tab running `command` to an existing window/workspace named
	 * `windowName`. cmux relocates a live surface into that workspace so the two
	 * tabs (e.g. `work` + `fix-loop`) share one ticket workspace. Backends with
	 * no in-window tab concept (tmux, none) create a separate window named
	 * `<tabName>-<windowName>` instead. Falls back to creating the window when it
	 * doesn't exist yet.
	 */
	addTab(opts: AddTabOpts): Promise<SessionResult>;

	selectWindow(name: string): Promise<SessionResult>;

	sendCommand(name: string, command: string): SessionResult;
}

export function shellEscape(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}
