import { execFileSync } from "child_process";

/**
 * Open a URL in the platform's default browser.
 *   macOS → `open <url>`
 *   else  → `xdg-open <url>`
 *
 * Returns true on apparent success, false on failure. Callers decide how to
 * surface failures (e.g. a dashboard action message). Uses execFileSync (array
 * args, no shell) so a `"` in a tracker/PR-supplied URL can't break or inject;
 * `stdio: "ignore"` keeps output out of the dashboard's alt screen.
 */
export function openUrl(url: string): boolean {
	try {
		const cmd = process.platform === "darwin" ? "open" : "xdg-open";
		execFileSync(cmd, [url], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}
