import { useEffect, useRef } from "react";
import { resolveAIContext, fetchAndRenderFixContext } from "../../lib/ai.js";
import { santreeSelfArgv } from "../../lib/setup/apply.js";

export const description = "Print the fix-loop iteration brief (state + the exact actions to take)";

/**
 * Read-only command the auto-fix `/loop` runs each iteration to refresh state.
 * No Ink UI — it writes the rendered brief straight to stdout and exits (same
 * pattern as the statusline helper) so the agent can read it cleanly.
 */
export default function PRContext() {
	const hasRun = useRef(false);

	useEffect(() => {
		if (hasRun.current) return;
		hasRun.current = true;

		(async () => {
			const result = await resolveAIContext();
			if (!result.ok) {
				process.stderr.write(result.error + "\n");
				process.exit(1);
			}
			// Embed the absolute santree invocation so the brief's own `--signal` /
			// resolve commands work in a shell that may not have santree on PATH.
			const self = santreeSelfArgv([]);
			const santreeCmd = [self.cmd, ...self.args].join(" ");
			const md = await fetchAndRenderFixContext(result.context.branch, santreeCmd);
			if (!md) {
				process.stderr.write(`No pull request found for branch '${result.context.branch}'\n`);
				process.exit(1);
			}
			process.stdout.write(md.trimEnd() + "\n");
			process.exit(0);
		})();
	}, []);

	return null;
}
