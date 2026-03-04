import { useEffect, useRef } from "react";
import { signalState } from "../../../lib/session-signal.js";

export const description = "Signal active state (UserPromptSubmit hook)";

export default function Prompt() {
	const hasRun = useRef(false);

	useEffect(() => {
		if (hasRun.current) return;
		hasRun.current = true;
		signalState("active");
	}, []);

	return null;
}
