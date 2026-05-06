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
  Integrates with GitHub PRs and pluggable issue trackers (Linear, GitHub Issues) via Claude AI.
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
# Open the interactive dashboard — manage everything from one screen
santree dashboard

# Or use individual commands:

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

| Command                            | Description                                         |
| ---------------------------------- | --------------------------------------------------- |
| `santree worktree create <branch>` | Create a new worktree from base branch              |
| `santree worktree list`            | List all worktrees with PR status and commits ahead |
| `santree worktree switch <branch>` | Switch to another worktree                          |
| `santree worktree remove <branch>` | Remove a worktree and its branch                    |
| `santree worktree clean`           | Remove worktrees with merged/closed PRs             |
| `santree worktree sync`            | Sync current worktree with base branch              |
| `santree worktree work`            | Launch Claude AI to work on the current ticket      |
| `santree worktree open`            | Open workspace in VSCode or Cursor                  |
| `santree worktree setup`           | Run the init script (`.santree/init.sh`)            |
| `santree worktree commit`          | Stage and commit changes                            |
| `santree worktree diff`            | View branch-only diff (uses merge-base, like a GitHub PR) |

### Pull Requests (`santree pr`)

| Command             | Description                           |
| ------------------- | ------------------------------------- |
| `santree pr create` | Create a GitHub pull request          |
| `santree pr open`   | Open the current PR in the browser    |
| `santree pr fix`    | Fix PR review comments with AI        |
| `santree pr review` | Review changes against ticket with AI |

### Issue trackers

Santree supports Linear and GitHub Issues behind a single interface. Each repo picks one. Use the generic `santree issue` commands for tracker-agnostic actions; use `santree linear` / `santree github` for backend-specific auth.

#### Generic — `santree issue`

| Command                                | Description                                                  |
| -------------------------------------- | ------------------------------------------------------------ |
| `santree issue switch <linear\|github>` | Pick the active tracker for this repo                        |
| `santree issue open`                   | Open the current branch's issue in the browser               |

#### Linear (`santree linear`)

| Command                 | Description                                   |
| ----------------------- | --------------------------------------------- |
| `santree linear auth`   | Authenticate with Linear (OAuth)              |
| `santree linear switch` | Switch Linear workspace for this repo         |

#### GitHub Issues (`santree github`)

| Command               | Description                                                            |
| --------------------- | ---------------------------------------------------------------------- |
| `santree github auth` | Verify `gh auth status`, run `gh auth login` if needed, set tracker=github |

### Helpers (`santree helpers`)

| Command                                        | Description                                      |
| ---------------------------------------------- | ------------------------------------------------ |
| `santree helpers shell-init`                   | Output shell integration script                  |
| `santree helpers statusline`                   | Custom statusline for Claude Code                |
| `santree helpers session-signal notification`  | Signal waiting state (Notification hook)         |
| `santree helpers session-signal stop`          | Signal idle state (Stop hook)                    |
| `santree helpers session-signal prompt`        | Signal active state (UserPromptSubmit hook)      |
| `santree helpers session-signal end`           | Signal exited state (SessionEnd hook)            |
| `santree helpers session-signal install`       | Auto-install session-signal hooks in Claude Code |
| `santree helpers session-signal install --dry` | Print the hooks JSON without writing             |

### Top-level

| Command             | Description                                     |
| ------------------- | ----------------------------------------------- |
| `santree dashboard` | Interactive dashboard of all your assigned issues |
| `santree doctor`    | Check system requirements and integrations      |

---

## Features

### Workflow

End-to-end flow, from picking an issue to merging the PR. Everything runs inside the terminal multiplexer; the dashboard orchestrates and the AI agent does the heavy lifting at two distinct stages.

```mermaid
flowchart TB
    subgraph Term["Terminal · tmux / cmux"]
        direction TB
        Dashboard(["① Dashboard<br/>pick issue · add context"]):::action
        Editor["Editor<br/><sub>zed · cursor · vscode · nvim · jetbrains</sub>"]:::tool
        AI(("② / ⑤ AI agent<br/>Claude Code")):::agent
        Pager["③ Diff pager<br/><sub>delta · diff-so-fancy · built-in</sub>"]:::tool
        Decision{good?}:::decision
        Ship(["④ git commit + PR"]):::action
        GitHub[("GitHub<br/>PRs · CI")]:::external

        Dashboard ==>|implement| AI
        Dashboard -. write context .-> Editor
        Editor -. context · hand-edit .-> AI
        AI ==> Pager
        Pager ==> Decision
        Decision -->|hand-edit| Editor
        Decision -->|resume| AI
        Decision ==>|ship| Ship
        Ship ==> GitHub
        GitHub -->|reviews · CI| AI
        AI -->|push fix| Ship
    end

    classDef action fill:#dbeafe,stroke:#3b82f6,stroke-width:2px,color:#1e3a8a
    classDef tool fill:#f3f4f6,stroke:#9ca3af,color:#374151
    classDef agent fill:#ede9fe,stroke:#8b5cf6,stroke-width:2px,color:#4c1d95
    classDef external fill:#fef3c7,stroke:#f59e0b,stroke-width:2px,color:#78350f
    classDef decision fill:#fee2e2,stroke:#ef4444,stroke-width:2px,color:#7f1d1d
```

