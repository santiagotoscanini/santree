# CLAUDE.md

## Project Overview

Santree is a CLI for managing Git worktrees with integrated AI assistance. It creates isolated development environments for feature branches, integrating with GitHub PRs and Linear tickets.

## Build Commands

```bash
npm run build          # Compile TypeScript to dist/
npm run dev            # Watch mode compilation
npm start              # Run CLI: node dist/cli.js
npm run lint           # Run ESLint
```

## Architecture

```
source/
├── cli.tsx              # Entry point — Pastel app runner
├── lib/
│   ├── ai.ts            # Shared AI logic (context resolution, prompt rendering, claude launch)
│   ├── git.ts           # Sync/async git helpers (worktrees, branches, metadata)
│   ├── github.ts        # GitHub CLI wrapper (PR info, auth, push, checks, reviews)
│   ├── exec.ts          # run() — execSync wrapper returning string | null
│   ├── linear.ts        # Linear GraphQL API client (OAuth, tickets, images)
│   ├── prompts.ts       # Nunjucks template renderer for AI prompts
│   └── dashboard/       # Dashboard UI components
│       ├── types.ts     # State types, action types, phase enums
│       ├── IssueList.tsx # Left pane — issue list with priority, session, PR, CI columns
│       └── DetailPanel.tsx # Right pane — issue detail, git status, context-aware actions
└── commands/            # One React component per CLI command
    ├── doctor.tsx        # Top-level: system requirements check
    ├── dashboard.tsx     # Top-level: interactive dashboard (alt screen, mouse, inline flows)
    ├── worktree/         # santree worktree {create,list,switch,remove,clean,sync,work,open,setup,commit}
    ├── pr/               # santree pr {create,open,fix,review}
    ├── linear/           # santree linear {auth,switch,open}
    └── helpers/          # santree helpers {shell-init,statusline}
prompts/                 # Nunjucks templates: work, review, fix-pr, fill-pr, diff, pr, ticket
shell/                   # Shell integration templates: init.zsh.njk, init.bash.njk
```

### Command anatomy

Every file in `commands/` exports:

- `description` — help text string
- `options` — Zod schema for CLI flags (optional)
- `args` — Zod schema for positional arguments (optional)
- Default export — React (Ink) component

### Command UI pattern

Commands follow a state-machine pattern with a `Status` union type driving the UI:

```tsx
type Status = "checking" | "pushing" | "done" | "error";
const [status, setStatus] = useState<Status>("checking");
```

The render uses `status` to pick between `<Spinner>`, success `<Text>`, and error `<Text>`. Interactive commands (commit, clean, pr) use `useInput` to handle y/n confirmation at specific statuses.

### Async and spinner rendering

Ink renders React, so the spinner freezes if the main thread blocks. Commands handle this with:

1. **Initial yield** — `await new Promise(r => setTimeout(r, 100))` at the top of the `useEffect` async function, so Ink renders the first frame with the spinner before any work starts.
2. **Sync git calls in lib/git.ts** — most git helpers use `execSync` (via `run()`) which blocks briefly. This is acceptable for fast git commands. Between batches of sync calls, commands yield with `await new Promise(r => setTimeout(r, 10))` to let the spinner animate.
3. **Truly async operations** — `createWorktree`, `removeWorktree`, PR info fetches, and push operations use `execAsync`/`spawn` so the spinner stays alive during slow network operations.
4. **Parallel fetching** — `Promise.all()` for independent async calls (e.g., PR info + dirty check + commits ahead in `list.tsx`).

### Shell integration

Commands can't `cd` the parent shell. Instead they write markers to stdout:

- `SANTREE_CD:<path>` — shell wrapper reads this and `cd`s
- `SANTREE_WORK:<mode>` — shell wrapper launches `st worktree work` after `cd`

The shell wrapper is generated from `shell/init.{zsh,bash}.njk` via `santree helpers shell-init`.

### AI shared logic (`lib/ai.ts`)

Three AI-powered commands share context resolution and prompt rendering:

- `worktree/work.tsx` → implement/plan mode
- `pr/fix.tsx` → fix PR review comments
- `pr/review.tsx` → review changes against ticket

