/**
 * Triage SLA + snooze formatting for the Triage tab. Linear issues in triage
 * carry an `slaBreachesAt` ISO timestamp (when the response SLA is breached);
 * we render a short, urgency-coded countdown badge — the same "2d 23h" / "13h"
 * shape Linear itself shows — used by both the issue list (right column) and
 * the detail panel.
 *
 * Urgency buckets (by time until breach):
 *   - breached (≤ 0)        → red,    "breached"
 *   - imminent (< 24h)      → red,    "5h" / "45m"
 *   - soon (< 48h)          → yellow, "1d 6h"
 *   - later (≥ 48h)         → gray,   "3d 2h"
 *
 * Returns null when there is no SLA so callers can render nothing.
 */
export interface SlaInfo {
	/** Short badge text, e.g. "2d 23h", "13h", or "breached". */
	label: string;
	/** Ink color name keyed to urgency. */
	color: "red" | "yellow" | "gray";
	/** True for breached / < 24h — the cases worth a bold warning. */
	urgent: boolean;
}

export function formatSla(
	slaBreachesAt: string | null | undefined,
	now: Date = new Date(),
): SlaInfo | null {
	if (!slaBreachesAt) return null;
	const breach = Date.parse(slaBreachesAt);
	if (Number.isNaN(breach)) return null;

	const ms = breach - now.getTime();
	if (ms <= 0) return { label: "breached", color: "red", urgent: true };

	const totalMin = Math.floor(ms / 60_000);
	const days = Math.floor(totalMin / 1440);
	const hours = Math.floor((totalMin % 1440) / 60);
	const mins = totalMin % 60;

	let label: string;
	if (days >= 1) label = `${days}d ${hours}h`;
	else if (hours >= 1) label = `${hours}h`;
	else label = `${mins}m`;

	const hoursLeft = ms / 3_600_000;
	if (hoursLeft < 24) return { label, color: "red", urgent: true };
	if (hoursLeft < 48) return { label, color: "yellow", urgent: false };
	return { label, color: "gray", urgent: false };
}

/** True when the issue is snoozed past the current moment. A snoozed triage
 * issue is parked — the UI greys it and sinks it below active work. */
export function isSnoozed(
	snoozedUntilAt: string | null | undefined,
	now: Date = new Date(),
): boolean {
	if (!snoozedUntilAt) return false;
	const until = Date.parse(snoozedUntilAt);
	return !Number.isNaN(until) && until > now.getTime();
}
