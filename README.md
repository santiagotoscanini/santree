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
eval "$(santree shell-init zsh)"   # for zsh
eval "$(santree shell-init bash)"  # for bash
```

This enables automatic directory switching after `create` and `switch` commands.

The shell integration also provides:
- `st` - Alias for `santree`
- `stw` - Quick create worktree with `--work --plan --tmux` (prompts for branch name)

### Verify Setup

```bash
santree doctor
```

This checks that all required tools are installed and configured correctly.

---

## Quick Start

```bash
# Create a new worktree and switch to it
santree create feature/my-new-feature

# List all worktrees with PR status
santree list

# Switch to another worktree
santree switch main

# Clean up worktrees with merged PRs
santree clean
```

---

## Commands

| Command | Description |
|---------|-------------|
| `santree list` | List all worktrees with PR status and commits ahead |
| `santree create <branch>` | Create a new worktree from base branch |
| `santree switch <branch>` | Switch to another worktree |
| `santree remove <branch>` | Remove a worktree and its branch |
| `santree sync` | Sync current worktree with base branch |
| `santree setup` | Run the init script (`.santree/init.sh`) |
| `santree work` | Launch Claude AI to work on the current ticket |
| `santree pr` | Create a GitHub pull request (opens in browser) |
| `santree clean` | Remove worktrees with merged/closed PRs |
| `santree doctor` | Check system requirements and integrations |
| `santree editor` | Open workspace file in VSCode or Cursor |
| `santree statusline` | Statusline wrapper for Claude Code |

---

## Features

### Worktree Management
Create isolated worktrees for each feature branch. No more stashing or committing WIP code just to switch tasks.

### GitHub Integration
See PR status directly in your worktree list. Clean up worktrees automatically when PRs are merged or closed.

### Claude AI Integration
Launch Claude with full context about your current ticket using `santree work`. Supports different modes:
- `--plan` - Create an implementation plan only
- `--review` - Review changes against ticket requirements
- `--fix-pr` - Address PR review comments

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

### Linear MCP (for Claude integration)

```bash
claude mcp add --transport http linear https://mcp.linear.app/mcp
```

### Claude Code Statusline (Optional)

Santree provides a custom statusline for Claude Code showing git info, model, context usage, and cost.

Add to `~/.claude/settings.json`:
```json
{
  "statusLine": {
    "type": "command",
    "command": "santree statusline"
  }
}
```

The statusline displays: `repo | branch | S: staged | U: unstaged | A: untracked | Model | Context% | $Cost`

---

## Command Options

### create
| Option | Description |
|--------|-------------|
| `--base <branch>` | Base branch to create from (default: main/master) |
| `--work` | Launch Claude after creating |
| `--plan` | With --work, only create implementation plan |
| `--no-pull` | Skip pulling latest changes |
| `--tmux` | Open worktree in new tmux window |

### sync
| Option | Description |
|--------|-------------|
| `--rebase` | Use rebase instead of merge |

### remove
Removes the worktree and deletes the branch. Uses force mode by default (removes even with uncommitted changes).

### clean
Shows worktrees with merged/closed PRs and prompts for confirmation before removing.

### editor
| Option | Description |
|--------|-------------|
| `--editor <cmd>` | Editor command to use (default: `code`). Also configurable via `SANTREE_EDITOR` env var |

### pr
| Option | Description |
|--------|-------------|
| `--fill` | Use AI to fill the PR template before opening |

Automatically pushes, detects existing PRs, and uses the first commit message as the title. If a closed PR exists for the branch, prompts before creating a new one.

### work
| Option | Description |
|--------|-------------|
| `--plan` | Only create implementation plan |
| `--review` | Review changes against requirements |
| `--fix-pr` | Fetch and fix PR comments |

---

## Requirements

| Tool | Purpose |
|------|---------|
| Node.js >= 20 | Runtime |
| Git | Worktree operations |
| GitHub CLI (`gh`) | PR integration |
| tmux | Optional: new window support |
| VSCode (`code`) or Cursor (`cursor`) | Optional: workspace editor |
