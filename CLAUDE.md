# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Santree is a CLI application for managing Git worktrees with integrated AI assistance. It streamlines creating isolated development environments for feature branches, integrating with GitHub PRs and Linear tickets via Claude AI.

## Build Commands

```bash
npm run build          # Compile TypeScript to dist/
npm run dev            # Watch mode compilation
npm start              # Run CLI: node dist/cli.js
npm run lint           # Run ESLint
```

## Architecture

**CLI Framework**: Pastel + Ink (React-based terminal UI)

```
source/
├── cli.tsx              # Entry point, command routing via Pastel
├── lib/
│   ├── git.ts           # Git operations (worktrees, branches, commits)
│   └── github.ts        # GitHub CLI wrapper (PR info, auth)
└── commands/            # React components, one per command
prompts/                 # Nunjucks templates for Claude prompts
shell/                   # Zsh/Bash integration scripts (init.zsh.njk, init.bash.njk)
```

**Command Structure**: Each command exports:
- `description` - Help text
- `options` - Zod schema for CLI flags
- `args` - Zod schema for positional arguments
- Default export - React component using hooks (useState, useEffect, useInput)

**Shell Integration Pattern**: Commands output special markers (`SANTREE_CD:path`, `SANTREE_WORK:mode`) that the parent shell wrapper captures to enable directory switching and chained commands.

**Metadata Storage**: Worktrees stored in `.santree/worktrees/{branch}/` with metadata in `__santree_metadata.json` (branch_name, base_branch, created_at).

## Key Patterns

- **Branch naming**: `{prefix}/{TICKET-ID}-description` (e.g., `feature/TEAM-123-auth`)
- **Worktree detection**: Compare `git rev-parse --git-dir` vs `--git-common-dir`
- **Async operations**: Heavy use of Promise.all() for parallel GitHub/Linear queries
- **Error resilience**: Commands degrade gracefully when integrations unavailable
- **Template-driven prompts**: Nunjucks templates in `prompts/` for Claude context

## External Dependencies

Required: Node.js >= 20, Git, GitHub CLI (`gh`), tmux, Claude CLI (`claude`), happy-coder CLI (`happy`)
Optional: Linear MCP for ticket integration
