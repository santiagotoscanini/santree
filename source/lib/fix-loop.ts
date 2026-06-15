import * as fs from "fs";
import * as path from "path";
import { getSantreeDir } from "./metadata.js";

/**
 * Marker store for the auto-fix `/loop` (see `santree pr fix --loop`).
 *
 * Each running loop writes `.santree/fix-loops/<ticketId>.json` and heartbeats it
 * every iteration. The dashboard reads these markers to render a per-ticket fix-loop
 * badge — kept as files (not in dashboard memory) because the loop runs in a separate
 * process/window and must survive dashboard restarts. Staleness is timestamp-based:
 * the loop has a known cadence, so a "running" marker that hasn't heartbeat in a
 * while is treated as stalled.
 *
 * Standalone module (only `fs`/`path`/`metadata`) so both commands and the dashboard
 * data layer can import it without pulling in git/tracker cycles.
 */

/** Lifecycle status written by the loop. `stopped:*` are terminal. */
export type FixLoopStatus =
	| "running"
	| "merging"
	| "fixing"
	| "waiting-ci"
	| "stopped:clean"
	| "stopped:stuck";

export interface FixLoopMarker {
	status: FixLoopStatus;
	/** Loop interval in minutes (used for staleness math). */
	intervalMin: number;
	/** ISO timestamp the loop first launched. */
	startedAt: string;
	/** ISO timestamp of the last heartbeat / status change. */
	at: string;
}

/** Display phase derived from a marker + the current time. */
export type FixLoopPhase = "running" | "stalled" | "stopped-clean" | "stopped-stuck";

export interface FixLoopRuntime {
	phase: FixLoopPhase;
	status: FixLoopStatus;
	startedAt: string;
	at: string;
	ageMs: number;
}

function getFixLoopsDir(repoRoot: string): string {
	return path.join(getSantreeDir(repoRoot), "fix-loops");
}

function markerPath(repoRoot: string, ticketId: string): string {
	return path.join(getFixLoopsDir(repoRoot), `${ticketId}.json`);
}

/** Create/overwrite a marker as a freshly-started running loop. */
export function startFixLoop(repoRoot: string, ticketId: string, intervalMin: number): void {
	const now = new Date().toISOString();
	writeMarker(repoRoot, ticketId, {
		status: "running",
		intervalMin,
		startedAt: now,
		at: now,
	});
}

/**
 * Update an existing marker's status and heartbeat. If no marker exists yet (e.g. a
 * signal arrives before the launcher wrote one), a minimal one is created so the
 * dashboard still reflects the loop.
 */
export function signalFixLoop(repoRoot: string, ticketId: string, status: FixLoopStatus): void {
	const prev = readFixLoopMarker(repoRoot, ticketId);
	const now = new Date().toISOString();
	writeMarker(repoRoot, ticketId, {
		status,
		intervalMin: prev?.intervalMin ?? 5,
		startedAt: prev?.startedAt ?? now,
		at: now,
	});
}

function writeMarker(repoRoot: string, ticketId: string, marker: FixLoopMarker): void {
	const dir = getFixLoopsDir(repoRoot);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(markerPath(repoRoot, ticketId), JSON.stringify(marker, null, 2) + "\n");
}

export function readFixLoopMarker(repoRoot: string, ticketId: string): FixLoopMarker | null {
	const filePath = markerPath(repoRoot, ticketId);
	if (!fs.existsSync(filePath)) return null;
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as FixLoopMarker;
	} catch {
		return null;
	}
}

export function clearFixLoop(repoRoot: string, ticketId: string): void {
	try {
		fs.unlinkSync(markerPath(repoRoot, ticketId));
	} catch {
		// Ignore if missing.
	}
}

/**
 * A heartbeating loop that hasn't checked in for ~2.5 intervals is treated as
 * stalled (its window was probably closed). Floor of 10 min so a slow first
 * iteration isn't mistaken for a dead loop.
 */
function staleThresholdMs(intervalMin: number): number {
	return Math.max(intervalMin * 2.5, 10) * 60_000;
}

/** Derive the dashboard-facing phase from a marker. Returns null if no marker. */
export function readFixLoopRuntime(
	repoRoot: string,
	ticketId: string,
	now: number = Date.now(),
): FixLoopRuntime | null {
	const marker = readFixLoopMarker(repoRoot, ticketId);
	if (!marker) return null;
	const ageMs = now - new Date(marker.at).getTime();
	let phase: FixLoopPhase;
	if (marker.status === "stopped:clean") phase = "stopped-clean";
	else if (marker.status === "stopped:stuck") phase = "stopped-stuck";
	else if (ageMs > staleThresholdMs(marker.intervalMin)) phase = "stalled";
	else phase = "running";
	return { phase, status: marker.status, startedAt: marker.startedAt, at: marker.at, ageMs };
}
