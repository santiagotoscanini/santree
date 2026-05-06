import * as http from "http";
import * as crypto from "crypto";
import { exec } from "child_process";
import { readAllMetadata, writeAllMetadata } from "../../metadata.js";
import {
	readLinearAuthStore,
	writeLinearTokens,
	deleteLinearTokens,
	type LinearTokens,
} from "../auth-store.js";

export type { LinearTokens } from "../auth-store.js";

const CLIENT_ID = "4be2738749371d7d3401061aabe2d11b";
const LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const LINEAR_REVOKE_URL = "https://api.linear.app/oauth/revoke";
const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const OAUTH_PORT = 8420;
const REDIRECT_URI = `http://localhost:${OAUTH_PORT}`;

function generateCodeVerifier(): string {
	return crypto.randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
	return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export async function startOAuthFlow(): Promise<{
	orgSlug: string;
	orgName: string;
} | null> {
	const codeVerifier = generateCodeVerifier();
	const codeChallenge = generateCodeChallenge(codeVerifier);
	const state = crypto.randomBytes(16).toString("hex");

	return new Promise((resolve) => {
		let handled = false;
		const server = http.createServer(async (req, res) => {
			const url = new URL(req.url!, `http://localhost`);
			const code = url.searchParams.get("code");
			const returnedState = url.searchParams.get("state");

			if (!code || returnedState !== state) {
				res.writeHead(404);
				res.end();
				return;
			}

			if (handled) {
				res.writeHead(200);
				res.end();
				return;
			}
			handled = true;

			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(
				"<html><body><h2>Authentication successful!</h2><p>You can close this tab.</p></body></html>",
			);

			try {
				const tokens = await exchangeCode(code, REDIRECT_URI, codeVerifier);
				const orgInfo = await fetchViewerOrg(tokens.access_token);
				if (!orgInfo) {
					server.close();
					resolve(null);
					return;
				}
				writeLinearTokens(orgInfo.urlKey, {
					access_token: tokens.access_token,
					refresh_token: tokens.refresh_token,
					expires_at: tokens.expires_at,
					org_name: orgInfo.name,
				});
				server.close();
				resolve({ orgSlug: orgInfo.urlKey, orgName: orgInfo.name });
			} catch {
				server.close();
				resolve(null);
			}
		});

		server.listen(OAUTH_PORT, () => {
			const params = new URLSearchParams({
				client_id: CLIENT_ID,
				redirect_uri: REDIRECT_URI,
				response_type: "code",
				scope: "read",
				state,
				code_challenge: codeChallenge,
				code_challenge_method: "S256",
			});

			const authUrl = `${LINEAR_AUTHORIZE_URL}?${params.toString()}`;
			const openCmd =
				process.platform === "darwin"
					? "open"
					: process.platform === "win32"
						? "start"
						: "xdg-open";
			exec(`${openCmd} "${authUrl}"`, (err) => {
				if (err) {
					console.error(
						`\nCouldn't open browser automatically. Open this URL manually:\n${authUrl}\n`,
					);
				}
			});
		});

		setTimeout(() => {
			server.close();
			resolve(null);
		}, 120_000);
	});
}

async function exchangeCode(
	code: string,
	redirectUri: string,
	codeVerifier: string,
): Promise<{ access_token: string; refresh_token: string; expires_at: number }> {
	const res = await fetch(LINEAR_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			redirect_uri: redirectUri,
			code_verifier: codeVerifier,
		}),
	});

	if (!res.ok) {
		throw new Error(`Token exchange failed: ${res.status}`);
	}

	const data = (await res.json()) as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
	};

	return {
		access_token: data.access_token,
		refresh_token: data.refresh_token,
		expires_at: Date.now() + data.expires_in * 1000,
	};
}

async function fetchViewerOrg(
	accessToken: string,
): Promise<{ urlKey: string; name: string } | null> {
	const res = await fetch(LINEAR_GRAPHQL_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify({
			query: `query { viewer { organization { urlKey name } } }`,
		}),
	});
	if (!res.ok) return null;
	const json = (await res.json()) as { data?: { viewer?: { organization?: unknown } } };
	const org = json.data?.viewer?.organization as { urlKey: string; name: string } | undefined;
	return org ?? null;
}

function isTokenExpired(tokens: LinearTokens): boolean {
	return Date.now() >= tokens.expires_at - 5 * 60 * 1000;
}

async function refreshTokens(orgSlug: string, tokens: LinearTokens): Promise<LinearTokens | null> {
	try {
		const res = await fetch(LINEAR_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				client_id: CLIENT_ID,
				refresh_token: tokens.refresh_token,
			}),
		});

		if (!res.ok) return null;

		const data = (await res.json()) as {
			access_token: string;
			refresh_token: string;
			expires_in: number;
		};

		const updated: LinearTokens = {
			access_token: data.access_token,
			refresh_token: data.refresh_token,
			expires_at: Date.now() + data.expires_in * 1000,
			org_name: tokens.org_name,
		};

		writeLinearTokens(orgSlug, updated);
		return updated;
	} catch {
		return null;
	}
}

export async function revokeTokens(orgSlug: string): Promise<boolean> {
	const store = readLinearAuthStore();
	const tokens = store[orgSlug];
	if (!tokens) return false;

	try {
		await fetch(LINEAR_REVOKE_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: CLIENT_ID,
				token: tokens.access_token,
			}),
		});
	} catch {
		// best effort
	}

	deleteLinearTokens(orgSlug);
	return true;
}

export async function getValidTokens(orgSlug: string): Promise<LinearTokens | null> {
	const store = readLinearAuthStore();
	const tokens = store[orgSlug];
	if (!tokens) return null;
	if (isTokenExpired(tokens)) {
		return refreshTokens(orgSlug, tokens);
	}
	return tokens;
}

export function getRepoLinearOrg(repoRoot: string): string | null {
	const all = readAllMetadata(repoRoot);
	const linear = all._linear as { org?: string } | undefined;
	return linear?.org ?? null;
}

export function setRepoLinearOrg(repoRoot: string, orgSlug: string): void {
	const all = readAllMetadata(repoRoot);
	all._linear = { org: orgSlug };
	writeAllMetadata(repoRoot, all);
}

export function removeRepoLinearOrg(repoRoot: string): void {
	const all = readAllMetadata(repoRoot);
	delete all._linear;
	writeAllMetadata(repoRoot, all);
}
