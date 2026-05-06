import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const CONFIG_DIR = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
const AUTH_FILE_PATH = path.join(CONFIG_DIR, "santree", "auth.json");

export interface LinearTokens {
	access_token: string;
	refresh_token: string;
	expires_at: number;
	org_name: string;
}

export interface AuthStoreV2 {
	version: 2;
	linear: Record<string, LinearTokens>;
	github: Record<string, never>;
}

function emptyStore(): AuthStoreV2 {
	return { version: 2, linear: {}, github: {} };
}

export function readAuthStore(): AuthStoreV2 {
	if (!fs.existsSync(AUTH_FILE_PATH)) return emptyStore();
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(AUTH_FILE_PATH, "utf-8"));
	} catch {
		return emptyStore();
	}
	if (raw && typeof raw === "object" && (raw as { version?: unknown }).version === 2) {
		const v2 = raw as Partial<AuthStoreV2>;
		return {
			version: 2,
			linear: v2.linear ?? {},
			github: (v2.github ?? {}) as Record<string, never>,
		};
	}
	const migrated = emptyStore();
	if (raw && typeof raw === "object") {
		for (const [k, v] of Object.entries(raw)) {
			if (v && typeof v === "object" && "access_token" in v) {
				migrated.linear[k] = v as LinearTokens;
			}
		}
	}
	writeAuthStore(migrated);
	return migrated;
}

export function writeAuthStore(store: AuthStoreV2): void {
	const dir = path.dirname(AUTH_FILE_PATH);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.writeFileSync(AUTH_FILE_PATH, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
}

export function readLinearAuthStore(): Record<string, LinearTokens> {
	return readAuthStore().linear;
}

export function writeLinearTokens(orgSlug: string, tokens: LinearTokens): void {
	const store = readAuthStore();
	store.linear[orgSlug] = tokens;
	writeAuthStore(store);
}

export function deleteLinearTokens(orgSlug: string): void {
	const store = readAuthStore();
	delete store.linear[orgSlug];
	writeAuthStore(store);
}