`resolveAIContext()` finds repo, branch, ticket ID, and fetches Linear ticket data. `renderAIPrompt()` renders a named Nunjucks template with context. `launchAgent()` spawns the Claude CLI. `fetchAndRenderPR(branch)` and `fetchAndRenderDiff(branch)` pre-fetch structured PR feedback and diff data for injection into prompts.

### Metadata storage

- Worktree directories live in `.santree/worktrees/{ticketId}/`
- Base branch metadata is centralized in `.santree/metadata.json`, keyed by ticket ID
- Entries are only written when `baseBranch !== getDefaultBranch()` — if missing, assume default branch
- `createWorktree()` writes entries, `removeWorktree()` cleans them up

### Git helpers (`lib/git.ts`)

Two layers:

- **`run(cmd)`** (`lib/exec.ts`) — `execSync` wrapper, returns trimmed stdout or `null` on failure. Used for quick git queries.
- **`execAsync(cmd)`** — `promisify(exec)`, used for operations that may take time (worktree add/remove, push, branch delete).

Key functions: `findMainRepoRoot()` (resolves through worktrees to main repo), `findRepoRoot()` (current checkout), `isInWorktree()` (compares `--git-dir` vs `--git-common-dir`), `extractTicketId(branch)` (regex `[A-Z]+-\d+`).

### Statusline (`commands/helpers/statusline.tsx`)

Special command — no Ink UI. Reads JSON from stdin (Claude Code statusline hook), writes ANSI-colored text to stdout, then `process.exit(0)`. Detects santree worktrees via path (`/.santree/worktrees/`).

### Dashboard (`commands/dashboard.tsx`)

Full-screen interactive dashboard showing all Linear issues assigned to the user. Runs in the terminal alternate screen with mouse support (click-to-select, drag-to-resize panes, scroll wheel).

**Layout**: Two-pane split — left pane (`IssueList`) shows issues grouped by project with columns for priority, session, PR, and CI status; right pane (`DetailPanel`) shows issue detail with description, git status, PR info, checks, reviews, and context-aware actions.

**State management**: `useReducer` with `DashboardState`/`DashboardAction` (defined in `lib/dashboard/types.ts`). Overlay states (`mode-select`, `confirm-delete`, `commit`, `pr-create`) replace the right pane with inline flows.

**Inline flows** (never leave the dashboard):

- **Commit & push** (`C` key): stage confirm → message input via `TextInput` → commit → push. Uses `{ cwd: worktreePath }` for all git operations (not `git -C`).
- **PR creation** (`c` key): choose fill/web → push → create via `gh pr create`. Fill mode uses `--fill --base --head` flags.

**Tmux-launched flows** (open new tmux windows):

- **Work** (`w` key): opens mode-select overlay → launches `st worktree work` in a tmux window
- **Fix PR** (`f` key) and **Review PR** (`r` key): launch `st pr fix`/`st pr review` in tmux

**Data fetching**: `loadDashboardData()` fetches Linear issues and enriches each with worktree info (git status, commits ahead, session ID), PR info, checks, and reviews — all in parallel via `Promise.all`. Auto-refreshes every 30s.

**Alt screen lifecycle**: `ensureAltScreen()` enters alt screen before first render. Cleanup in `useEffect` return exits alt screen — `exit()` triggers unmount which triggers cleanup (do not write escape sequences before `exit()` or Ink's final render leaks to normal buffer).

## Key Patterns

- **Branch naming**: `{prefix}/{TICKET-ID}-description` (e.g., `feature/TEAM-123-auth`)
- **Ticket ID extraction**: first `[A-Z]+-\d+` match in branch name, uppercased
- **Error resilience**: commands degrade gracefully when integrations (gh, Linear API) are unavailable
- **Prompt-driven AI**: Nunjucks templates in `prompts/` generate context-rich prompts passed to Claude CLI

## External Dependencies

Required: Node.js >= 20, Git, GitHub CLI (`gh`), Claude Code CLI (`claude`)
Optional: tmux (new window support)

### Linear Integration

Santree fetches Linear ticket data via the GraphQL API (OAuth PKCE). Run `santree linear auth` to authenticate — opens browser, stores tokens in `~/.santree/auth.json`, and links the org to the current repo. Ticket data (title, description, comments, images) is injected into prompts before launching Claude. Auth tokens auto-refresh; images are downloaded to `/tmp/santree-images-{ticketId}/` and cleaned up on exit.
