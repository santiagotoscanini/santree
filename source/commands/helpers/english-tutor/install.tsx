import { useEffect, useRef } from "react";
import { z } from "zod";
import { getInstallSnippet, installHooks } from "../../../lib/english-tutor.js";

export const description = "Install English-tutor hooks into Claude Code settings";

export const options = z.object({
	dry: z.boolean().optional().describe("Print the hooks JSON without writing"),
});

export default function Install({ options: opts }: { options: z.infer<typeof options> }) {
	const hasRun = useRef(false);

	useEffect(() => {
		if (hasRun.current) return;
		hasRun.current = true;

		if (opts?.dry) {
			process.stdout.write(JSON.stringify(getInstallSnippet(), null, 2) + "\n");
			process.exit(0);
		}

		const { settingsPath, logPath } = installHooks();
		process.stdout.write(`English-tutor hooks installed in ${settingsPath}\n`);
		process.stdout.write(`Practice log: ${logPath}\n`);
		process.exit(0);
	}, []);

	return null;
}