Bold edges (`==>`) follow the happy path; thin edges (`-->`) are branches/loops; dotted edges (`-.->`) are optional editor side-trips. Colors group nodes by role: blue actions, purple agent, gray tools, yellow external service, red decision.

**Stages, in order:**

1. **Pick + add context** — open the dashboard, browse assigned issues, pick one. The inline context box lets you add custom instructions to the prompt; `Ctrl+O` drops into your editor for longer prose.
2. **AI agent (Claude)** — runs in the worktree's mux window with the rendered ticket + your context. Implements or plans.
3. **Diff pager (review)** — `[v]` opens the diff overlay. From here you iterate: hand-edit in your editor, or resume the Claude session to keep going.
4. **Ship** — once the diff looks right, `[C]` for inline commit + push, then `[c]` to create the PR (`--fill` runs Claude non-interactively against the PR template).
5. **PR feedback loop** — `[f]` (fix) and `[r]` (self-review) re-launch the AI with PR comments + CI failures as input. Patches are pushed; CI re-runs; loop until merged.

**Supported tools per stage:**

| Stage | Supported today | Planned |
|---|---|---|
| **Issue tracker** (① Dashboard) | Linear, GitHub Issues | Jira, Shortcut, etc. |
| **AI agent** (②, ⑤) | Claude Code (`claude` CLI) | OpenAI Codex, OpenCode, Cursor agent |
| **Diff pager** (③) | delta, diff-so-fancy, any unified-diff pager — built-in colorizer when none set | — |
| **Editor** (side branch) | Anything taking a path: zed, nvim, jetbrains, cursor, vscode. cursor + vscode also handle `.code-workspace` files via `[E]` workspace shortcut | — |
| **Forge** (④) | GitHub via `gh` CLI | GitLab, Bitbucket, Gitea |
| **Terminal multiplexer** (outer frame) | tmux, cmux *(macOS-only — see [#1472](https://github.com/manaflow-ai/cmux/issues/1472))*, none | zellij |

The AI agent and issue tracker are already behind interfaces (`lib/trackers/`, plus the `claude` CLI shim in `lib/ai.ts`). Adding a new option in either category means writing one new module and wiring it into the factory — no changes to UI/dashboard code.

### Interactive Dashboard

`santree dashboard` opens a full-screen TUI to manage all your work in one place. It shows your assigned issues from the active tracker (Linear or GitHub Issues) grouped by project, with live status for worktrees, PRs, CI checks, and reviews.

**Left pane** — issue list. Issues without worktrees show as a single row (priority + ID + title). Issues with worktrees expand into nested sub-rows below the title showing `· diff` (files/adds/deletes/commits-ahead), `· pr` (number, state, CI, review count), and `· session` (state + Claude session ID). Click any row (main or sub) to select; scroll wheel navigates; drag the divider to resize panes.

**Right pane** — issue detail with description, file-level git status (staged/unstaged/untracked), PR info, checks, reviews, and context-aware keyboard actions.

**Keyboard actions:**
| Key | Action |
|-----|--------|
| `w` | Create worktree & start working (plan or implement) |
| `↵` | Resume session / switch to worktree |
| `e` | Open worktree in editor |
| `C` | Inline commit & push flow |
| `c` | Create PR (fill from commits or open in browser) |
| `v` | Inline diff overlay — file tree + diff content (mouse + keyboard) |
| `f` / `r` | Fix PR / Review PR (launches in tmux) |
| `o` / `p` | Open issue (in Linear or GitHub) / PR in browser |
| `d` | Remove worktree |

Commit, PR creation, and diff review happen inline without leaving the dashboard. Work, fix, and review open in new tmux windows.

**Diff overlay** (`v`) — branch-only diff vs the base branch's merge-base (matches GitHub PR semantics — upstream changes you haven't pulled don't leak in). Left pane shows changed files in a tree, right pane shows the diff. `j/k` navigate files, `J/K` (or shift+arrows) scroll the diff, `g/G` jump to top/bottom, `q`/`esc` close. Mouse: click a file to select, scroll wheel over the file pane changes selection, scroll wheel over the diff scrolls content. Set `SANTREE_DIFF_TOOL` to pipe through delta, diff-so-fancy, or any pager that takes a unified diff.

### Worktree Management

Create isolated worktrees for each feature branch. No more stashing or committing WIP code just to switch tasks.

### GitHub Integration

See PR status directly in your worktree list. Clean up worktrees automatically when PRs are merged or closed.

### Issue Tracker Integration

Santree fetches issue data (title, description, comments, images) from the active tracker — Linear or GitHub Issues — and injects it into prompts when running `santree worktree work`. See [Issue Tracker Integration](#issue-tracker-integration-1) for setup.

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

Branch names need to encode the issue ID so santree can link the worktree back to the right ticket. The accepted format depends on the active tracker:

```
# Linear (uppercased letter prefix + dash + digits)
user/TEAM-123-feature-description
feature/PROJ-456-add-auth

# GitHub Issues (explicit prefix required, to avoid `fix-typo-1` matching)
feature/issue-42-add-auth
gh-42-add-auth
42-add-auth
```

GitHub's parser is strict on purpose: a commit-style branch like `fix-typo-1` will *not* match (no explicit prefix, no slash-led number).

### Issue Tracker Integration

Each repo picks one tracker. The active tracker is resolved in this order: `SANTREE_TRACKER` env var → per-repo `_tracker.kind` (in `.santree/metadata.json`) → legacy `_linear.org` (treated as Linear) → auto-detect (any Linear creds → Linear, else GitHub).

#### Choosing a tracker

```bash
# Explicitly pick the active tracker for this repo
santree issue switch linear
santree issue switch github

# Or let an auth command set it as a side effect:
santree linear auth        # Sets _tracker.kind = "linear" after OAuth
santree github auth        # Sets _tracker.kind = "github" after `gh auth login`
```

For a one-off override (testing, scripting):

```bash
SANTREE_TRACKER=github santree dashboard
```

#### Linear

Santree fetches Linear ticket data via the GraphQL API (OAuth PKCE).

```bash
# Authenticate with Linear (opens browser for OAuth)
santree linear auth

# Check auth status
santree linear auth --status

# Verify a ticket is fetched correctly
santree linear auth --test TEAM-123

# Log out
santree linear auth --logout

# Switch between authenticated workspaces
santree linear switch
```

On first run, `santree linear auth` opens your browser to authorize the app with your Linear workspace. Tokens are stored in `$XDG_CONFIG_HOME/santree/auth.json` (defaults to `~/.config/santree/auth.json`) and auto-refresh transparently.

If you have multiple workspaces authenticated, running `santree linear auth` in a new repo will let you pick which one to link. Images from tickets are downloaded to a temp directory and cleaned up after Claude exits.

#### GitHub Issues

Santree uses the existing `gh` CLI — no separate OAuth flow.

```bash
# Verify gh is authenticated; flips this repo's tracker to GitHub
santree github auth
```

Issues are listed via `gh search issues --assignee=@me --state=open --repo <owner>/<name>` (current repo only — cross-repo issues aren't surfaced today). Priority is derived from labels matching `P0`/`P1`/`P2`/`P3`/`urgent`/`critical`/`high`/`medium`/`low`, falling back to `No priority`. Attached images on `user-images.githubusercontent.com` and `github.com/.../assets/` are downloaded so Claude can read them when filling PR templates.

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

### Claude Code Remote Control (Optional)

Enable [Remote Control](https://code.claude.com/docs/en/remote-control) to continue local Claude Code sessions from your phone, tablet, or any browser. This lets you kick off work with `santree worktree work` and monitor or steer the session remotely.

Enable it for all sessions by running `/config` inside Claude Code and setting **Enable Remote Control for all sessions** to `true`. This writes `remoteControlAtStartup: true` to `~/.claude.json`. Run `santree doctor` to verify.

### Session State Signaling (Optional)

Surfaces the current Claude Code session state in the dashboard, statusline, and tmux window names. Shows whether a session is actively working, waiting for permission approval, idle, or exited.

**States:**
| State | Meaning |
|-------|---------|
| `active` | User submitted a prompt, Claude is working |
| `waiting` | Claude needs permission approval |
| `idle` | Claude finished and is waiting for next prompt |
| `exited` | Session ended |

**Install:**

```bash
santree helpers session-signal install
```

This adds hooks for `Notification`, `Stop`, `UserPromptSubmit`, and `SessionEnd` to `~/.claude/settings.json`. Existing hooks are preserved.

To preview the JSON without writing: `santree helpers session-signal install --dry`

Verify with `santree doctor` — look for the "Session Signal Hooks" row under Claude Code.

### Environment Variables

| Variable | Effect |
|---|---|
| `SANTREE_TRACKER` | Override the active issue tracker for a single invocation: `linear` or `github`. Takes precedence over the per-repo `_tracker.kind`. If unset, falls back to repo config → legacy `_linear.org` → auto-detect. |
| `SANTREE_EDITOR` | Editor used by `e` (open in editor) actions in the dashboard. Defaults to `code`. Examples: `cursor`, `zed`, `code`, `nvim`. |
| `SANTREE_MULTIPLEXER` | Terminal multiplexer used by the dashboard and `worktree create --window`. One of `tmux`, `cmux`, `none`. If unset, auto-detects from `$TMUX` / `$CMUX_SURFACE_ID`. cmux is macOS-only and limited by [manaflow-ai/cmux#1472](https://github.com/manaflow-ai/cmux/issues/1472). |
| `SANTREE_DIFF_TOOL` | Pager used by `worktree diff` (CLI) and the dashboard diff overlay. Passed to git as `-c core.pager=<tool>` for the CLI, and used to pipe content for the overlay. Examples: `delta`, `diff-so-fancy`. Must accept a unified diff on stdin. Names are restricted to `[A-Za-z0-9_\-/.+]`. |
| `SANTREE_THEME` | Dashboard color theme: `light`, `dark`, or `auto` (default). In `auto` mode, santree queries the terminal's background via OSC 11 and re-detects on each refresh cycle (≤30s) so theme switches propagate automatically. Set explicitly when your terminal doesn't respond to OSC 11. |

Santree always launches Claude with `--permission-mode auto` (Claude Code's auto mode), or `plan` when invoked in plan mode. Worktree-scoped automation is the default — there is no opt-in flag.

---

## Command Options

### worktree create

| Option            | Description                                       |
| ----------------- | ------------------------------------------------- |
| `--base <branch>` | Base branch to create from (default: main/master) |
| `--work`          | Launch Claude after creating                      |
| `--plan`          | With --work, only create implementation plan      |
| `--no-pull`       | Skip pulling latest changes                       |
| `--tmux`          | Open worktree in new tmux window                  |
| `--name <name>`   | Custom tmux window name                           |

### worktree sync

| Option     | Description                 |
| ---------- | --------------------------- |
| `--rebase` | Use rebase instead of merge |

### worktree remove

Removes the worktree and deletes the branch. Uses force mode by default (removes even with uncommitted changes).

### worktree clean

Shows worktrees with merged/closed PRs and prompts for confirmation before removing.

### worktree open

| Option           | Description                                                                             |
| ---------------- | --------------------------------------------------------------------------------------- |
| `--editor <cmd>` | Editor command to use (default: `code`). Also configurable via `SANTREE_EDITOR` env var |

### worktree diff

Shows a branch-only unified diff against the base branch's merge-base — same scope as a GitHub PR diff (upstream commits you haven't pulled don't leak in). Includes both committed and uncommitted work by default. Honors `SANTREE_DIFF_TOOL` (e.g. `delta`).

| Option       | Description                                       |
| ------------ | ------------------------------------------------- |
| `--commits`  | Show only committed changes (`merge-base..HEAD`)  |
| `--staged`   | Show only staged changes                          |
| `--unstaged` | Show only unstaged (working tree vs index)       |
| `--base <branch>` | Override the base branch                     |

### worktree work

| Option   | Description                     |
| -------- | ------------------------------- |
| `--plan` | Only create implementation plan |

Automatically fetches issue data from the active tracker (Linear or GitHub Issues) if authenticated. Degrades gracefully if not.

### pr create

| Option   | Description                                   |
| -------- | --------------------------------------------- |
| `--fill` | Use AI to fill the PR template before opening |

Automatically pushes, detects existing PRs, and uses the first commit message as the title. If a closed PR exists for the branch, prompts before creating a new one.

### linear auth

| Option        | Description                                      |
| ------------- | ------------------------------------------------ |
| `--status`    | Show current auth status (org, token expiry)     |
| `--test <id>` | Fetch a ticket by ID to verify integration works |
| `--logout`    | Revoke tokens and log out                        |

---

## Requirements

| Tool                                 | Purpose                              |
| ------------------------------------ | ------------------------------------ |
| Node.js >= 20                        | Runtime                              |
| Git                                  | Worktree operations                  |
| GitHub CLI (`gh`)                    | PR integration                       |
| Claude Code (`claude`)               | AI agent for `work`, `fix`, `review` |
| tmux                                 | Optional: new window support         |
| VSCode (`code`) or Cursor (`cursor`) | Optional: workspace editor           |
| delta (`git-delta`)                  | Optional: syntax-highlighted diffs (used by `worktree diff` and the dashboard `v` overlay when `SANTREE_DIFF_TOOL=delta` is set) |

---

## Provider Support

Santree currently locks in to specific providers for some integrations and is interchangeable for others. The list below is a snapshot of what's supported today — contributions welcome.

### Single-provider (no swap-out today)

| Area | Supported | Not yet supported |
| --- | --- | --- |
| **Source control / forge** | GitHub (via `gh` CLI) | GitLab, Bitbucket, Gitea, Codeberg, self-hosted Forgejo |
| **Coding agent** | Claude Code (`claude` CLI) | OpenAI Codex, OpenCode, Cursor agent, Aider, others |

These are hardwired in `lib/github.ts` and `lib/ai.ts` respectively. Adding a second provider means abstracting an interface (similar to `lib/trackers/` or `lib/multiplexer/`) and wiring a selection mechanism.

### Multi-provider (already interchangeable)

| Area | How to switch | Examples |
| --- | --- | --- |
| **Issue tracker** | `santree issue switch <linear\|github>` (or `SANTREE_TRACKER` env var, or as a side effect of `santree linear auth` / `santree github auth`) | Linear (OAuth + GraphQL), GitHub Issues (via `gh` CLI). Adding a third tracker = one new directory under `lib/trackers/`. |
| **Editor** | `SANTREE_EDITOR` env var (or `--editor` flag on `worktree open`) | `code`, `cursor`, `zed`, `nvim`, `subl`, `webstorm` — any executable that takes a path argument |
| **Terminal multiplexer** | `SANTREE_MULTIPLEXER` env var | `tmux` (default, all platforms), `cmux` (macOS only — see [#1472](https://github.com/manaflow-ai/cmux/issues/1472)), `none`. Zellij is planned but not implemented. |
| **Diff renderer** | `SANTREE_DIFF_TOOL` env var | `delta`, `diff-so-fancy`, or any pager that accepts a unified diff. Falls back to plain `git diff` colorization when unset. |
| **Color theme** | `SANTREE_THEME` env var (`light`/`dark`/`auto`) | Auto-detects via OSC 11; manual override available. Re-detects every refresh so theme switches show up within 30s. |
| **Shell integration** | `santree helpers shell-init` detects the shell | `zsh`, `bash` (templates in `shell/init.{zsh,bash}.njk`) |

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
│   ├── git.ts           # Git helpers (worktrees, branches); extractTicketId is a tracker shim
│   ├── github.ts        # GitHub CLI wrapper (PR info, auth, push, checks, reviews)
│   ├── exec.ts          # Shell command helpers
│   ├── metadata.ts      # .santree/metadata.json r/w (extracted to break import cycles)
│   ├── prompts.ts       # Nunjucks template renderer
│   ├── trackers/        # Issue tracker abstraction (Linear, GitHub Issues)
│   │   ├── types.ts     # IssueTracker interface + generic Issue/AssignedIssue types
│   │   ├── index.ts     # getIssueTracker(repoRoot) factory
│   │   ├── linear/      # OAuth PKCE + GraphQL + image rewriter
│   │   └── github/      # `gh` CLI wrappers; priority derived from labels
│   ├── multiplexer/     # tmux/cmux/none abstraction (windows/sessions)
│   └── dashboard/       # Dashboard UI components
│       ├── types.ts     # State types, action types, phase enums
│       ├── IssueList.tsx # Left pane — issue list with priority, session, PR, CI columns
│       └── DetailPanel.tsx # Right pane — issue detail, git status, context-aware actions
└── commands/            # One React (Ink) component per CLI command
    ├── doctor.tsx        # Top-level: system check
    ├── dashboard.tsx     # Top-level: interactive dashboard
    ├── worktree/         # Worktree management (create, list, switch, etc.)
    ├── pr/               # PR lifecycle (create, open, fix, review)
    ├── linear/           # Linear-specific OAuth (auth, switch)
    ├── github/           # GitHub-specific auth (gh wrapper)
    ├── issue/            # Tracker-agnostic actions (switch, open)
    └── helpers/          # Shell init, statusline
prompts/                 # Nunjucks templates: implement, plan, review, fix-pr, fill-pr, ticket
shell/                   # Shell integration templates: init.zsh.njk, init.bash.njk
```
