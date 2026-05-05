import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as https from "https";
import { execSync } from "child_process";
import { createRequire } from "module";
import { resolveClaudeBinary } from "./ai.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json");

export const CURRENT_VERSION: string = pkg.version;

export const SANTREE_PACKAGE = "santree";
export const CLAUDE_CODE_PACKAGE = "@anthropic-ai/claude-code";

export type PackageManager = "npm" | "pnpm" | "yarn";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

interface CacheEntry {
	latest: string;
	fetchedAt: number;
}

type VersionCache = Record<string, CacheEntry>;

function configDir(): string {
	const xdg = process.env["XDG_CONFIG_HOME"];
	return path.join(xdg ?? path.join(os.homedir(), ".config"), "santree");
}

function cachePath(): string {
	return path.join(configDir(), "version-cache.json");
}

function isCacheEntry(v: unknown): v is CacheEntry {
	return (
		typeof v === "object" &&
		v !== null &&
		typeof (v as CacheEntry).latest === "string" &&
		typeof (v as CacheEntry).fetchedAt === "number"
	);
}

function readCache(): VersionCache {
	try {
		const raw = fs.readFileSync(cachePath(), "utf-8");
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		// Migrate old single-package shape `{ latest, fetchedAt }` → `{ santree: {...} }`
		if (isCacheEntry(parsed)) {
			return { [SANTREE_PACKAGE]: parsed };
		}
		const out: VersionCache = {};
		for (const [k, v] of Object.entries(parsed)) {
			if (isCacheEntry(v)) out[k] = v;
		}
		return out;
	} catch {
		return {};
	}
}

function writeCacheEntry(pkgName: string, latest: string): void {
	try {
		fs.mkdirSync(configDir(), { recursive: true });
		const cache = readCache();
		cache[pkgName] = { latest, fetchedAt: Date.now() };
		fs.writeFileSync(cachePath(), JSON.stringify(cache));
	} catch {
		// best-effort — version check is non-critical
	}
}

/**
 * Fetch the latest published version of an npm package from the registry.
 * Returns null on network/parse failure so callers can fall back to cache.
 * The npm registry accepts scoped names (`@scope/name`) verbatim in the path.
 */
export function fetchLatestVersionFor(pkgName: string, timeoutMs = 2000): Promise<string | null> {
	return new Promise((resolve) => {
		const req = https.get(
			`https://registry.npmjs.org/${pkgName}/latest`,
			{ headers: { Accept: "application/json" }, timeout: timeoutMs },
			(res) => {
				if (res.statusCode !== 200) {
					res.resume();
					resolve(null);
					return;
				}
				let body = "";
				res.setEncoding("utf-8");
				res.on("data", (chunk) => (body += chunk));
				res.on("end", () => {
					try {
						const data = JSON.parse(body);
						const v = typeof data?.version === "string" ? data.version : null;
						if (v) writeCacheEntry(pkgName, v);
						resolve(v);
					} catch {
						resolve(null);
					}
				});
			},
		);
		req.on("error", () => resolve(null));
		req.on("timeout", () => {
			req.destroy();
			resolve(null);
		});
	});
}

/**
 * Returns the cached latest version of a package when fresh, otherwise refetches.
 * Falls back to a stale cache if the network call fails.
 */
export async function getLatestVersionFor(
	pkgName: string,
	opts?: { force?: boolean },
): Promise<string | null> {
	const cache = readCache()[pkgName];
	if (!opts?.force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
		return cache.latest;
	}
	const fresh = await fetchLatestVersionFor(pkgName);
	return fresh ?? cache?.latest ?? null;
}

/** Read a cached latest version without hitting the network. */
export function getCachedLatestVersionFor(pkgName: string): string | null {
	return readCache()[pkgName]?.latest ?? null;
}

// ── Santree-specific shorthands (preserve existing call sites) ───────

export const fetchLatestVersion = (timeoutMs?: number) =>
	fetchLatestVersionFor(SANTREE_PACKAGE, timeoutMs);

