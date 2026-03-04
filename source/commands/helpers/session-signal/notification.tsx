import { useEffect, useRef } from "react";
import { signalState } from "../../../lib/session-signal.js";

export const description = "Signal waiting state (Notification hook)";

export default function Notification() {
	const hasRun = useRef(false);

	useEffect(() => {
		if (hasRun.current) return;
		hasRun.current = true;
		signalState("waiting");
	}, []);

	return null;
}
