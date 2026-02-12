import * as http from "http";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { exec } from "child_process";
import { getRepoLinearOrg } from "./git.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface LinearTokens {
	access_token: string;
	refresh_token: string;
	expires_at: number;
	org_name: string;
}

export interface LinearComment {
	author: string;
	body: string;
	createdAt: string;
	children: LinearComment[];
}

export interface LinearIssue {
	identifier: string;
	title: string;
	description: string | null;
	status: string | null;
	priority: string | null;
	labels: string[];
	url: string;
	comments: LinearComment[];
}

type AuthStore = Record<string, LinearTokens>;

// ── Constants ──────────────────────────────────────────────────────────

const CLIENT_ID = "4be2738749371d7d3401061aabe2d11b";
const LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const LINEAR_REVOKE_URL = "https://api.linear.app/oauth/revoke";
const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const OAUTH_PORT = 8420;
const REDIRECT_URI = `http://localhost:${OAUTH_PORT}`;
const CONFIG_DIR = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
const AUTH_FILE_PATH = path.join(CONFIG_DIR, "santree", "auth.json");

// ── Auth Store ─────────────────────────────────────────────────────────

export function readAuthStore(): AuthStore {
	if (!fs.existsSync(AUTH_FILE_PATH)) return {};
	try {
		return JSON.parse(fs.readFileSync(AUTH_FILE_PATH, "utf-8"));
	} catch {
		return {};
	}
}

function writeAuthStore(store: AuthStore): void {
	const dir = path.dirname(AUTH_FILE_PATH);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.writeFileSync(AUTH_FILE_PATH, JSON.stringify(store, null, 2) + "\n", {
		mode: 0o600,
	});
}

// ── PKCE Helpers ───────────────────────────────────────────────────────

function generateCodeVerifier(): string {
	return crypto.randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
	return crypto.createHash("sha256").update(verifier).digest("base64url");
}

// ── OAuth Flow ─────────────────────────────────────────────────────────

/**
 * Run the full OAuth PKCE flow:
 * 1. Start a temp HTTP server on an ephemeral port
 * 2. Open browser to Linear authorize URL
 * 3. Wait for callback with auth code
 * 4. Exchange code for tokens
 * 5. Fetch org info
 * 6. Store tokens
 * Returns the org slug on success, null on failure.
 */
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
				// Ignore spurious requests (favicon, etc.)
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

			// Send success page immediately
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(
				"<html><body><h2>Authentication successful!</h2><p>You can close this tab.</p></body></html>",
			);

			try {
				// Exchange code for tokens
				const tokens = await exchangeCode(code, REDIRECT_URI, codeVerifier);

				// Fetch org info
				const orgInfo = await fetchViewerOrg(tokens.access_token);
				if (!orgInfo) {
					server.close();
					resolve(null);
					return;
				}

				// Store tokens
				const store = readAuthStore();
				store[orgInfo.urlKey] = {
					access_token: tokens.access_token,
					refresh_token: tokens.refresh_token,
					expires_at: tokens.expires_at,
					org_name: orgInfo.name,
				};
				writeAuthStore(store);

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

			// Open browser
			const openCmd =
				process.platform === "darwin"
					? "open"
					: process.platform === "win32"
						? "start"
						: "xdg-open";
			exec(`${openCmd} "${authUrl}"`);
		});

		// Timeout after 2 minutes
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
	const result = await graphqlQuery(
		`query { viewer { organization { urlKey name } } }`,
		{},
		accessToken,
	);

	if (!result?.viewer?.organization) return null;
	return result.viewer.organization;
}

// ── Token Management ───────────────────────────────────────────────────

function isTokenExpired(tokens: LinearTokens): boolean {
	// 5-minute buffer
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

		// Persist refreshed tokens
		const store = readAuthStore();
		store[orgSlug] = updated;
		writeAuthStore(store);

		return updated;
	} catch {
		return null;
	}
}

export async function revokeTokens(orgSlug: string): Promise<boolean> {
	const store = readAuthStore();
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
		// Best effort revocation
	}

	delete store[orgSlug];
	writeAuthStore(store);
	return true;
}

/**
 * Get valid tokens for an org, auto-refreshing if expired.
 * Returns null if no tokens found or refresh fails.
 */
export async function getValidTokens(orgSlug: string): Promise<LinearTokens | null> {
	const store = readAuthStore();
	const tokens = store[orgSlug];
	if (!tokens) return null;

	if (isTokenExpired(tokens)) {
		return refreshTokens(orgSlug, tokens);
	}

	return tokens;
}

// ── GraphQL ────────────────────────────────────────────────────────────

async function graphqlQuery(
	query: string,
	variables: Record<string, unknown>,
	accessToken: string,
): Promise<any> {
	const res = await fetch(LINEAR_GRAPHQL_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify({ query, variables }),
	});

	if (!res.ok) return null;

	const json = (await res.json()) as { data?: any; errors?: any[] };
	if (json.errors) {
		console.error("Linear GraphQL errors:", JSON.stringify(json.errors, null, 2));
	}
	return json.data ?? null;
}

const ISSUE_QUERY = `
query GetIssue($id: String!) {
  issue(id: $id) {
    identifier
    title
    description
    url
    state { name }
    priority
    labels { nodes { name } }
    comments {
      nodes {
        body
        createdAt
        parent { id }
        user { displayName }
        children {
          nodes {
            body
            createdAt
            user { displayName }
          }
        }
      }
    }
  }
}
`;

