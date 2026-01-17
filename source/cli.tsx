#!/usr/bin/env node
import Pastel from "pastel";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const app = new Pastel({
	importMeta: import.meta,
	name: "santree",
	version,
	description: "Beautiful CLI for managing Git worktrees",
});

await app.run();
