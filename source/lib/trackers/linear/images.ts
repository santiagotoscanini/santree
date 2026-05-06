import * as fs from "fs";
import * as os from "os";
import * as path from "path";

function getTempImageDir(ticketId: string): string {
	return path.join(os.tmpdir(), `santree-images-${ticketId}`);
}

export async function rewriteLinearImages(
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
			// keep original URL on failure
		}
	}
	return result;
}

export function cleanupLinearImages(ticketId: string): void {
	const tempDir = getTempImageDir(ticketId);
	if (fs.existsSync(tempDir)) {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}