const PRIORITY_MAP: Record<number, string> = {
	0: "No priority",
	1: "Urgent",
	2: "High",
	3: "Medium",
	4: "Low",
};

async function fetchIssue(ticketId: string, accessToken: string): Promise<LinearIssue | null> {
	const data = await graphqlQuery(ISSUE_QUERY, { id: ticketId }, accessToken);
	if (!data?.issue) return null;

	const issue = data.issue;
	return {
		identifier: issue.identifier,
		title: issue.title,
		description: issue.description ?? null,
		status: issue.state?.name ?? null,
		priority: PRIORITY_MAP[issue.priority as number] ?? null,
		labels: (issue.labels?.nodes ?? []).map((l: { name: string }) => l.name),
		url: issue.url,
		comments: (issue.comments?.nodes ?? [])
			.filter((c: any) => !c.parent)
			.sort((a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
			.map((c: any) => ({
				author: c.user?.displayName ?? "Unknown",
				body: c.body,
				createdAt: c.createdAt,
				children: (c.children?.nodes ?? [])
					.sort(
						(a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
					)
					.map((r: any) => ({
						author: r.user?.displayName ?? "Unknown",
						body: r.body,
						createdAt: r.createdAt,
						children: [],
					})),
			})),
	};
}

// ── Image Handling ─────────────────────────────────────────────────────

function getTempImageDir(ticketId: string): string {
	return path.join(os.tmpdir(), `santree-images-${ticketId}`);
}

async function downloadImages(
	markdown: string,
	ticketId: string,
	accessToken: string,
): Promise<string> {
	const imageRegex = /!\[([^\]]*)\]\((https:\/\/uploads\.linear\.app[^)]+)\)/g;
	const matches = [...markdown.matchAll(imageRegex)];

	if (matches.length === 0) return markdown;

	const tempDir = getTempImageDir(ticketId);
	if (!fs.existsSync(tempDir)) {
		fs.mkdirSync(tempDir, { recursive: true });
	}

	let result = markdown;

	for (let i = 0; i < matches.length; i++) {
		const match = matches[i]!;
		const [fullMatch, altText, url] = match;

		try {
			const res = await fetch(url!, {
				headers: { Authorization: `Bearer ${accessToken}` },
			});

			if (!res.ok) continue;

			const buffer = Buffer.from(await res.arrayBuffer());
			const ext = path.extname(new URL(url!).pathname) || ".png";
			const filename = `image-${i}${ext}`;
			const filePath = path.join(tempDir, filename);
			fs.writeFileSync(filePath, buffer);

			result = result.replace(fullMatch!, `![${altText}](${filePath})`);
		} catch {
			// Keep original URL on failure
		}
	}

	return result;
}

export function cleanupImages(ticketId: string): void {
	const tempDir = getTempImageDir(ticketId);
	if (fs.existsSync(tempDir)) {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

// ── Auth Status ────────────────────────────────────────────────────────

export interface AuthStatus {
	authenticated: boolean;
	orgSlug?: string;
	orgName?: string;
	expiresAt?: number;
	repoLinked?: boolean;
}

/**
 * Get auth status for the current repo's Linear org (or any stored org).
 */
export function getAuthStatus(repoRoot: string | null): AuthStatus {
	const store = readAuthStore();
	const orgs = Object.keys(store);

	if (orgs.length === 0) {
		return { authenticated: false };
	}

	// Check repo-specific org first
	if (repoRoot) {
		const repoOrg = getRepoLinearOrg(repoRoot);
		if (repoOrg && store[repoOrg]) {
			const tokens = store[repoOrg]!;
			return {
				authenticated: true,
				orgSlug: repoOrg,
				orgName: tokens.org_name,
				expiresAt: tokens.expires_at,
				repoLinked: true,
			};
		}
	}

	// Fall back to first stored org
	const orgSlug = orgs[0]!;
	const tokens = store[orgSlug]!;
	return {
		authenticated: true,
		orgSlug,
		orgName: tokens.org_name,
		expiresAt: tokens.expires_at,
		repoLinked: false,
	};
}

// ── High-Level Entry Point ─────────────────────────────────────────────

/**
 * Fetch full ticket content for a given ticket ID.
 * Looks up the repo's Linear org, gets valid tokens, fetches issue, downloads images.
 * Returns null if not authenticated or fetch fails.
 */
export async function getTicketContent(
	ticketId: string,
	repoRoot: string,
): Promise<LinearIssue | null> {
	const orgSlug = getRepoLinearOrg(repoRoot);
	if (!orgSlug) return null;

	const tokens = await getValidTokens(orgSlug);
	if (!tokens) return null;

	const issue = await fetchIssue(ticketId, tokens.access_token);
	if (!issue) return null;

	// Download images from description
	if (issue.description) {
		issue.description = await downloadImages(issue.description, ticketId, tokens.access_token);
	}

	// Download images from comments and replies
	for (const comment of issue.comments) {
		if (comment.body) {
			comment.body = await downloadImages(comment.body, ticketId, tokens.access_token);
		}
		for (const child of comment.children) {
			if (child.body) {
				child.body = await downloadImages(child.body, ticketId, tokens.access_token);
			}
		}
	}

	return issue;
}
