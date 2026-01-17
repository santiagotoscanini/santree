#!/usr/bin/env node
import Pastel from "pastel";

const app = new Pastel({
	importMeta: import.meta,
	name: "santree",
	version: "1.0.0",
	description: "Beautiful CLI for managing Git worktrees",
});

await app.run();
