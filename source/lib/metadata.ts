import * as fs from "fs";
import * as path from "path";

export function getSantreeDir(repoRoot: string): string {
	return path.join(repoRoot, ".santree");
}

function getMetadataFilePath(repoRoot: string): string {
	return path.join(getSantreeDir(repoRoot), "metadata.json");
}

export function readAllMetadata(repoRoot: string): Record<string, any> {
	const filePath = getMetadataFilePath(repoRoot);
	if (!fs.existsSync(filePath)) return {};
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch {
		return {};
	}
}

export function writeAllMetadata(repoRoot: string, data: Record<string, any>): void {
	const filePath = getMetadataFilePath(repoRoot);
	const dir = path.dirname(filePath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}
