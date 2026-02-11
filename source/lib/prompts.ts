import { fileURLToPath } from "url";
import { dirname, join } from "path";
import nunjucks from "nunjucks";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const promptsDir = join(__dirname, "..", "..", "prompts");
const promptsEnv = new nunjucks.Environment(
	new nunjucks.FileSystemLoader(promptsDir),
	{ autoescape: false },
);

/**
 * Render a nunjucks template from the prompts/ directory.
 * @param template - Template name without extension (e.g. "fill-pr")
 * @param context  - Variables to inject into the template
 */
export function renderPrompt(template: string, context: Record<string, string>): string {
	return promptsEnv.render(`${template}.njk`, context);
}
