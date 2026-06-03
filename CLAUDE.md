# CLAUDE.md

## Project Overview

Santree is a CLI for managing Git worktrees with integrated AI assistance. It creates isolated development environments for feature branches, integrating with GitHub PRs and pluggable issue trackers (Linear or GitHub Issues today, more behind the same interface tomorrow).

## Documentation

The `docs/` folder is the user-facing documentation (GitHub Pages site, live at santree.toscanini.me). **Any change that affects user-visible behavior — new commands, flags, env vars, keybindings, or workflow changes — must be reflected in `docs/` in the same change.** Treat the docs as part of the deliverable, not a follow-up: if a code change makes a `docs/` page stale, update that page before considering the work done.

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
│   ├── git.ts           # Sync/async git helpers (worktrees, branches); extractTicketId is a tracker shim
│   ├── github.ts        # GitHub CLI wrapper (PR info, auth, push, checks, reviews)
│   ├── exec.ts          # run() — execSync wrapper returning string | null
│   ├── metadata.ts      # .santree/metadata.json r/w (extracted to break the trackers ↔ git import cycle)
│   ├── prompts.ts       # Nunjucks template renderer for AI prompts
│   ├── trackers/        # Issue tracker abstraction (Linear, GitHub Issues)
│   │   ├── types.ts     # IssueTracker interface + generic Issue/AssignedIssue/Comment/AuthStatus
│   │   ├── index.ts     # getIssueTracker(repoRoot) factory + setRepoTracker/readTrackerConfig
│   │   ├── config.ts    # Per-repo `_tracker.kind` r/w (with legacy `_linear.org` migration)
│   │   ├── auth-store.ts # Versioned ~/.config/santree/auth.json (v1 Linear-flat → v2 namespaced)
│   │   ├── linear/      # OAuth PKCE + GraphQL queries + image rewriter
│   │   └── github/      # `gh` CLI / REST wrappers; priority derived from labels
│   └── dashboard/       # Dashboard UI components
│       ├── types.ts     # State types, action types, phase enums
│       ├── IssueList.tsx # Left pane — issue list with nested detail sub-rows (diff/pr/session); `variant="triage"` swaps WT/CI for a due-date column
│       ├── DetailPanel.tsx # Right pane — issue detail, git status, context-aware actions; `triage` mode shows due date + comment thread
│       ├── due.ts        # formatDueDate() — urgency-coded due-date badge for the Triage tab
│       └── DiffOverlay.tsx # Inline diff overlay — file tree + diff content (full-area)
└── commands/            # One React component per CLI command
    ├── doctor.tsx        # Top-level: system requirements check (also reports git-delta as optional)
    ├── dashboard.tsx     # Top-level: interactive dashboard (alt screen, mouse, inline flows)
    ├── worktree/         # santree worktree {create,list,switch,remove,clean,sync,work,open,setup,commit,diff}
    ├── pr/               # santree pr {create,open,fix,review}
    ├── linear/           # santree linear {auth,switch} — Linear-specific OAuth flow
    ├── github/           # santree github {auth} — `gh auth login` wrapper
    ├── issue/            # santree issue {switch,open} — tracker-agnostic actions
    └── helpers/          # santree helpers {shell-init,statusline}
prompts/                 # Nunjucks templates: work, review, fix-pr, fill-pr, diff, pr, ticket, ask
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

