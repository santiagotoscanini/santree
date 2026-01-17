<p align="center">
  <img src="assets/icon.png" alt="Santree" width="180" />
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
| `santree clean` | Remove worktrees with merged/closed PRs |

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
| Option | Description |
|--------|-------------|
| `--force` | Force removal even with uncommitted changes |

### clean
| Option | Description |
|--------|-------------|
| `--dry-run` | Show what would be removed |
| `--force` | Skip confirmation prompt |

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

---

## License

MIT
