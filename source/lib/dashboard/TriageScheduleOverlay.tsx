import { Box, Text } from "ink";
import type { TriageSchedule } from "./types.js";

type Seg = { text: string; color?: string; bold?: boolean; dim?: boolean };

function fmt(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Flatten the schedules into colored segment-lines. Exported for testing. */
export function buildScheduleLines(schedules: TriageSchedule[]): Seg[][] {
	const lines: Seg[][] = [];
	if (schedules.length === 0) {
		lines.push([{ text: "No triage on-call schedule found for your teams.", dim: true }]);
		return lines;
	}
	schedules.forEach((sch, si) => {
		if (si > 0) lines.push([{ text: "" }]);
		lines.push([
			{ text: "≡ ", color: "cyan", bold: true },
			{ text: sch.scheduleName, bold: true },
			{ text: `   ${sch.teamName}`, dim: true },
		]);
		if (sch.currentName) {
			lines.push([
				{ text: "  on call now: ", dim: true },
				{ text: sch.currentName, color: sch.currentIsMe ? "cyan" : "green", bold: true },
				...(sch.currentIsMe ? [{ text: "  ← you", color: "cyan" as const }] : []),
			]);
		}
		for (const sh of sch.shifts) {
			const range = `${fmt(sh.startsAt)} – ${fmt(sh.endsAt)}`.padEnd(18);
			const segs: Seg[] = [
				{ text: `  ${sh.isCurrent ? "●" : "·"} `, color: sh.isCurrent ? "green" : "gray" },
				{ text: range, dim: !sh.isCurrent && !sh.isMe },
				{
					text: sh.name,
					color: sh.isCurrent ? "green" : sh.isMe ? "cyan" : undefined,
					bold: sh.isCurrent || sh.isMe,
				},
			];
			if (sh.isCurrent) segs.push({ text: "  now", color: "green", bold: true });
			else if (sh.isMe) segs.push({ text: "  you", color: "cyan" });
			lines.push(segs);
		}
	});
	return lines;
}

export default function TriageScheduleOverlay({
	schedules,
	scrollOffset,
	width,
	height,
}: {
	schedules: TriageSchedule[];
	scrollOffset: number;
	width: number;
	height: number;
}) {
	const all = buildScheduleLines(schedules);
	// Title (1) + blank (1) leave the rest for the body. The footer/close hint is
	// owned by the dashboard's global command-bar row, so the panel stays pure
	// content and lines up with the left pane.
	const bodyHeight = Math.max(1, height - 2);
	const maxOffset = Math.max(0, all.length - bodyHeight);
	const off = Math.min(scrollOffset, maxOffset);
	const visible = all.slice(off, off + bodyHeight);
	const clampSegs = (segs: Seg[]): Seg[] => {
		let remaining = width - 1;
		const out: Seg[] = [];
		for (const s of segs) {
			if (remaining <= 0) break;
			if (s.text.length <= remaining) {
				out.push(s);
				remaining -= s.text.length;
			} else {
				out.push({ ...s, text: s.text.slice(0, Math.max(0, remaining - 1)) + "…" });
				remaining = 0;
			}
		}
		return out;
	};

	return (
		<Box flexDirection="column" width={width} height={height} paddingX={1}>
			<Text bold color="cyan">
				Triage on-call schedule
			</Text>
			<Text> </Text>
			{visible.map((segs, i) => (
				<Box key={i}>
					<Text>
						{clampSegs(segs).map((s, j) => (
							<Text key={j} color={s.color as any} bold={s.bold} dimColor={s.dim}>
								{s.text || " "}
							</Text>
						))}
					</Text>
				</Box>
			))}
			{off + bodyHeight < all.length ? <Text dimColor>↓ more (press s to scroll)</Text> : null}
		</Box>
	);
}
