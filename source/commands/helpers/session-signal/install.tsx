import { useEffect, useRef } from "react";
import { z } from "zod";
import { getHooksJson, installHooks } from "../../../lib/session-signal.js";

export const description = "Install session-signal hooks into Claude Code settings";

export const options = z.object({
	dry: z.boolean().optional().describe("Print the hooks JSON without writing"),
});

export default function Install({ options: opts }: { options: z.infer<typeof options> }) {
	const hasRun = useRef(false);

	useEffect(() => {
		if (hasRun.current) return;
		hasRun.current = true;

		if (opts?.dry) {
			const snippet = { hooks: getHooksJson() };
			process.stdout.write(JSON.stringify(snippet, null, 2) + "\n");
			process.exit(0);
		}

		const settingsPath = installHooks();
		process.stdout.write(`Session-signal hooks installed in ${settingsPath}\n`);
		process.exit(0);
	}, []);

	return null;
}
