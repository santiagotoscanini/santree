/**
 * Due-date formatting for the Triage tab. Turns Linear's `YYYY-MM-DD`
 * `dueDate` string into a short, urgency-coded badge used by both the issue
 * list (right column) and the detail panel.
 *
 * Urgency buckets (by whole calendar days from today, local time):
 *   - overdue (< 0)        → red,    "⚠ overdue Nd"
 *   - due today (0)        → red,    "⚠ due today"
 *   - soon (1–2 days)      → yellow, "due in Nd"
 *   - later (≥ 3 days)     → gray,   "due Mon D"
 *
 * Returns null when there is no due date so callers can render nothing.
 */
export interface DueInfo {
	/** Short badge text, e.g. "⚠ overdue 3d" or "due Jun 12". */
	label: string;
	/** Ink color name keyed to urgency. */
	color: "red" | "yellow" | "gray";
	/** True for overdue/today — the cases worth a warning glyph. */
	urgent: boolean;
	/** Whole days until due (negative when overdue). */
	days: number;
}

/** Whole-day difference between two dates, ignoring time-of-day. */
function dayDiff(from: Date, to: Date): number {
	const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
	const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
	return Math.round((b - a) / 86_400_000);
}

export function formatDueDate(
	dueDate: string | null | undefined,
	now: Date = new Date(),
): DueInfo | null {
	if (!dueDate) return null;
	// Parse `YYYY-MM-DD` as a local date (not UTC) so "today" matches the user's
	// wall clock. `new Date("2026-06-12")` would parse as UTC midnight; build the
	// date from parts instead.
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dueDate);
	if (!m) return null;
	const due = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	if (Number.isNaN(due.getTime())) return null;

	const days = dayDiff(now, due);
	const monthDay = due.toLocaleDateString("en-US", { month: "short", day: "numeric" });

	if (days < 0) {
		const n = Math.abs(days);
		return { label: `⚠ overdue ${n}d`, color: "red", urgent: true, days };
	}
	if (days === 0) {
		return { label: "⚠ due today", color: "red", urgent: true, days };
	}
	if (days <= 2) {
		return { label: `due in ${days}d`, color: "yellow", urgent: false, days };
	}
	return { label: `due ${monthDay}`, color: "gray", urgent: false, days };
}
