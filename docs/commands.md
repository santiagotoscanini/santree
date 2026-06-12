---
title: Commands
nav_order: 8
---

# Commands
{: .no_toc }

Reference for every santree subcommand. Most flow through the [Dashboard](dashboard.html), but each is also available as a standalone CLI invocation.

1. TOC
{:toc}

---

## Top-level

| Command | Description |
|---|---|
| `santree dashboard` | Interactive dashboard of all your assigned issues |
| `santree setup` | Guided wizard that configures editor, diff tool, Claude Code, and this repo (`--dry-run`, `--yes`) |
| `santree doctor` | Check system requirements and integrations |
| `santree update` | Update santree to the latest version |

## `santree worktree`

| Command | Description |
|---|---|
| `santree worktree create <branch>` | Create a new worktree from base branch |
| `santree worktree list` | List all worktrees with PR status and commits ahead |
| `santree worktree switch <branch>` | Switch to another worktree |
| `santree worktree remove <branch>` | Remove a worktree and its branch |
| `santree worktree clean` | Remove worktrees with merged/closed PRs (prompts for confirmation) |
| `santree worktree sync` | Sync current worktree with base branch |
| `santree worktree work` | Launch Claude AI to work on the current ticket |
| `santree worktree open` | Open workspace in your editor |
| `santree worktree setup` | Run the init script (`.santree/init.sh`) |
| `santree worktree commit` | Stage and commit changes |
| `santree worktree diff` | View branch-only diff (uses merge-base, like a GitHub PR) |

### `worktree create`

| Option | Description |
|---|---|
| `--base <branch>` | Base branch to create from (default: `main`/`master`) |
| `--work` | Launch Claude after creating |
| `--plan` | With `--work`, only create implementation plan |
| `--no-pull` | Skip pulling latest changes |
| `--tmux` | Open worktree in new tmux window |
| `--name <name>` | Custom tmux window name |

### `worktree sync`

| Option | Description |
|---|---|
| `--rebase` | Use rebase instead of merge |

### `worktree open`

| Option | Description |
|---|---|
| `--editor <cmd>` | Editor command to use (default: `code`). Also configurable via `SANTREE_EDITOR` |

### `worktree commit`

| Option | Description |
|---|---|
| `--fill` | Draft the commit message via Claude (uses the staged diff as context) |

### `worktree diff`

Shows a branch-only unified diff against the base branch's merge-base — same scope as a GitHub PR diff. Includes both committed and uncommitted work by default. Honors `SANTREE_DIFF_TOOL`.

| Option | Description |
|---|---|
| `--commits` | Show only committed changes (`merge-base..HEAD`) |
| `--staged` | Show only staged changes |
| `--unstaged` | Show only unstaged changes (working tree vs index) |
| `--base <branch>` | Override the base branch |

### `worktree work`

| Option | Description |
|---|---|
| `--plan` | Only create implementation plan |
| `--context-file <path>` | Inject extra context into the prompt from a file |

Automatically fetches issue data from the active tracker if authenticated; degrades gracefully if not.

### `worktree remove`

Removes the worktree and deletes the branch. Uses force mode by default.

### `worktree clean`

Shows worktrees whose PRs are merged or closed and prompts for confirmation before removing.

---

## `santree pr`

| Command | Description |
|---|---|
| `santree pr create` | Create a GitHub pull request |
| `santree pr open` | Open the current PR in the browser |
| `santree pr fix` | Apply PR review comments + CI failures with Claude |
| `santree pr review` | Self-review changes against the ticket with Claude |

### `pr create`

| Option | Description |
|---|---|
| `--fill` | Use Claude to fill the PR template before opening |

Auto-pushes, detects existing PRs, and uses the first commit message as the title. If a closed PR already exists for the branch, prompts before creating a new one.

---

## `santree issue` (tracker-agnostic)

| Command | Description |
|---|---|
| `santree issue switch <linear\|github>` | Pick the active tracker for this repo |
| `santree issue open` | Open the current branch's issue in the browser |

## `santree linear`

| Command | Description |
|---|---|
| `santree linear auth` | Authenticate with Linear (OAuth) |
| `santree linear switch` | Switch Linear workspace for this repo |

### `linear auth`

| Option | Description |
|---|---|
| `--status` | Show current auth status (org, token expiry) |
| `--test <id>` | Fetch a ticket by ID to verify integration works |
| `--logout` | Revoke tokens and log out |

## `santree github`

| Command | Description |
|---|---|
| `santree github auth` | Verify `gh auth status`, run `gh auth login` if needed, set tracker = github |

---

## `santree helpers`

| Command | Description |
|---|---|
| `santree helpers statusline` | Custom statusline for Claude Code |
| `santree helpers session-signal install` | Auto-install session-signal hooks in Claude Code |
| `santree helpers session-signal install --dry` | Print the hooks JSON without writing |
| `santree helpers session-signal {notification,stop,prompt,end}` | Internal — fired by Claude Code hooks |
| `santree helpers english-tutor install` | Install the English Tutor hooks (UserPromptSubmit + SessionStart) |
| `santree helpers english-tutor uninstall` | Remove the English Tutor hooks |
| `santree helpers squirrel` | Render the SDF squirrel loader animation standalone |

See [Integrations](integrations.html) for what the optional hooks do and why you might want them.