`resolveAIContext()` finds repo, branch, and issue identifier, then fetches the issue from the active tracker (Linear or GitHub — see [Issue tracker abstraction](#issue-tracker-abstraction-libtrackers)). It returns `AIContext` with the issue plus `trackerName`/`issueNoun` so prompt templates and downstream code don't hardcode a vendor name. `renderAIPrompt()` renders a named Nunjucks template with context. `launchAgent()` spawns the Claude CLI. `fetchAndRenderPR(branch)` and `fetchAndRenderDiff(branch)` pre-fetch structured PR feedback and diff data for injection into prompts.

### Metadata storage

- Worktree directories live in `.santree/worktrees/{ticketId}/`
- Base branch metadata is centralized in `.santree/metadata.json`, keyed by ticket ID
- Entries are only written when `baseBranch !== getDefaultBranch()` — if missing, assume default branch
- `createWorktree()` writes entries, `removeWorktree()` cleans them up

### Git helpers (`lib/git.ts`)

Two layers:

- **`run(cmd)`** (`lib/exec.ts`) — `execSync` wrapper, returns trimmed stdout or `null` on failure. Used for quick git queries.
- **`execAsync(cmd)`** — `promisify(exec)`, used for operations that may take time (worktree add/remove, push, branch delete).

Key functions: `findMainRepoRoot()` (resolves through worktrees to main repo), `findRepoRoot()` (current checkout), `isInWorktree()` (compares `--git-dir` vs `--git-common-dir`), `extractTicketId(branch)` (one-line shim that delegates to `getIssueTracker(...).extractIdFromBranch(branch)` — Linear's regex is `[A-Z]+-\d+`, GitHub's requires an explicit prefix `gh-NN`/`issue-NN`/`#NN`/`feature/NN-`).

The metadata-file r/w helpers (`readAllMetadata`/`writeAllMetadata`/`getSantreeDir`) live in `lib/metadata.ts` and are re-exported from `lib/git.ts` for backward compat. They were extracted to break a circular import: `lib/trackers/linear/auth.ts` needs to read/write the `_linear.org` key, but `lib/trackers/*` is imported by `lib/git.ts` itself. ESM doesn't allow `require()` to dodge cycles, so the metadata layer is its own module.

### Issue tracker abstraction (`lib/trackers/`)

Santree supports pluggable issue trackers — Linear (OAuth PKCE + GraphQL), GitHub Issues (via the `gh` CLI), and **Local** (built-in, file-based) ship today. Selection is driven by, in order:

1. `SANTREE_TRACKER` env var (`linear` | `github` | `local`) — overrides everything; useful for one-offs.
2. Per-repo `_tracker.kind` in `.santree/metadata.json` — set by `santree issue switch <kind>` / `santree issue setup` (or the dashboard's `t` tracker-select overlay), or as a side effect of `santree linear auth` / `santree github auth`.
3. Legacy `_linear.org` (no `_tracker.kind`) — treated as `kind: "linear"` so existing repos keep working.
4. Auto-detect: any Linear creds in `~/.config/santree/auth.json` → Linear, else GitHub (since `gh` is a hard dep).

`isRepoTrackerConfigured(repoRoot)` reports whether any *explicit* signal exists (1–4 minus the GitHub fallback). The dashboard uses it to show the tracker-selection flow on first run instead of dead-ending on an auth error; it does not change `getIssueTracker`'s fallback.

The `IssueTracker` interface (`lib/trackers/types.ts`) exposes: `kind`, `displayName` ("Linear"/"GitHub"/"Local"), `issueNoun` ("ticket"/"issue"), `getAuthStatus(repoRoot)`, `signOut(repoRoot)`, `extractIdFromBranch(branch)`, `cleanupCache(id)`, `listAssigned(repoRoot)`, `getIssue(id, repoRoot)`. Read methods return `IssueTrackerResult<T>` (`{ ok: true, value } | { ok: false, reason: "unauthenticated"|"not-found"|"network", message? }`). Optional **mutation** capability — `canMutate?: true` plus `createIssue`/`updateIssue`/`deleteIssue` — is implemented only by the Local tracker; UI gates CRUD on `tracker.canMutate === true` (feature-detect, never a `kind === "local"` check). A second optional capability flag — `supportsTriage?: true` — marks trackers with a triage inbox (Linear only); the dashboard's Triage tab is gated on it the same way. A related optional method — `getTriageSchedules?(repoRoot): Promise<TriageSchedule[]>` — returns the viewer's triage on-call rotations (Linear maps its "Triage responsibility" `timeSchedule.entries` → `TriageShift[]`, resolving entry `userId`s to names via a `users` query; never throws, `[]` on failure). Use `getIssueTracker(repoRoot)` from `lib/trackers/index.js` at every call site — never reach into a concrete tracker module.

**Local tracker** (`lib/trackers/local/`) — one Markdown file per issue at `.santree/issues/LOCAL-<n>.md` (YAML-ish frontmatter via the hand-rolled `frontmatter.ts`; no YAML dep). `.santree/issues/` is **not** gitignored, so issues are version-controlled by default — do not add it to `.gitignore`. IDs are monotonic and never recycled: `allocateId()` persists a high-water mark in `_local.lastId` in metadata.json (git-ignored / per-machine, which is the right scope — the collision avoided is with stale *local* `feature/LOCAL-<n>-*` worktrees; a fresh clone rebuilds the counter from committed files). No auth, no comments in v1 (`comments: []`). Branch regex: `/(?:^|[/_-])local-(\d+)(?:-|$)/i` → `LOCAL-<n>`, compatible with the dashboard's `feature/${ticketId}-${slug}` builder.

**Generic data shape** — `Issue`/`AssignedIssue` carry the union of fields actually consumed by UI + prompts: `identifier`, `title`, `description`, `url`, `priority` (number), `priorityLabel`, `state: { name, type }`, `labels`, `projectId`, `projectName`, and an optional `dueDate` (`YYYY-MM-DD` string; only trackers with a native due-date concept set it — Linear today; surfaced on the Triage tab). Each tracker maps its native API to that shape: GitHub derives priority from `P0`/`P1`/etc. labels, projectName from `repository.nameWithOwner`. Adding a third tracker = one new directory under `lib/trackers/`, one entry in the `IssueTrackerKind` union, one branch in `getIssueTracker()`. Nothing else changes.

**Auth file** — `~/.config/santree/auth.json` is versioned. v1 (`{[orgSlug]: LinearTokens}`) is migrated to v2 (`{ version: 2, linear: {...}, github: {} }`) on first read. The `github` namespace is reserved (the `gh` CLI owns its own token; santree never writes it).

**No `if tracker.kind === "linear"` outside the factory.** Vendor names appear in user-facing strings only when (a) the active tracker's `displayName` flows in (e.g. dashboard's `[o]` action key labelled "Linear" or "GitHub" depending on the repo), (b) a command is explicitly named after the backend (`santree linear auth`, `santree github auth`), or (c) `santree doctor` is reporting which backend is active. Every other surface speaks generically ("issue", "tracker").

### Multiplexer abstraction (`lib/multiplexer/`)

Santree supports pluggable terminal multiplexers (currently tmux and cmux; zellij planned). Selection is fully auto-detected — `getMultiplexer()` iterates over the adapter list and picks the first whose `isActive()` returns true (tmux: `$TMUX` set; cmux: `$CMUX_SURFACE_ID` set), falling back to the no-op `noneMultiplexer`. Each adapter owns its own detection; there is no env-var override.

The `Multiplexer` interface (`lib/multiplexer/types.ts`) exposes: `isActive()`, `createWindow({name, cwd, command})`, `selectWindow(name)`, `sendCommand(name, command)`, and `isSessionAlive(ticketId)`. All ops return a `SessionResult` (`{ ok: true } | { ok: false, reason, message? }`). Use `getMultiplexer()` from `lib/multiplexer/index.js` at call sites. Window/tab names are set once at `createWindow` time and not touched afterwards, so user-set names stick.

**cmux caveat**: cmux is macOS-only and requires the cmux.app GUI running. Upstream issue [manaflow-ai/cmux#1472](https://github.com/manaflow-ai/cmux/issues/1472) — programmatically created workspaces have dead PTYs, so `sendCommand` is unimplemented (returns `unsupported`) and post-creation flows degrade. tmux remains the recommended backend until #1472 lands. `santree doctor` surfaces the warning when cmux is active.

**cmux-bundled Claude**: cmux ships its own Claude CLI at `/Applications/cmux.app/Contents/Resources/bin/claude`, wired to the active cmux workspace ([cmux#2048](https://github.com/manaflow-ai/cmux/issues/2048)). When `getMultiplexer().kind === "cmux"`, `resolveClaudeBinary()` in `lib/ai.ts` returns the bundled path first; otherwise it falls back to `which claude` then `~/.claude/local/claude`. This single resolver feeds `resolveAgentBinary()` (interactive launches), `getInstalledClaudeVersion()` (header + update checks), and `checkClaude()` (doctor row labelled "Claude Code CLI (cmux-bundled)"). Use `resolveClaudeBinary()` for any new code that needs the binary path.

### Statusline (`commands/helpers/statusline.tsx`)

Special command — no Ink UI. Reads JSON from stdin (Claude Code statusline hook), writes ANSI-colored text to stdout, then `process.exit(0)`. Detects santree worktrees via path (`/.santree/worktrees/`).

### Dashboard (`commands/dashboard.tsx`)

Full-screen interactive dashboard showing all issues assigned to the user from the active tracker (see [Issue tracker abstraction](#issue-tracker-abstraction-libtrackers)). Runs in the terminal alternate screen with mouse support (click-to-select, drag-to-resize panes, scroll wheel).

**Tabs** (`1`..`N` by number or `Tab` to cycle): an optional **Triage** tab, then **Issues**, **Trees**, **Reviews**. **Triage** = the incoming inbox (tracker issues whose `state.type === "triage"` and have no worktree) — shows an urgency-coded due-date column, the comment thread in the detail pane, `a` to ask Claude a clarifying question about the issue + all its comments (inline one-shot Q&A, read-only), and `w` to send it to a tree (same worktree-creation flow as Issues). The Triage tab only appears when the active tracker has a triage concept, gated on `tracker.supportsTriage` (feature detection — Linear sets it; GitHub/Local don't). **Issues** = backlog/planning (tracker issues with no worktree; supports `n`/`e`/`d` create/edit/delete when `tracker.canMutate`, and `w` to start work which creates a worktree and moves the row to Trees), **Trees** = worktrees in progress (issues that have a worktree, plus the synthetic Main-repo row and orphaned worktrees; commit/PR/fix/diff/remove live here), **Reviews** = PRs awaiting your review. `loadDashboardData` partitions one enriched pass into `flatTriage`/`triageGroups` (triage inbox), `flatIssues`/`groups` (backlog), and `flatTrees`/`treeGroups` (work in progress); each tab has its own selection/scroll slices in `DashboardState`, plus a per-issue `triageCommentsById` cache lazily filled from `getIssue` on selection. `tabOrder` (and the numeric keybinds) is built from `supportsTriage`, so tab numbering shifts when Triage is present. When no tracker is configured (`!isRepoTrackerConfigured`), the `tracker-select` overlay (also reachable anytime via `t`) appears instead of the error screen — Local enters immediately, Linear picks an authenticated workspace, GitHub verifies `gh`.

The Triage **due-date** badge is rendered by `formatDueDate()` in `lib/dashboard/due.ts` (overdue/today → red, ≤2 days → yellow, else gray) — shown right-aligned in the issue list (`IssueList` `variant="triage"` swaps the WT/CI columns for it) and as a line in `DetailPanel` (`triage` prop hides worktree/PR/checks and shows the comment thread instead). The ask flow renders `prompts/ask.njk` via `askTicketQuestion()` in `lib/ai.ts` (grants read-only `Read`/`Grep`/`Glob` so Claude can judge fixability against the code); the `triage-ask` overlay has `input`→`running`→`answer`/`error` phases.

**Triage on-call schedule**: `s` on the Triage tab opens the `triage-schedule` full-area overlay (`TriageScheduleOverlay`) listing the viewer's Linear triage rotations — each shift's date range + resolved name, current shift and the viewer's own shifts highlighted. Data comes from `tracker.getTriageSchedules()` (fetched best-effort on every refresh into `state.triageSchedules`); `DetailPanel` also shows a compact `onCall` line at the top in triage mode (current on-call + the viewer's next shift). Works with an empty inbox.

**Worktree deletion** is concurrent and non-blocking: confirming `d` fires `removeWorktreeWithProgress()` without awaiting, so you can confirm several removals back-to-back. Each is tracked in `state.deletingTickets` (a `ticketId → DeleteStatus { logs, phase, error }` map) — `removeWorktree(branch, root, force, onProgress)` streams staged messages ("Removing worktree…" / "Cleaning up…" / "Deleting branch…" / "Done") into the entry, which `DetailPanel` renders (`deleteStatus` prop) when that row is selected, and `IssueList` marks with a `⌫` glyph in the WT column (`deletingIds` prop). `SET_DATA` prunes entries whose worktree is gone (successful removal), so in-progress and failed (`error`) deletions stay visible until resolved.

**Layout**: Two-pane split — left pane (`IssueList`) shows issues grouped by project. Each issue with a worktree expands into one or more nested **detail sub-rows** below its title (`· diff`, `· pr`, `· session`); issues without worktrees stay as a single row. The shared row builder `buildIssueListRows()` is exported from `IssueList.tsx` and used by both the renderer and the dashboard's mouse-click row→issue mapper, so click coordinates always resolve to the correct parent issue (sub-rows resolve to the parent's `flatIndex`). Right pane (`DetailPanel`) shows issue detail with description, git status, PR info, checks, reviews, and context-aware actions.

**State management**: `useReducer` with `DashboardState`/`DashboardAction` (defined in `lib/dashboard/types.ts`). Right-pane overlays (`mode-select`, `confirm-delete`, `commit`, `pr-create`) replace just the right pane; full-area overlays (`context-input`, `triage-ask`, `diff`, `base-select`, `confirm-setup`, `tracker-select`, `issue-form`, `confirm-delete-issue`) replace the entire content area below the tab bar. `issue-form` reuses `MultilineTextArea` in two steps (title → description, Ctrl+D advance/save, Ctrl+G cancel) like `context-input`, so the outer `useInput` is disabled and SGR mouse tracking is suppressed while it (and its title/description phases) is mounted.

**Inline flows** (never leave the dashboard):

- **Commit & push** (`C` key): stage confirm → message input via `TextInput` → commit → push. Uses `{ cwd: worktreePath }` for all git operations (not `git -C`).
- **PR creation** (`c` key): choose fill/web → push → create via `gh pr create`. Fill mode uses `--fill --base --head` flags.
- **Diff overlay** (`v` key): full-area split — file tree (left) + colored diff content (right). Uses `git merge-base <base> HEAD` so upstream-only commits are excluded (matches GitHub PR diff). `computeDiffLayout()` in `DiffOverlay.tsx` is shared between rendering and the dashboard's mouse handler so click coordinates map to the same row→file mapping the renderer uses. When `SANTREE_DIFF_TOOL` is set, file content is piped through that tool and rendered with raw ANSI passthrough (Ink supports ANSI in `<Text>` content); otherwise lines are colorized manually based on `+`/`-`/`@@` prefixes.

**Multiplexer-launched flows** (open new windows/workspaces in the active multiplexer — see [Multiplexer abstraction](#multiplexer-abstraction-libmultiplexer)):

- **Work** (`w` key): opens mode-select overlay → launches `st worktree work` in a new window
- **Fix PR** (`f` key) and **Review PR** (`r` key): launch `st pr fix`/`st pr review` in a new window

**Data fetching**: `loadDashboardData()` calls `getIssueTracker(repoRoot).listAssigned(repoRoot)` and enriches each issue with worktree info (git status, commits ahead, session ID, **diff shortstat vs merge-base**), PR info, checks, and reviews — all in parallel via `Promise.all`. Auto-refreshes every 5 minutes (each refresh fans out into several GraphQL-backed `gh pr view`/`gh pr checks` calls per PR; the interval is spaced to stay within GitHub's hourly GraphQL rate limit). `getDiffShortstatAsync()` in `lib/git.ts` runs `git diff --shortstat $(git merge-base <base> HEAD)`.

**Alt screen lifecycle**: `ensureAltScreen()` enters alt screen before first render. Cleanup in `useEffect` return exits alt screen — `exit()` triggers unmount which triggers cleanup (do not write escape sequences before `exit()` or Ink's final render leaks to normal buffer).

## Key Patterns

- **Branch naming**: depends on the active tracker. Linear uses `{prefix}/{TICKET-ID}-description` (e.g., `feature/TEAM-123-auth`). GitHub Issues requires an explicit prefix to avoid false positives — `feature/issue-42-auth`, `gh-42-auth`, or `42-auth`.
- **Ticket ID extraction**: `extractTicketId(branch)` delegates to the active tracker's regex. Linear: `[A-Z]+-\d+` (uppercased). GitHub: `(?:#|gh-|issue-)(\d+)` or `(?:^|/)(\d+)(?:-|$)`.
- **Error resilience**: commands degrade gracefully when integrations (gh, the active tracker's API) are unavailable.
- **Prompt-driven AI**: Nunjucks templates in `prompts/` generate context-rich prompts passed to Claude CLI. `prompts/ticket.njk` is tracker-agnostic — it reads `state.name`, `priorityLabel`, and a `trackerName` injected by `renderTicket()`.

## Environment Variables

| Variable | Effect |
|---|---|
| `SANTREE_TRACKER` | Override the active issue tracker for a single invocation: `linear`, `github`, or `local`. Takes precedence over the per-repo `_tracker.kind`. If unset, the factory falls back to repo config → legacy `_linear.org` → auto-detect (any Linear creds → Linear, else GitHub). |
| `SANTREE_DIFF_TOOL` | Diff pager for `worktree diff` (CLI) and the dashboard `[v]` overlay. CLI passes `-c core.pager=<tool>` to git (the pager handles render + scroll, as usual). The dashboard captures `git diff --color=always \| <tool>` stdout as a string and handles scrolling itself in Ink — the pager's render half is what we want there, the scroll half is bypassed. Validated against `[A-Za-z0-9_\-/.+]` in `getDiffTool()` to keep the spawn arg surface tight. |
| `SANTREE_THEME` | Dashboard color theme: `light`, `dark`, or `auto` (default). In auto mode, `detectTerminalTheme()` in `lib/dashboard/theme.ts` queries the terminal background via OSC 11 (`\x1b]11;?\x07`), parses the RGB response, and picks light/dark by Rec. 709 luminance. Re-runs alongside `loadDashboardData()` on every refresh so theme switches propagate within ~5 minutes (or sooner on a manual `R`). Falls back to `dark` on non-TTY or 150ms timeout. Affects `selectionBg` (only theme-sensitive style — terminal-native foreground colors render correctly on either background). |
| `SANTREE_EDITOR` | Editor used by `e` (open in editor) actions in the dashboard. Defaults to `code`. |

Santree launches Claude with `--permission-mode auto` for implement runs and `--permission-mode plan` for plan-mode runs (`st worktree work --plan`). Auto-acceptance of non-mutating tools while planning is governed by Claude Code's `useAutoModeDuringPlan` setting in `~/.claude/settings.json`, not by santree. There is no opt-in env var — worktree-scoped automation is the default. Set `--permission-mode default` upstream if you ever need stricter prompting.

## External Dependencies

Required: Node.js >= 20, Git, GitHub CLI (`gh`), Claude Code CLI (`claude`)
Optional:
- A terminal multiplexer for new-window flows — tmux (default, all platforms) or cmux (experimental, macOS-only; limited by [manaflow-ai/cmux#1472](https://github.com/manaflow-ai/cmux/issues/1472))
- `git-delta` (or any unified-diff pager) — used by `worktree diff` and the dashboard `v` overlay when `SANTREE_DIFF_TOOL` is set. `santree doctor` reports its presence.

### Issue tracker setup

Each repo picks one tracker. Pick once with `santree issue switch <linear|github|local>`, the interactive `santree issue setup`, or the dashboard's `t` overlay; or let one of the auth commands set it as a side effect.

**Local (built-in)** — no auth, no SaaS. `santree issue switch local` (or pick "Local" in `issue setup` / the dashboard). Issues live as version-controlled Markdown files in `.santree/issues/LOCAL-<n>.md`. Create/edit/delete from the dashboard Issues tab (`n`/`e`/`d`); CLI CRUD is not exposed yet (dashboard-only by design). Start work with `w` exactly like Linear/GitHub issues — the branch is `feature/LOCAL-<n>-<slug>`.

**Linear** — OAuth PKCE + GraphQL. Run `santree linear auth` to authenticate (opens browser, stores tokens in `$XDG_CONFIG_HOME/santree/auth.json`, defaults to `~/.config/santree/auth.json`), and links the org to the current repo. Ticket data (title, description, comments, images) is injected into prompts before launching Claude. Auth tokens auto-refresh; images are downloaded to `/tmp/santree-images-{ticketId}/`. `listAssigned` excludes `completed`/`canceled`-type states (in the GraphQL filter) plus any state whose **name** is in `HIDDEN_STATE_NAMES` (`lib/trackers/linear/api.ts` — currently `"duplicate"`, matched case-insensitively): Linear's default "Duplicate" resolution state is often typed non-terminal in a workspace, so it leaks past the type filter and would otherwise clutter the backlog.

**GitHub Issues** — uses the existing `gh` CLI (no separate OAuth). Run `santree github auth` to verify `gh auth status` and flip the repo's `_tracker.kind` to `github`. The dashboard then lists `gh search issues --assignee=@me --state=open --repo <owner>/<name>`. Priority is derived from labels (`P0`/`P1`/`urgent`/`high`/etc.); attached images are downloaded from `user-images.githubusercontent.com` / `github.com/.../assets/`. Cross-repo issues are not surfaced — scope is the current repo.
