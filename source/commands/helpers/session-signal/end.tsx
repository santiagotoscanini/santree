import { useEffect, useRef } from "react";
import { signalState } from "../../../lib/session-signal.js";

export const description = "Signal exited state (SessionEnd hook)";

export default function End() {
	const hasRun = useRef(false);

	useEffect(() => {
		if (hasRun.current) return;
		hasRun.current = true;
		signalState("exited");
	}, []);

	return null;
}
