export type MultiplexerKind = "tmux" | "cmux" | "none";

export type SessionResult =
	| { ok: true }
	| { ok: false; reason: "not-active" | "failed"; message?: string };

export interface CreateWindowOpts {
	name: string;
	cwd: string;
	command?: string;
}

export interface Multiplexer {
	readonly kind: MultiplexerKind;

	isActive(): boolean;

	createWindow(opts: CreateWindowOpts): Promise<SessionResult>;

	selectWindow(name: string): Promise<SessionResult>;

	renameWindow(currentName: string, newName: string): SessionResult;

	sendCommand(name: string, command: string): SessionResult;

	isSessionAlive(ticketId: string): boolean;
}

export function shellEscape(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}
