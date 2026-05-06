import { cmuxMultiplexer } from "./cmux.js";
import { noneMultiplexer } from "./none.js";
import { tmuxMultiplexer } from "./tmux.js";
import type { Multiplexer, MultiplexerKind } from "./types.js";

export type { CreateWindowOpts, Multiplexer, MultiplexerKind, SessionResult } from "./types.js";

// Each adapter declares its own runtime detection in `isActive()`. Order matters:
// if more than one adapter reports active (e.g. tmux running inside a cmux
// workspace), the first match wins.
const CANDIDATES: Multiplexer[] = [tmuxMultiplexer, cmuxMultiplexer];

export function getMultiplexer(): Multiplexer {
	return CANDIDATES.find((m) => m.isActive()) ?? noneMultiplexer;
}

export function getMultiplexerKind(): MultiplexerKind {
	return getMultiplexer().kind;
}
