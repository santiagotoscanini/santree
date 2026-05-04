import { cmuxMultiplexer } from "./cmux.js";
import { noneMultiplexer } from "./none.js";
import { tmuxMultiplexer } from "./tmux.js";
import type { Multiplexer, MultiplexerKind } from "./types.js";

export type { CreateWindowOpts, Multiplexer, MultiplexerKind, SessionResult } from "./types.js";

export function getMultiplexer(): Multiplexer {
	const explicit = process.env["SANTREE_MULTIPLEXER"]?.toLowerCase();
	if (explicit === "tmux") return tmuxMultiplexer;
	if (explicit === "cmux") return cmuxMultiplexer;
	if (explicit === "none") return noneMultiplexer;

	if (process.env["TMUX"]) return tmuxMultiplexer;
	if (process.env["CMUX_SURFACE_ID"]) return cmuxMultiplexer;
	return noneMultiplexer;
}

export function getMultiplexerKind(): MultiplexerKind {
	return getMultiplexer().kind;
}
