import { useEffect, useRef } from "react";
import { signalState } from "../../../lib/session-signal.js";

export const description = "Signal idle state (Stop hook)";

export default function Stop() {
	const hasRun = useRef(false);

	useEffect(() => {
		if (hasRun.current) return;
		hasRun.current = true;
		signalState("idle");
	}, []);

	return null;
}
