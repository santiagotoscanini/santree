import { useEffect, useRef } from "react";
import { uninstallHooks } from "../../../lib/english-tutor.js";

export const description = "Remove English-tutor hooks from Claude Code settings";

export default function Uninstall() {
	const hasRun = useRef(false);

	useEffect(() => {
		if (hasRun.current) return;
		hasRun.current = true;
		const settingsPath = uninstallHooks();
		process.stdout.write(`English-tutor hooks removed from ${settingsPath}\n`);
		process.exit(0);
	}, []);

	return null;
}
