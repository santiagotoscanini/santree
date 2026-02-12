import { fileURLToPath } from "url";
import { dirname, join } from "path";
import nunjucks from "nunjucks";
import type { LinearIssue } from "./linear.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const promptsDir = join(__dirname, "..", "..", "prompts");
const promptsEnv = new nunjucks.Environment(new nunjucks.FileSystemLoader(promptsDir), {
	autoescape: false,
});

promptsEnv.addFilter("date", (val: string) => {
	const d = new Date(val);
	return d.toLocaleDateString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
});

promptsEnv.addFilter("indent", (val: string, spaces: number) => {
	const prefix = " ".repeat(spaces);
	return val
		.split("\n")
		.map((line: string, i: number) => (i === 0 ? line : `> ${prefix}${line}`))
		.join("\n");
});

/**
 * Render a nunjucks template from the prompts/ directory.
 * @param template - Template name without extension (e.g. "fill-pr")
 * @param context  - Variables to inject into the template
 */
export function renderPrompt(
	template: string,
	context: Record<string, string | undefined>,
): string {
	return promptsEnv.render(`${template}.njk`, context);
}

/**
 * Render a LinearIssue into formatted markdown using the ticket template.
 */
export function renderTicket(issue: LinearIssue): string {
	return promptsEnv.render("ticket.njk", issue);
}
