import { readAllMetadata, writeAllMetadata } from "../metadata.js";
import type { IssueTrackerKind } from "./types.js";

export interface TrackerConfig {
	kind: IssueTrackerKind | null;
	legacyLinearOrg: string | null;
}

export function readTrackerConfig(repoRoot: string): TrackerConfig {
	const all = readAllMetadata(repoRoot);
	const tracker = all._tracker as { kind?: string } | undefined;
	const linear = all._linear as { org?: string } | undefined;
	let kind: IssueTrackerKind | null = null;
	if (tracker?.kind === "linear" || tracker?.kind === "github") {
		kind = tracker.kind;
	}
	return { kind, legacyLinearOrg: linear?.org ?? null };
}

export function setRepoTracker(repoRoot: string, kind: IssueTrackerKind): void {
	const all = readAllMetadata(repoRoot);
	all._tracker = { kind };
	writeAllMetadata(repoRoot, all);
}

export function removeRepoTracker(repoRoot: string): void {
	const all = readAllMetadata(repoRoot);
	delete all._tracker;
	writeAllMetadata(repoRoot, all);
}
