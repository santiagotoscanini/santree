# Santree

A beautiful CLI for managing Git worktrees with Linear and GitHub integration.

Built with [React](https://react.dev/), [Ink](https://github.com/vadimdemedes/ink), and [Pastel](https://github.com/vadimdemedes/pastel).

## Installation

```bash
npm install -g santree
```

## Requirements

### Required

| Tool | Version | Purpose | Installation |
|------|---------|---------|--------------|
| **Node.js** | >= 20 | Runtime | [nodejs.org](https://nodejs.org/) or `brew install node` |
| **Git** | Any recent | Worktree operations | [git-scm.com](https://git-scm.com/) or `brew install git` |
| **GitHub CLI** | Any recent | PR creation, status, cleanup | `brew install gh` then `gh auth login` |
| **tmux** | Any recent | Create worktrees in new windows | `brew install tmux` |
| **Claude Code** | Any recent | AI coding assistant | `npm install -g @anthropic-ai/claude-code` |
| **Happy** | - | Claude CLI wrapper | Your custom wrapper around Claude Code |
| **Linear MCP** | - | Linear ticket context | See below |

### Setup

#### GitHub CLI

After installing, authenticate with GitHub:

```bash
brew install gh
gh auth login
```

#### Happy (Claude Integration)

The `santree work` command uses Happy to launch Claude with ticket context. Happy should be configured with the Linear MCP server to fetch ticket details.

#### Linear MCP Server

Add the Linear MCP server to your Claude configuration for ticket integration:

```bash
claude mcp add --transport http linear https://mcp.linear.app/mcp
```

This enables Claude to fetch Linear ticket details and comments when using `santree work`.

## Features

- **Worktree Management**: Create, switch, list, and remove Git worktrees
- **Linear Integration**: Extract ticket IDs from branch names for Claude AI workflows
- **GitHub Integration**: View PR status, create PRs, and clean up merged branches
- **Claude AI Integration**: Launch Claude with context about your current ticket
- **Beautiful UI**: Animated spinners, colored output, and box-styled layouts

## Commands

| Command | Description |
|---------|-------------|
| `santree list` | List all worktrees with status, PR info, and commits ahead |
| `santree create <branch>` | Create a new worktree from base branch |
| `santree switch <branch>` | Switch to another worktree |
| `santree remove <branch>` | Remove a worktree and its branch |
| `santree sync` | Sync current worktree with base branch (merge by default) |
| `santree setup` | Run the init script (`.santree/init.sh`) |
| `santree work` | Launch Claude to work on the current ticket |
| `santree clean` | Remove worktrees with merged/closed PRs |

## Options

### create
- `--base <branch>` - Base branch to create from (default: main/master)
- `--work` - Launch Claude after creating
- `--plan` - With --work, only create implementation plan
- `--no-pull` - Skip pulling latest changes

### sync
- `--rebase` - Use rebase instead of merge

### work
- `--plan` - Only create implementation plan
- `--review` - Review changes against ticket requirements
- `--fix-pr` - Fetch PR comments and fix them

### remove
- `--force` - Force removal even with uncommitted changes

### clean
- `--dry-run` - Show what would be removed without removing
- `--force` - Skip confirmation prompt

## Setup

### Init Script

Create `.santree/init.sh` in your repository root to run custom setup when creating worktrees:

```bash
#!/bin/bash
# Example: Copy .env, install dependencies, etc.
cp "$SANTREE_REPO_ROOT/.env" "$SANTREE_WORKTREE_PATH/.env"
npm install
```

Environment variables available:
- `SANTREE_WORKTREE_PATH` - Path to the new worktree
- `SANTREE_REPO_ROOT` - Path to the main repository

### Branch Naming

For Linear integration, use branch names with ticket IDs:

```
user/TEAM-123-feature-description
feature/PROJ-456-add-auth
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Lint
npm run lint

# Run locally
node dist/cli.js <command>
```

## CI/CD

This project uses GitHub Actions for continuous integration and deployment.

### Workflows

- **CI** (`ci.yml`): Runs on every push and PR to `main`. Builds the project and runs linting.
- **Release** (`release.yml`): Publishes to npm when a GitHub release is created.

### Setting Up npm Publishing

1. Generate an npm access token:
   - Go to [npmjs.com](https://www.npmjs.com/) → Account → Access Tokens
   - Create a new **Granular Access Token** with publish permissions

2. Add the token to GitHub:
   - Go to your repo → Settings → Secrets and variables → Actions
   - Create a new secret named `NPM_TOKEN` with your token

### Creating a Release

1. Update the version in `package.json`
2. Commit and push to `main`

The workflow automatically detects version changes, publishes to npm, creates a git tag, and generates a GitHub release.

## Shell Integration (Required)

Add this to your shell config (`.zshrc` or `.bashrc`) to enable directory switching after `create` and `switch` commands:

```bash
# For zsh
eval "$(santree shell-init zsh)"

# For bash
eval "$(santree shell-init bash)"
```

**Why is this required?** Child processes cannot change the parent shell's directory. The shell wrapper captures the output from `santree create` and `santree switch`, then performs the `cd` in your shell.
