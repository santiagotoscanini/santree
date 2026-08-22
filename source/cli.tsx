#!/usr/bin/env node
import Pastel from "pastel";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const app = new Pastel({
	importMeta: import.meta,
	name: "santree",
	version,
	description: "Git worktree manager with issue tracking and Claude integration",
});

await app.run();
