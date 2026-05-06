import { useEffect, useRef } from "react";
import { renderPrompt } from "../../../lib/prompts.js";
import { getLogPath } from "../../../lib/english-tutor.js";

export const description = "English-tutor instruction (UserPromptSubmit hook)";

export default function Prompt() {
	const hasRun = useRef(false);

	useEffect(() => {
		if (hasRun.current) return;
		hasRun.current = true;
		const text = renderPrompt("english-tutor-prompt", { logPath: getLogPath() });
		process.stdout.write(text);
		process.exit(0);
	}, []);

	return null;
}
