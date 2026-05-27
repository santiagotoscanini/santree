// Minimal, hand-rolled frontmatter parse/serialize.
//
// The project intentionally has no YAML dependency and adding one
// (gray-matter / yaml) is out of scope. The Local tracker only ever stores
// scalars (string, number) and a single string[] (`labels`), so a tiny
// purpose-built reader/writer is enough. It is deliberately defensive:
// unknown keys are preserved as raw strings, malformed lines are skipped,
// and a missing/garbled frontmatter block yields an empty record rather
// than throwing (matches the "degrade gracefully" pattern in metadata.ts).

export type FrontmatterValue = string | number | string[];

export interface ParsedFile {
	data: Record<string, FrontmatterValue>;
	body: string;
}

const FENCE = "---";

function parseScalar(raw: string): string | number {
	const trimmed = raw.trim();
	// Strip matching surrounding quotes if present.
	const unquoted =
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
			? trimmed.slice(1, -1)
			: trimmed;
	// Only treat as a number when the whole token is numeric — issue IDs
	// like "LOCAL-1" must stay strings.
	if (unquoted !== "" && /^-?\d+(\.\d+)?$/.test(unquoted)) {
		return Number(unquoted);
	}
	return unquoted;
}

function parseList(raw: string): string[] {
	const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
	if (inner.trim() === "") return [];
	return inner
		.split(",")
		.map((s) => {
			const t = s.trim();
			return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))
				? t.slice(1, -1)
				: t;
		})
		.filter((s) => s.length > 0);
}

/** Parse a Markdown document with an optional leading `---` frontmatter
 * block. Returns `{ data, body }`; `data` is `{}` when there is no valid
 * frontmatter. */
export function parseFrontmatter(content: string): ParsedFile {
	const normalized = content.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");

	if (lines[0]?.trim() !== FENCE) {
		return { data: {}, body: normalized };
	}

	const data: Record<string, FrontmatterValue> = {};
	let i = 1;
	for (; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (line.trim() === FENCE) {
			i++;
			break;
		}
		const colon = line.indexOf(":");
		if (colon === -1) continue; // skip malformed line
		const key = line.slice(0, colon).trim();
		if (!key) continue;
		const rawValue = line.slice(colon + 1).trim();
		data[key] = rawValue.startsWith("[") ? parseList(rawValue) : parseScalar(rawValue);
	}

	// Body is everything after the closing fence; drop a single leading
	// blank line that separates fence from content.
	const bodyLines = lines.slice(i);
	if (bodyLines[0] === "") bodyLines.shift();
	return { data, body: bodyLines.join("\n").replace(/\s+$/, "") };
}

function serializeValue(value: FrontmatterValue): string {
	if (Array.isArray(value)) {
		return `[${value.map((v) => v).join(", ")}]`;
	}
	if (typeof value === "number") return String(value);
	// Quote strings that contain characters which would break the simple
	// `key: value` line parser or look like a list.
	if (/^[\[\]]|[:#]|^\s|\s$/.test(value) || value === "") {
		return JSON.stringify(value);
	}
	return value;
}

/** Serialize `{ data, body }` back into a `---` frontmatter Markdown file.
 * Key order is preserved as inserted by the caller. */
export function serializeFrontmatter(data: Record<string, FrontmatterValue>, body: string): string {
	const head = Object.entries(data).map(([k, v]) => `${k}: ${serializeValue(v)}`);
	const trimmedBody = body.replace(/\s+$/, "");
	return `${FENCE}\n${head.join("\n")}\n${FENCE}\n\n${trimmedBody}\n`;
}
