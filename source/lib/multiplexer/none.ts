import type { Multiplexer, MultiplexerKind, SessionResult } from "./types.js";

const NOT_ACTIVE: SessionResult = { ok: false, reason: "not-active" };

export const noneMultiplexer: Multiplexer = {
	kind: "none" as MultiplexerKind,

	isActive(): boolean {
		return false;
	},

	async createWindow(): Promise<SessionResult> {
		return NOT_ACTIVE;
	},

	async selectWindow(): Promise<SessionResult> {
		return NOT_ACTIVE;
	},

	sendCommand(): SessionResult {
		return NOT_ACTIVE;
	},

	isSessionAlive(): boolean {
		return false;
	},
};
