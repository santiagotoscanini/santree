import { writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Conservative limit: 200KB leaves room for env vars within macOS 256KB ARG_MAX.
const ARG_MAX_SAFE = 200 * 1024;

/**
 * Build the prompt argument for an agent CLI.
 * If the prompt fits in ARG_MAX, returns it directly. Otherwise writes it to a
 * temp file and returns a short instruction to read it — works for any agent
 * that can `Read` a file (Claude, Codex), so it lives in the shared layer.
 */
export function promptArg(prompt: string): string {
	if (Buffer.byteLength(prompt) <= ARG_MAX_SAFE) {
		return prompt;
	}
	const filePath = join(tmpdir(), `santree-prompt-${Date.now()}.md`);
	writeFileSync(filePath, prompt);
	return `Read ${filePath} and follow the instructions inside.`;
}
