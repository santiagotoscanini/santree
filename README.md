<p align="center">
  <img src="assets/icon.png" alt="Santree" width="200" />
</p>

<h1 align="center">Santree</h1>

<p align="center">
  <strong>A beautiful CLI for managing Git worktrees</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/santree"><img src="https://img.shields.io/npm/v/santree.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/santree"><img src="https://img.shields.io/npm/dm/santree.svg" alt="npm downloads"></a>
  <a href="https://github.com/stoscanini/santree/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/santree.svg" alt="license"></a>
</p>

<p align="center">
  Create, switch, and manage Git worktrees with ease.<br/>
  Integrates with GitHub PRs and Linear tickets via Claude AI.
</p>

---

## Installation

```bash
npm install -g santree
```

### Shell Setup (Required)

Add to your `.zshrc` or `.bashrc`:

```bash
eval "$(santree helpers shell-init zsh)"   # for zsh
eval "$(santree helpers shell-init bash)"  # for bash
```

This enables automatic directory switching after `worktree create` and `worktree switch` commands.

The shell integration also provides:
- `st` - Alias for `santree`
- `stw` - Alias for `santree worktree` (e.g., `stw list`, `stw create`)
- `stn` - Quick create worktree with `--work --plan --tmux` (prompts for branch name)

### Verify Setup

```bash
santree doctor
```

This checks that all required tools are installed and configured correctly.

---

## Quick Start

```bash
# Create a new worktree and switch to it
santree worktree create feature/TEAM-123-my-feature

# List all worktrees with PR status
santree worktree list

# Launch Claude AI to work on the current ticket
santree worktree work

# Switch to another worktree
santree worktree switch TEAM-456

# Create a PR
santree pr create

# Clean up worktrees with merged PRs
santree worktree clean
```

With the `stw` alias: `stw create`, `stw list`, `stw switch`, `stw work`, `stw clean`.

---

## Commands

### Worktree (`santree worktree`)

| Command | Description |
|---------|-------------|
| `santree worktree create <branch>` | Create a new worktree from base branch |
| `santree worktree list` | List all worktrees with PR status and commits ahead |
| `santree worktree switch <branch>` | Switch to another worktree |
| `santree worktree remove <branch>` | Remove a worktree and its branch |
| `santree worktree clean` | Remove worktrees with merged/closed PRs |
| `santree worktree sync` | Sync current worktree with base branch |
| `santree worktree work` | Launch Claude AI to work on the current ticket |
| `santree worktree open` | Open workspace in VSCode or Cursor |
| `santree worktree setup` | Run the init script (`.santree/init.sh`) |
| `santree worktree commit` | Stage and commit changes |

### Pull Requests (`santree pr`)

| Command | Description |
|---------|-------------|
| `santree pr create` | Create a GitHub pull request |
| `santree pr open` | Open the current PR in the browser |
| `santree pr fix` | Fix PR review comments with AI |
| `santree pr review` | Review changes against ticket with AI |

### Linear (`santree linear`)

| Command | Description |
|---------|-------------|
| `santree linear auth` | Authenticate with Linear (OAuth) |
| `santree linear switch` | Switch Linear workspace for this repo |
| `santree linear open` | Open the current Linear ticket in the browser |

### Helpers (`santree helpers`)

| Command | Description |
|---------|-------------|
| `santree helpers shell-init` | Output shell integration script |
| `santree helpers statusline` | Custom statusline for Claude Code |

### Top-level

| Command | Description |
|---------|-------------|
| `santree doctor` | Check system requirements and integrations |

---

## Features

### Worktree Management
Create isolated worktrees for each feature branch. No more stashing or committing WIP code just to switch tasks.

### GitHub Integration
See PR status directly in your worktree list. Clean up worktrees automatically when PRs are merged or closed.

