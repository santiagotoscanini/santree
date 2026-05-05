/**
 * Dashboard theme detection — picks light vs dark based on the terminal's
 * actual background color (queried via OSC 11) or an explicit override from
 * SANTREE_THEME (`light` / `dark` / `auto`, default `auto`).
 *
 * Most foreground colors used in the dashboard are terminal-native names
 * (`green`, `red`, `yellow`, `cyan`, etc.) that the terminal renders in a
 * scheme-appropriate way, so the only piece of styling that needs to flip
 * is the selection background. That's the surface this module exposes.
 */

export type ThemeMode = "light" | "dark";

export interface DashboardTheme {
	mode: ThemeMode;
	selectionBg: string;
}

const DARK: DashboardTheme = { mode: "dark", selectionBg: "#1e3a5f" };
const LIGHT: DashboardTheme = { mode: "light", selectionBg: "#bfdbfe" };

export function getThemeForMode(mode: ThemeMode): DashboardTheme {
	return mode === "light" ? LIGHT : DARK;
}

/**
 * Honor SANTREE_THEME env override. Returns null when set to `auto` or
 * unset/invalid — caller should fall back to terminal detection.
 */
function envOverride(): ThemeMode | null {
	const raw = process.env["SANTREE_THEME"]?.toLowerCase().trim();
	if (raw === "light") return "light";
	if (raw === "dark") return "dark";
	return null;
}

/**
 * Compute relative luminance from sRGB components in the 0..1 range. Uses
 * Rec. 709 coefficients — good enough to decide light vs dark.
 */
function luminance(r: number, g: number, b: number): number {
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Parse an OSC 11 color response. Terminals reply with one of:
 *   \x1b]11;rgb:RRRR/GGGG/BBBB\x07
 *   \x1b]11;rgb:RR/GG/BB\x1b\\
 * Component widths can be 2 or 4 hex digits. Returns luminance in 0..1, or
 * null if the buffer doesn't contain a recognisable response.
 */
function parseOsc11(buf: string): number | null {
	const m = buf.match(/\x1b\]11;rgb:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)/);
	if (!m) return null;
	const conv = (hex: string) => parseInt(hex, 16) / (hex.length >= 4 ? 65535 : 255);
	const r = conv(m[1]!);
	const g = conv(m[2]!);
	const b = conv(m[3]!);
	return luminance(r, g, b);
}

/**
 * Query the terminal for its background color via OSC 11 and resolve the
 * detected ThemeMode within `timeoutMs`. Falls back to `dark` on timeout or
 * non-TTY stdin/stdout.
 *
 * The returned promise never rejects — failures resolve to `dark`.
 */
export function detectTerminalTheme(timeoutMs = 150): Promise<ThemeMode> {
	const override = envOverride();
	if (override) return Promise.resolve(override);

	return new Promise<ThemeMode>((resolve) => {
		if (!process.stdout.isTTY || !process.stdin.isTTY) {
			resolve("dark");
			return;
		}

		const stdin = process.stdin;
		const wasRaw = stdin.isRaw;
		let buf = "";
		let settled = false;

		const finish = (mode: ThemeMode) => {
			if (settled) return;
			settled = true;
			stdin.removeListener("data", onData);
			clearTimeout(timer);
			if (!wasRaw) {
				try {
					stdin.setRawMode(false);
				} catch {
					/* ignore */
				}
			}
			resolve(mode);
		};

		const onData = (chunk: Buffer) => {
			buf += chunk.toString("utf-8");
			const lum = parseOsc11(buf);
			if (lum !== null) finish(lum > 0.5 ? "light" : "dark");
		};

		try {
			if (!wasRaw) stdin.setRawMode(true);
		} catch {
			finish("dark");
			return;
		}
		stdin.on("data", onData);

		const timer = setTimeout(() => finish("dark"), timeoutMs);

		// Send the OSC 11 query. The terminal's response is consumed by onData
		// above and never reaches Ink's input handlers.
		try {
			process.stdout.write("\x1b]11;?\x07");
		} catch {
			finish("dark");
		}
	});
}
