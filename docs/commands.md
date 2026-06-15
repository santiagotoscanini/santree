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
| `santree config` | Live settings panel: system requirements, global editor & Claude Code integration, and this repo's tracker / gitignore / scaffold (`--check`, `--yes`, `--dry-run`) |
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
| `--window` | Open the worktree in a new multiplexer window/workspace (tmux/cmux) |
| `--tmux` | Deprecated alias for `--window` |
| `--name <name>` | Custom window/workspace name |

### `worktree sync`

| Option | Description |
|---|---|
| `--rebase` | Use rebase instead of merge |

### `worktree open`

| Option | Description |
|---|---|
| `--editor <cmd>` | Editor command to use. Defaults to your configured editor (`santree config` → Global → Default editor; `code` if unset). `SANTREE_EDITOR` overrides the configured value; `--editor` overrides both for this invocation. |

### `worktree commit`

| Option | Description |
|---|---|
| `--fill` | Draft the commit message via Claude (uses the staged diff as context) |

### `worktree diff`

Shows a branch-only unified diff against the base branch's merge-base — same scope as a GitHub PR diff. Includes both committed and uncommitted work by default. Renders through your configured diff tool (`santree config` → Global → Diff tool; git's default pager if unset); `SANTREE_DIFF_TOOL` overrides it for a single invocation.

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
| `santree pr fix` | Self-driving loop: merge conflicts, fix CI, apply 👍-approved review comments |
| `santree pr context` | Print the fix-loop iteration brief (state + the exact actions to take) |
| `santree pr review` | Self-review changes against the ticket with Claude |

### `pr create`

| Option | Description |
|---|---|
| `--fill` | Use Claude to fill the PR template before opening |

Auto-pushes, detects existing PRs, and uses the first commit message as the title. If a closed PR already exists for the branch, prompts before creating a new one.

### `pr fix`

`pr fix` is a **single self-driving fix loop** — one flow for both CI and review comments. Every 5 minutes it re-pulls the PR state, then each iteration it:

- merges the base branch in if the PR is conflicted,
- fixes the *fixable* CI failures (tests, types, lint, format, coverage),
- applies your **approved review comments** (see below),
- pushes,

and stops when CI is green, no approved comments remain, and only manual/unclear failures are left. It launches a Claude Code `/loop` that drives itself — best started from the [dashboard](dashboard.html)'s `f` action, which opens it as a `fix-loop` tab in the ticket's workspace (next to its `work` tab on cmux; a separate window on tmux) and shows a `⟳` badge on the ticket while it runs.

A failing check is treated as **fixable** when its name/workflow looks like a test, type-check, linter, formatter, or coverage job, and **manual** otherwise (deploys, releases, image builds, e2e, security scans) — the loop never touches manual checks and stops rather than guessing.

**Approving review comments with 👍.** The loop does not apply review comments the moment they're left. It only acts on an inline comment thread when **both** are true: the thread is still **open (unresolved)**, and **you've reacted 👍 to its last comment**. Leave inline review comments on the PR however you like, then 👍 the ones you want applied — the loop picks those up, applies them, pushes, and resolves the thread so it isn't reapplied. Resolved threads are ignored (treated as already applied or declined), and unapproved threads simply wait for your 👍. The 👍 must be yours (the PR author's) — a reviewer can't self-approve their own comment.

### `pr context`

Read-only. Prints the fix loop's **iteration brief** — both the current state (conflict status vs. the base branch, each failing check tagged `[FIXABLE]`/`[MANUAL]` with logs for the fixable ones, and your 👍-approved review threads) **and**, under a "➡️ Do this now" section, the single computed next action: merge the base, fix CI / apply the approved comments, wait for CI, or stop. This is the loop's brain — the loop just runs this and obeys it, so the per-iteration logic stays in one regenerated-fresh place rather than drifting in the agent's context. You can run it yourself to see exactly what the loop would do next.

---

## `santree config`

A live settings panel for santree, organized into three sections:

- **System** — required tools and their versions, "update available" notices, and the active multiplexer. Diagnostic-only.
- **Global** — your editor and Claude Code integration (statusline, remote control).
- **This repo** — the issue tracker, gitignore entries, and the `.santree` scaffold.

Navigate with `↑/↓`. `Space` toggles a setting on or off; `Enter` or `→` changes a setting or drills into a sub-menu; `←` or `Esc` backs out of a sub-menu or quits. Changes apply immediately, per row — there's no separate confirm step. Read-only diagnostic rows (tool versions, "update available", active multiplexer, workspace editor) are shown but not selectable; santree reports them so you can change them elsewhere.

The **Issue tracker** row under **This repo** drills into **Local**, **Linear**, and **GitHub**, marking the one in use. Selecting **Linear** opens a workspace sub-menu and runs the OAuth flow inline; selecting **GitHub** uses your existing `gh auth login`. The dashboard's `t` overlay opens the same picker.

| Option | Description |
|---|---|
| `--check` | Non-interactive. Print the flat read-only status report — system requirements and integrations — and exit non-zero if a required tool is missing. Use it in scripts/CI or for a quick glance. |
| `--yes` | Apply all recommended changes non-interactively. |
| `--dry-run` | Preview changes without writing anything. |

## `santree issue` (tracker-agnostic)

| Command | Description |
|---|---|
| `santree issue open` | Open the current branch's issue in the browser |

Picking the tracker lives in the Issue tracker row of [`santree config`](#santree-config). For a one-off, non-interactive override use the `SANTREE_TRACKER` env var (see [Configuration](configuration.html)).

## `santree linear`

| Command | Description |
|---|---|
| `santree linear auth` | Authenticate with Linear / inspect Linear auth state (OAuth) |

### `linear auth`

| Option | Description |
|---|---|
| `--status` | Show current auth status (org, token expiry) |
| `--test <id>` | Fetch a ticket by ID to verify integration works |
| `--logout` | Revoke tokens and log out |

GitHub Issues needs no santree-side auth command — log in with the `gh` CLI directly (`gh auth login`), then pick GitHub from the Issue tracker row in `santree config`.

---

## `santree helpers`

| Command | Description |
|---|---|
| `santree helpers statusline` | Custom statusline for Claude Code |
| `santree helpers squirrel` | Render the SDF squirrel loader animation standalone |

See [Integrations](integrations.html) for what the optional hooks do and why you might want them.