export const getLatestVersion = (opts?: { force?: boolean }) =>
	getLatestVersionFor(SANTREE_PACKAGE, opts);

export const getCachedLatestVersion = (): string | null =>
	getCachedLatestVersionFor(SANTREE_PACKAGE);

/**
 * Compare semver-ish versions (major.minor.patch). Pre-release tags ignored.
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 */
export function compareVersions(a: string, b: string): number {
	const parse = (v: string): number[] => {
		const stripped = v.replace(/^v/, "").split("-")[0] ?? "0";
		return stripped.split(".").map((n) => parseInt(n, 10) || 0);
	};
	const pa = parse(a);
	const pb = parse(b);
	for (let i = 0; i < 3; i++) {
		const ai = pa[i] ?? 0;
		const bi = pb[i] ?? 0;
		if (ai !== bi) return ai < bi ? -1 : 1;
	}
	return 0;
}

export function isUpdateAvailable(current: string, latest: string): boolean {
	return compareVersions(current, latest) < 0;
}

/**
 * Read the locally installed Claude Code CLI version. Probes the resolved
 * Claude binary first (which prefers cmux's bundled copy when running inside
 * cmux — see lib/ai.ts:resolveClaudeBinary), then falls back to `claude` on
 * PATH and the Anthropic installer location.
 */
export function getInstalledClaudeVersion(): string | null {
	const resolved = resolveClaudeBinary();
	const candidates = [
		resolved,
		"claude",
		path.join(os.homedir(), ".claude", "local", "claude"),
	].filter((b): b is string => b !== null);
	const seen = new Set<string>();
	for (const bin of candidates) {
		if (seen.has(bin)) continue;
		seen.add(bin);
		try {
			const out = execSync(`${bin} --version`, {
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			}).trim();
			const v = out.split(/\s+/)[0];
			if (v) return v;
		} catch {
			// try next
		}
	}
	return null;
}

/**
 * Detect which package manager owns the running santree binary by inspecting
 * the resolved path of `process.argv[1]`. Falls back to npm when uncertain.
 *
 * Common install paths:
 *   pnpm  → ~/Library/pnpm/global/..., .../node_modules/.pnpm/santree@.../
 *   yarn  → ~/.config/yarn/global/..., ~/.yarn/...
 *   npm   → /usr/local/lib/node_modules/santree/..., /opt/homebrew/...
 */
export function detectPackageManager(): PackageManager {
	const candidates = [process.argv[1]].filter((p): p is string => Boolean(p));
	for (const candidate of candidates) {
		let resolved = candidate;
		try {
			resolved = fs.realpathSync(candidate);
		} catch {
			// keep original — still useful for path matching
		}
		const haystack = `${candidate}|${resolved}`;
		if (/[\\/](?:pnpm|\.pnpm)[\\/]/i.test(haystack)) return "pnpm";
		if (/[\\/]\.yarn[\\/]/i.test(haystack) || /[\\/]yarn[\\/]global[\\/]/i.test(haystack)) {
			return "yarn";
		}
	}
	return "npm";
}

export interface InstallCommand {
	cmd: string;
	args: string[];
	display: string;
}

export function getInstallCommandFor(pm: PackageManager, packageSpec: string): InstallCommand {
	switch (pm) {
		case "pnpm":
			return {
				cmd: "pnpm",
				args: ["add", "-g", packageSpec],
				display: `pnpm add -g ${packageSpec}`,
			};
		case "yarn":
			return {
				cmd: "yarn",
				args: ["global", "add", packageSpec],
				display: `yarn global add ${packageSpec}`,
			};
		case "npm":
		default:
			return {
				cmd: "npm",
				args: ["install", "-g", packageSpec],
				display: `npm install -g ${packageSpec}`,
			};
	}
}

/** Convenience: install the latest santree via the detected manager. */
export function getInstallCommand(pm: PackageManager): InstallCommand {
	return getInstallCommandFor(pm, "santree@latest");
}
