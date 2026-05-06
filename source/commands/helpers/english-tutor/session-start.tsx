import * as fs from "fs";
import { useEffect, useRef } from "react";
import { getLogPath } from "../../../lib/english-tutor.js";

export const description = "Replay practice log (SessionStart hook)";

export default function SessionStart() {
	const hasRun = useRef(false);

	useEffect(() => {
		if (hasRun.current) return;
		hasRun.current = true;

		try {
			const logPath = getLogPath();
			if (fs.existsSync(logPath)) {
				const contents = fs.readFileSync(logPath, "utf-8").trim();
				const entryCount = (contents.match(/^- /gm) || []).length;
				if (contents.length > 0) {
					process.stdout.write(
						`[ENGLISH TUTOR — PRACTICE LOG REPLAY]\n\n${contents}\n\n--- LOG END ---\n`,
					);
					// Only ask for a summary once there are enough entries to be useful.
					// Below that threshold the log is too sparse to surface real patterns,
					// and a forced summary would just noise up new sessions.
					if (entryCount >= 3) {
						process.stdout.write(
							`\n[ENGLISH TUTOR — SESSION-START INSTRUCTION]\n` +
								`At the very start of your first response in this session, briefly note any RECURRING patterns from the log above (1-3 short bullets, e.g. "you frequently drop articles", "watch for 'their' vs 'there'"). Skip this entirely if no clear patterns emerge or if the user's first message is purely a coding task. Do not list every entry — only patterns.\n`,
						);
					}
				}
			}
		} catch {
			// hook must never block the session — silently no-op on read error
		}

		process.exit(0);
	}, []);

	return null;
}