### Linear Integration
Santree fetches Linear ticket data (title, description, comments, images) and injects it into prompts when running `santree worktree work`. See [Linear Integration](#linear-integration-1) for setup.

### Claude AI Integration
Launch Claude with full context about your current ticket. Supports different modes:
- `santree worktree work` - Implement the ticket
- `santree worktree work --plan` - Create an implementation plan only
- `santree pr review` - Review changes against ticket requirements
- `santree pr fix` - Address PR review comments

### Init Scripts
Run custom setup scripts when creating worktrees. Perfect for copying `.env` files, installing dependencies, or any project-specific setup.

---

## Configuration

### Init Script

Create `.santree/init.sh` in your repository root:

```bash
#!/bin/bash
cp "$SANTREE_REPO_ROOT/.env" "$SANTREE_WORKTREE_PATH/.env"
npm install
```

### Branch Naming

For Linear integration, use branch names with ticket IDs:

```
user/TEAM-123-feature-description
feature/PROJ-456-add-auth
```

### Linear Integration

Santree fetches Linear ticket data (title, description, comments, images) and injects it into prompts when running `santree worktree work`.

```bash
# Authenticate with Linear (opens browser for OAuth)
santree linear auth

# Check auth status
santree linear auth --status

# Verify a ticket is fetched correctly
santree linear auth --test TEAM-123

# Log out
santree linear auth --logout
```

On first run, `santree linear auth` opens your browser to authorize the app with your Linear workspace. Tokens are stored in `$XDG_CONFIG_HOME/santree/auth.json` (defaults to `~/.config/santree/auth.json`) and auto-refresh transparently.

If you have multiple workspaces authenticated, running `santree linear auth` in a new repo will let you pick which one to link. Images from tickets are downloaded to a temp directory and cleaned up after Claude exits.

### Claude Code Statusline (Optional)

Santree provides a custom statusline for Claude Code showing git info, model, context usage, and cost.

Add to `~/.claude/settings.json`:
```json
{
  "statusLine": {
    "type": "command",
    "command": "santree helpers statusline"
  }
}
```

The statusline displays: `repo | branch | S: staged | U: unstaged | A: untracked | Model | Context% | $Cost`

---

## Command Options

### worktree create
| Option | Description |
|--------|-------------|
| `--base <branch>` | Base branch to create from (default: main/master) |
| `--work` | Launch Claude after creating |
| `--plan` | With --work, only create implementation plan |
| `--no-pull` | Skip pulling latest changes |
| `--tmux` | Open worktree in new tmux window |
| `--name <name>` | Custom tmux window name |

### worktree sync
| Option | Description |
|--------|-------------|
| `--rebase` | Use rebase instead of merge |

### worktree remove
Removes the worktree and deletes the branch. Uses force mode by default (removes even with uncommitted changes).

### worktree clean
Shows worktrees with merged/closed PRs and prompts for confirmation before removing.

### worktree open
| Option | Description |
|--------|-------------|
| `--editor <cmd>` | Editor command to use (default: `code`). Also configurable via `SANTREE_EDITOR` env var |

### worktree work
| Option | Description |
|--------|-------------|
| `--plan` | Only create implementation plan |

Automatically fetches Linear ticket data if authenticated. Degrades gracefully if not.

### pr create
| Option | Description |
|--------|-------------|
| `--fill` | Use AI to fill the PR template before opening |

Automatically pushes, detects existing PRs, and uses the first commit message as the title. If a closed PR exists for the branch, prompts before creating a new one.

### linear auth
| Option | Description |
|--------|-------------|
| `--status` | Show current auth status (org, token expiry) |
| `--test <id>` | Fetch a ticket by ID to verify integration works |
| `--logout` | Revoke tokens and log out |

---

## Requirements

| Tool | Purpose |
|------|---------|
| Node.js >= 20 | Runtime |
| Git | Worktree operations |
| GitHub CLI (`gh`) | PR integration |
| tmux | Optional: new window support |
| VSCode (`code`) or Cursor (`cursor`) | Optional: workspace editor |

---

## Development

### Setup

```bash
git clone https://github.com/santiagotoscanini/santree.git
cd santree
npm install
```

### Build & Run

```bash
# Compile TypeScript
npm run build

# Run the local build
node dist/cli.js <command>

# Watch mode (recompiles on save)
npm run dev
```

During development, use `node dist/cli.js` instead of `santree` to run the local version:

```bash
node dist/cli.js worktree list
node dist/cli.js worktree work
node dist/cli.js linear auth --test TEAM-123
```

### Link globally (optional)

To use `santree` as a global command pointing to your local build:

```bash
npm link
```

Now `santree` runs your local `dist/cli.js`. Unlink with `npm unlink -g santree`.

### Code Quality

```bash
npm run lint          # Check for lint + formatting errors
npm run lint:fix      # Auto-fix lint + formatting errors
npm run format        # Format all source files with Prettier
```

A pre-commit hook (via husky + lint-staged) automatically runs ESLint and Prettier on staged files.

### Project Structure

```
source/
├── cli.tsx              # Entry point (Pastel app runner)
├── lib/
│   ├── ai.ts            # Shared AI logic (context, prompt, launch)
│   ├── git.ts           # Git helpers (worktrees, branches, metadata)
│   ├── github.ts        # GitHub CLI wrapper (PR info, auth, push)
│   ├── linear.ts        # Linear GraphQL API client (OAuth, tickets, images)
│   ├── exec.ts          # Shell command helpers
│   └── prompts.ts       # Nunjucks template renderer
└── commands/            # One React (Ink) component per CLI command
    ├── doctor.tsx        # Top-level: system check
    ├── worktree/         # Worktree management (create, list, switch, etc.)
    ├── pr/               # PR lifecycle (create, open, fix, review)
    ├── linear/           # Linear integration (auth, open)
    └── helpers/          # Shell init, statusline
prompts/                 # Nunjucks templates: implement, plan, review, fix-pr, fill-pr, ticket
shell/                   # Shell integration templates: init.zsh.njk, init.bash.njk
```
