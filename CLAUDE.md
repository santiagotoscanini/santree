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
│   ├── claude-config.ts # Shared read/detect/configure for ~/.claude/settings.json (statusline) + ~/.claude.json (remote control); used by `santree config` (both the `--check` report and the panel) so detect and apply can't disagree
│   ├── setup/           # `santree config` engine: shell-config.ts (managed-block rc writer), claude/tools/gitignore detect+apply, steps.ts catalog, apply.ts (TTY hand-off)
│   ├── config-store.ts  # Global prefs store `~/.config/santree/config.json` (editor, diffTool); `getConfiguredEditor()`/`getConfiguredDiffTool()` resolve env override → file. NOT shell env exports
│   ├── config/          # `santree config` panel internals: diagnostics.ts (read-only checks → InfoRow), TrackerPicker.tsx (inline tracker drill-in)
│   ├── prompts.ts       # Nunjucks template renderer for AI prompts
│   ├── claude-todos.ts  # Reads Claude Code's per-session todo file (~/.claude/todos/<session>-agent-<id>.json) + findClaudeSessionCwd(); feeds the dashboard DetailPanel "Tasks" section
│   ├── version.ts       # santree + Claude Code freshness checks (per-package cache); powers `santree update` and the dashboard/config update banners
│   ├── trackers/        # Issue tracker abstraction (Linear, GitHub Issues, Local)
│   │   ├── types.ts     # IssueTracker interface + generic Issue/AssignedIssue/Comment/AuthStatus
│   │   ├── index.ts     # getIssueTracker(repoRoot) factory + setRepoTracker/readTrackerConfig
│   │   ├── config.ts    # Per-repo `_tracker.kind` r/w (with legacy `_linear.org` migration)
│   │   ├── auth-store.ts # Versioned ~/.config/santree/auth.json (v1 Linear-flat → v2 namespaced)
│   │   ├── linear/      # OAuth PKCE + GraphQL queries + image rewriter
│   │   ├── github/      # `gh` CLI / REST wrappers; priority derived from labels
│   │   └── local/       # Built-in file-based tracker (.santree/issues/LOCAL-<n>.md); hand-rolled frontmatter, monotonic IDs, canMutate
│   └── dashboard/       # Dashboard UI components
│       ├── types.ts     # State types, action types, phase enums
│       ├── IssueList.tsx # Left pane — issue list with nested detail sub-rows (diff/pr/session); `variant` swaps the right column: WT/CI (Trees) / SLA countdown (triage) / readiness (issues)
│       ├── DetailPanel.tsx # Right pane — issue detail, git status, context-aware actions; `triage` mode shows SLA countdown + comment thread (and drops the redundant Triage status pill)
│       ├── sla.ts        # formatSla()/isSnoozed() — urgency-coded SLA-countdown badge + snooze detection for the Triage tab
│       └── DiffOverlay.tsx # Inline diff overlay — file tree + diff content (full-area)
└── commands/            # One React component per CLI command
    ├── config.tsx        # Top-level: the single inspect-and-configure panel (replaces doctor/setup/tracker). Read-only diagnostics + live per-row apply + inline tracker picker; `--check` (flat report), `--yes`, `--dry-run`
    ├── dashboard.tsx     # Top-level: interactive dashboard (alt screen, mouse, inline flows)
    ├── worktree/         # santree worktree {create,list,switch,remove,clean,sync,work,open,setup,commit,diff}
    ├── pr/               # santree pr {create,open,fix,context,review}  (fix = self-driving loop; --signal heartbeat; context prints the fix brief)
    ├── linear/           # santree linear {auth} — Linear OAuth + --status/--logout/--test
    ├── issue/            # santree issue {open} — tracker-agnostic issue actions
    ├── update.tsx        # santree update — self-update + version check (see lib/version.ts)
    └── helpers/          # santree helpers {statusline,squirrel,template,text-editor}
prompts/                 # Nunjucks templates: work, review, fix-pr, fix-loop, fix-context, fill-pr, fill-commit, diff, pr, ticket, ask
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

### Entering worktrees (no shell integration)

santree is a plain binary — there is **no `santree` shell function, alias, or hook**, so `which santree` resolves to the binary. A child process can't `cd` its parent shell, so when a CLI command wants you to land in a worktree it **prints the command** for you to run. `lib/cd-hint.ts` is the single source: `formatCdCommand({ path, work? })` returns `cd '<path>' [&& santree worktree work …]` (path + context-file single-quoted, flags literal); `worktree/create` and `worktree/switch` render it in their Ink output, and the dashboard's non-multiplexer fallback prints it via `printCdHint()` after leaving the alt screen.

The dashboard is the primary surface, and with tmux/cmux active its switch/work/fix/review flows open a **new multiplexer window** already in the right directory (via `getMultiplexer().createWindow`) — no parent-shell cd needed, so the print path only matters for direct CLI use and the no-multiplexer dashboard fallback. Window commands invoke `santree …` (not an alias).

### Config panel (`commands/config.tsx` + `lib/config/` + `lib/setup/`)

`santree config` is the **single inspect-and-configure surface** — it replaces the old `doctor`, `setup`, and `tracker` commands (those files no longer exist). It is a live settings panel: every line is one **Row**, and each row applies **immediately** when you change it (no stage-then-commit). Flags: `--check` prints a flat, non-interactive, doctor-style report (exit 1 if a required item is missing); `--yes` applies all recommended `file`-kind steps non-interactively; `--dry-run` previews via `ctx.dryRun` (writes nothing).

**Row kinds** (`config.tsx`):
- **info** — read-only diagnostics santree can report but not change (santree/node/git versions + update-available, active multiplexer, workspace editor). Built by `lib/config/diagnostics.ts` (`loadDiagnostics()` → `InfoRow[]` + a `stepDetail` map that enriches the gh/claude/tracker rows with version/auth lines without the catalog doing network I/O). Not selectable — the cursor skips them.
- **toggle** — binary on/off (statusline, remote-control, gitignore). `Space`/`Enter` applies/unapplies.
- **select** — drill into a sub-menu of `options` (editor, diff tool), pick → apply.
- **action** — a `spawn` step run on `Enter` (install gh/claude/tmux). `spawnTTY` owns the terminal during the run.
- **tracker** — the repo's issue tracker, handled by the inline `lib/config/TrackerPicker.tsx` (Local/Linear/GitHub + Linear-org sub-menu + OAuth) instead of spawning a subprocess. `←`/`Esc` backs out.

Rows come from two sources merged + sorted by `ROW_ORDER` into three sections (**System / Global / This repo**): the **configurable** steps from `buildSteps()` (the `SetupStep` catalog in `lib/setup/steps.ts`) and the **info** rows from diagnostics. The catalog drives a step's `kind` mapping: `unapply` present → toggle, `options` present → select, otherwise `ok`→info / `actionable`→action; the `tracker` step is special-cased to the inline picker (its `apply` is inert). `SetupStep` itself still has `detect: "ok" | "actionable" | "unavailable"` (unavailable rows are dropped), `kind: "file" | "spawn"`, `options`/`optionPrompt`, `apply(choice)`, and an optional `unapply(choice)`. `unapply` exists only on config santree fully owns and can cleanly reverse: statusline (`removeStatusline`), remote control (`disableRemoteControl`), and gitignore entries (`removeIgnoreEntries`) — a row without `unapply` simply has no "off". The editor + diff-tool rows write to santree's **global config file** (`lib/config-store.ts` → `~/.config/santree/config.json`), NOT shell env exports — so the change takes effect on the next run with no shell restart; the matching `SANTREE_EDITOR`/`SANTREE_DIFF_TOOL` env vars still win as a one-off override. Those two plus installs, logins, the scaffold, and tracker selection are one-way (no `unapply`). All apply/unapply paths honor `ctx.dryRun` (return a "would…" message, write nothing). After any apply the panel rebuilds rows from the catalog (and re-runs diagnostics after a spawn install to refresh versions).

- **`lib/setup/shell-config.ts`** — the rc writer. `resolveShellConfig()` is ZDOTDIR/XDG-aware (zsh → `$ZDOTDIR/.zshrc`, bash → `~/.bashrc`). Everything santree writes goes in ONE managed block (`# >>> santree >>>` … `# <<< santree <<<`); each line is tagged `# santree:<key>` so `upsertManagedLine()` replaces in place (idempotent re-runs, never duplicates). `isEnvVarSet()` scans the user's config **minus** santree's own block, so we never re-offer (or clobber) an export the user hand-maintains in `.zshenv`.
- **`lib/setup/tools.ts`** — `detectDiffPagers()`/`detectEditors()` (probe PATH) + `getInstaller()` (macOS+brew today; `PlatformInstaller` seam for apt/dnf later).
- **`lib/setup/gitignore.ts`** — writes the SPECIFIC entries (`.santree/worktrees/`, `metadata.json`, `fix-loops/`), never a blanket `.santree/` (keeps `.santree/issues/` tracked); target is `.gitignore` (shared) or `.git/info/exclude` (local), asked per-repo.
- **`lib/setup/apply.ts`** — `spawnTTY()` reuses the `external-editor.ts` raw-mode hand-off (drop raw mode → `spawnSync` stdio inherit → restore) for `brew install` / `gh auth login` / Claude install.
- **`lib/claude-config.ts`** — single source of truth for the statusline / remote-control detect+configure; both `config`'s `--check` report and its panel go through it. Also home to `pruneSessionSignalHooks()`, a one-time cleanup the interactive panel runs to strip leftover hooks from the removed session-state feature (only entries whose command mentions `session-signal`, leaving every other hook untouched). **santree registers no Claude Code hooks of its own** — it only reads `~/.claude/settings.json` to report/configure the statusline and remote control.

### AI shared logic (`lib/ai.ts`)

Three AI-powered commands share context resolution and prompt rendering:

- `worktree/work.tsx` → implement/plan mode
- `pr/fix.tsx` → fix PR review comments
- `pr/review.tsx` → review changes against ticket

`resolveAIContext()` finds repo, branch, and issue identifier, then fetches the issue from the active tracker (Linear or GitHub — see [Issue tracker abstraction](#issue-tracker-abstraction-libtrackers)). It returns `AIContext` with the issue plus `trackerName`/`issueNoun` so prompt templates and downstream code don't hardcode a vendor name. `renderAIPrompt()` renders a named Nunjucks template with context. `launchAgent()` spawns the Claude CLI. `fetchAndRenderPR(branch)` and `fetchAndRenderDiff(branch)` pre-fetch structured PR feedback and diff data for injection into prompts. `fetchAndRenderFixContext(branch)` renders the compact per-iteration brief the auto-fix loop consumes — conflict status (via `getPRMergeStateAsync`), failing checks tagged fixable/manual (via `classifyCheck`), and the 👍-approved review threads (via `getPRReviewThreadsAsync` + `getApprovedReviewThreads`), all in `lib/github.ts`.

### Auto-fix loop (`pr fix`)

`santree pr fix` is **one flow**: a **self-driving Claude Code `/loop`** (`prompts/fix-loop.njk`) that handles CI failures *and* review comments in the same loop — there's no separate one-shot "fix comments" mode. (`--loop` is still accepted for backward compat — the dashboard passes it — but it's always on; the bare one-shot was removed.) **Critical: invoke `/loop` WITHOUT an interval** (`/loop <prompt>`, not `/loop 5m …`). No-interval `/loop` is the *self-paced* mode (driven by `ScheduleWakeup`) that keeps context across iterations and genuinely stops on our conditions; passing an interval picks *cron mode* (`CronCreate`, fire-and-forget, fresh context each firing, won't self-terminate) — wrong for a fix loop.

**`pr context` is the brain; the loop prompt is a thin wrapper.** `fix-loop.njk` is deliberately minimal — it only encodes loop *mechanics* (run `pr context`, do exactly what it says, schedule next ~5 min or stop, and the "tried a fix twice → stuck" judgment the stateless command can't track). All per-iteration *logic* lives in `santree pr context` (`commands/pr/context.tsx` → `fetchAndRenderFixContext` → `prompts/fix-context.njk`), regenerated fresh each iteration so it can't drift in the agent's context. The brief reports state (conflicts via `getPRMergeStateAsync`, failing checks tagged fixable/manual via `classifyCheck`, the 👍-approved review threads) **and** a single computed `directive` — `merge` (conflicts) → `work` (fixable CI and/or approved comments) → `wait` (nothing to do, CI still running or mergeability `UNKNOWN`) → `stop-stuck` (only manual failures) → `stop-clean` (all done), in that priority — rendered as an "➡️ Do this now" section with the exact commands (including which `--signal` to send). `fetchAndRenderFixContext(branch, santreeCmd)` and `pr context` both compute the **absolute santree invocation** (`santreeSelfArgv`) embedded in those commands, because the loop's shell may not have `santree` on PATH. `pr fix --signal <status>` is the loop's heartbeat hook — it updates the dashboard marker (see below) and exits fast (offline ticket resolution, no tracker fetch). `pr context` is a no-Ink stdout command (like `statusline`).

**Review comments are 👍-gated** (`getPRReviewThreadsAsync`/`getApprovedReviewThreads` in `lib/github.ts`). The loop only applies a review thread when it is **unresolved** AND its **last comment carries a 👍 (`THUMBS_UP`) from the viewer** (`getViewerLoginAsync` — the PR owner's own approval). Resolved threads are skipped entirely (resolved = applied or declined); unapproved threads wait for a 👍 — this stops the loop from applying comments the instant they're left, before the owner has vetted them. Thread resolution state + reactions aren't in the REST comments endpoint, so `getPRReviewThreadsAsync` uses a GraphQL query (`reviewThreads{ isResolved isOutdated path line comments{ … reactions } }`). `fetchAndRenderFixContext` renders only the approved threads (with their GraphQL `id`); the loop applies each, pushes, then **resolves the thread** via `gh api graphql … resolveReviewThread` so it doesn't reappear next iteration.

**Fixable vs manual** (`classifyCheck` in `lib/github.ts`): a check whose name/workflow looks like a test/typecheck/linter/formatter/coverage job is `fixable`; deploys, releases, image builds, e2e, security scans (and **anything unknown**) are `manual`. Manual-first ordering keeps "integration tests" manual. The lists are exported regexes — extend them like `HIDDEN_STATE_NAMES`.

**Marker + dashboard** (`lib/fix-loop.ts`): each loop writes `.santree/fix-loops/<ticketId>.json` (`{ status, intervalMin, startedAt, at }`) and heartbeats it. Staleness is **timestamp-based**: a `running` marker not seen for ~2.5× the interval reads as `stalled`. `readFixLoopRuntime` derives a `FixLoopPhase` (`running`/`stalled`/`stopped-clean`/`stopped-stuck`). `.santree/fix-loops/` is gitignored (machine-local). The dashboard reads markers in `loadDashboardData` → `DashboardIssue.fixLoop`, reconciled into `state.fixLoopTickets` by `SET_DATA`; `f` seeds it optimistically (`FIXLOOP_START` + a marker write) so the badge appears instantly. `IssueList` shows a `⟳` in the CI column while running/stalled (the loop owns that column then); `DetailPanel` shows a "⟳ fix loop" status line.

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
2. Per-repo `_tracker.kind` in `.santree/metadata.json` — set by the tracker row in `santree config` (its inline `TrackerPicker`) or the dashboard's `t` tracker-select overlay (same picker logic), or as a side effect of `santree linear auth`. There is no non-interactive switch command — use `SANTREE_TRACKER` for one-off overrides.
3. Legacy `_linear.org` (no `_tracker.kind`) — treated as `kind: "linear"` so existing repos keep working.
4. Auto-detect: any Linear creds in `~/.config/santree/auth.json` → Linear, else GitHub (since `gh` is a hard dep).

`isRepoTrackerConfigured(repoRoot)` reports whether any *explicit* signal exists (1–4 minus the GitHub fallback). The dashboard uses it to show the tracker-selection flow on first run instead of dead-ending on an auth error; it does not change `getIssueTracker`'s fallback.

The `IssueTracker` interface (`lib/trackers/types.ts`) exposes: `kind`, `displayName` ("Linear"/"GitHub"/"Local"), `issueNoun` ("ticket"/"issue"), `getAuthStatus(repoRoot)`, `signOut(repoRoot)`, `extractIdFromBranch(branch)`, `cleanupCache(id)`, `listAssigned(repoRoot)`, `getIssue(id, repoRoot)`. Read methods return `IssueTrackerResult<T>` (`{ ok: true, value } | { ok: false, reason: "unauthenticated"|"not-found"|"network", message? }`). Optional **mutation** capability — `canMutate?: true` plus `createIssue`/`updateIssue`/`deleteIssue` — is implemented only by the Local tracker; UI gates CRUD on `tracker.canMutate === true` (feature-detect, never a `kind === "local"` check). A second optional capability flag — `supportsTriage?: true` — marks trackers with a triage inbox (Linear only); the dashboard's Triage tab is gated on it the same way. A related optional method — `getTriageSchedules?(repoRoot): Promise<TriageSchedule[]>` — returns the viewer's triage on-call rotations (Linear maps its "Triage responsibility" `timeSchedule.entries` → `TriageShift[]`, resolving entry `userId`s to names via a `users` query; never throws, `[]` on failure). Use `getIssueTracker(repoRoot)` from `lib/trackers/index.js` at every call site — never reach into a concrete tracker module.

**Local tracker** (`lib/trackers/local/`) — one Markdown file per issue at `.santree/issues/LOCAL-<n>.md` (YAML-ish frontmatter via the hand-rolled `frontmatter.ts`; no YAML dep). `.santree/issues/` is **not** gitignored, so issues are version-controlled by default — do not add it to `.gitignore`. IDs are monotonic and never recycled: `allocateId()` persists a high-water mark in `_local.lastId` in metadata.json (git-ignored / per-machine, which is the right scope — the collision avoided is with stale *local* `feature/LOCAL-<n>-*` worktrees; a fresh clone rebuilds the counter from committed files). No auth, no comments in v1 (`comments: []`). Branch regex: `/(?:^|[/_-])local-(\d+)(?:-|$)/i` → `LOCAL-<n>`, compatible with the dashboard's `feature/${ticketId}-${slug}` builder.

**Generic data shape** — `Issue`/`AssignedIssue` carry the union of fields actually consumed by UI + prompts: `identifier`, `title`, `description`, `url`, `priority` (number), `priorityLabel`, `state: { name, type }`, `labels`, `projectId`, `projectName`, and optional `slaBreachesAt`/`snoozedUntilAt` (ISO timestamps; only trackers with a native triage-SLA / snooze concept set them — Linear today; surfaced on the Triage tab as a countdown badge and a greyed/sunk snoozed row), plus optional `blockedBy`/`blocking` (`IssueRef[]` — dependency relations; Linear maps `inverseRelations`/`relations` of type `"blocks"`, each connection bounded `first: 10` to stay under Linear's 10k query-complexity cap; `undefined` when the tracker doesn't expose relations). `issueReadiness(blockedBy)` (in `trackers/types.ts`) → `"ready"|"blocked"|"unknown"`: ready = every blocker `done` (state.type completed/canceled). Each tracker maps its native API to that shape: GitHub derives priority from `P0`/`P1`/etc. labels, projectName from `repository.nameWithOwner`. Adding a third tracker = one new directory under `lib/trackers/`, one entry in the `IssueTrackerKind` union, one branch in `getIssueTracker()`. Nothing else changes.

**Auth file** — `~/.config/santree/auth.json` is versioned. v1 (`{[orgSlug]: LinearTokens}`) is migrated to v2 (`{ version: 2, linear: {...}, github: {} }`) on first read. The `github` namespace is reserved (the `gh` CLI owns its own token; santree never writes it).

**No `if tracker.kind === "linear"` outside the factory.** Vendor names appear in user-facing strings only when (a) the active tracker's `displayName` flows in (e.g. dashboard's `[o]` action key labelled "Linear" or "GitHub" depending on the repo), (b) a command is explicitly named after the backend (`santree linear auth`), or (c) `santree config` (its `--check` report or panel) is reporting which backend is active. Every other surface speaks generically ("issue", "tracker").

### Multiplexer abstraction (`lib/multiplexer/`)

Santree supports pluggable terminal multiplexers (currently tmux and cmux; zellij planned). Selection is fully auto-detected — `getMultiplexer()` iterates over the adapter list and picks the first whose `isActive()` returns true (tmux: `$TMUX` set; cmux: `$CMUX_SURFACE_ID` set), falling back to the no-op `noneMultiplexer`. Each adapter owns its own detection; there is no env-var override.

The `Multiplexer` interface (`lib/multiplexer/types.ts`) exposes: `isActive()`, `createWindow({name, cwd, command, group?, tabName?})`, `addTab({windowName, tabName, cwd, command, group?})`, `selectWindow(name)`, and `sendCommand(name, command)`. All ops return a `SessionResult` (`{ ok: true } | { ok: false, reason, message? }`). Use `getMultiplexer()` from `lib/multiplexer/index.js` at call sites. Window names are set once at creation and not touched afterwards, so user-set names stick; `tabName` (cmux) names the initial tab/surface after creation.

**`addTab` — second tab in the same workspace (cmux).** `addTab` adds a tab running `command` to the *existing* workspace named `windowName`, so e.g. the fix loop lands as a `fix-loop` tab next to the `work` tab in the ticket's workspace instead of a separate window. The cmux mechanism works around the [#1472](https://github.com/manaflow-ai/cmux/issues/1472) dead-PTY limit (a surface only runs its command when that command is baked in at workspace creation): it spawns the command in a **throwaway workspace** via `new-workspace --command` (live PTY), then `move-surface`s the already-running surface into the target workspace's pane, closes the drained husk, and `rename-tab`s it. Falls back to `createWindow` when the target workspace doesn't exist yet. **tmux** has no in-workspace tab concept, so `addTab` creates a separate window named `<tabName>-<windowName>` (e.g. `fix-loop-TEAM-123`); **none** is a no-op. The cmux group helpers (`createGroup`/`placeWorkspaceInGroup`) and tab helpers (`paneSurfaces`/`renameTab`) live in `lib/multiplexer/cmux.ts`; groups are sidebar folders keyed by Linear project name (see [Dashboard](#dashboard-commandsdashboardtsx) flows), created via the RPC socket (`cmux rpc workspace.group.*`).

**cmux is the suggested multiplexer** (deepest Claude Code integration — it bundles a wired-up Claude CLI, see below). tmux is fully supported and is the cross-platform / auto-installable fallback. **cmux caveat**: cmux is macOS-only and requires the cmux.app GUI running. Upstream issue [manaflow-ai/cmux#1472](https://github.com/manaflow-ai/cmux/issues/1472) — programmatically created workspaces have dead PTYs, so `sendCommand` returns `unsupported`. The blast radius is narrow: `sendCommand` is called in exactly one place (`dashboard.tsx` resume/re-launch into an *already-open* window), which degrades to "focus the window + print the command to run manually". New-window flows bake the command into `createWindow` and work normally. **Verified (2026-06-12)**: cmux's CLI is rich (`window > workspace > tab/surface > pane`; `new-surface`, `tab-action`, `send`/`send-key`), but a **CLI-created surface/tab never gets a live PTY** — `send`/`read-screen` reject it with "Surface is not a terminal" (tried no-focus, focus, 4s wait, `respawn-pane`). The **only** CLI path that yields a working PTY+command is `new-workspace --command` (proven). So santree launches per-ticket flows (work / fix loop) as a **new workspace named after the ticket**, not as a tab in an existing one — `createWindow`'s cmux path already does `new-workspace --command`. Don't try to add command-running tabs to an existing workspace via the CLI; it can't be done today. `santree config --check` reports cmux state without flagging it as broken.

**cmux-bundled Claude**: cmux ships its own Claude CLI at `/Applications/cmux.app/Contents/Resources/bin/claude`, wired to the active cmux workspace ([cmux#2048](https://github.com/manaflow-ai/cmux/issues/2048)). When `getMultiplexer().kind === "cmux"`, `resolveClaudeBinary()` in `lib/ai.ts` returns the bundled path first; otherwise it falls back to `which claude` then `~/.claude/local/claude`. This single resolver feeds interactive launches, `getInstalledClaudeVersion()` (header + update checks via `lib/version.ts`), and the diagnostics' Claude row (labelled "Claude Code CLI", path shown). `resolveAgentBinary()` is now a `@deprecated` thin alias for `resolveClaudeBinary()` — use `resolveClaudeBinary()` for any new code that needs the binary path.

### Statusline (`commands/helpers/statusline.tsx`)

Special command — no Ink UI. Reads JSON from stdin (Claude Code statusline hook), writes ANSI-colored text to stdout, then `process.exit(0)`. Detects santree worktrees via path (`/.santree/worktrees/`).

### Dashboard (`commands/dashboard.tsx`)

Full-screen interactive dashboard showing all issues assigned to the user from the active tracker (see [Issue tracker abstraction](#issue-tracker-abstraction-libtrackers)). Runs in the terminal alternate screen with mouse support (click-to-select, drag-to-resize panes, scroll wheel).

**Tabs** (`1`..`N` by number or `Tab` to cycle): an optional **Triage** tab, then **Issues**, **Trees**, **Reviews**. **Triage** = the incoming inbox (issues assigned to you whose `state.type === "triage"` and have no worktree) — shows an urgency-coded SLA-countdown column, the comment thread in the detail pane, `a` to ask Claude a clarifying question about the issue + all its comments (inline one-shot Q&A, read-only), `i` to investigate the ticket (hands it to a per-repo configured skill/prompt in a new multiplexer window — see [Investigate triage ticket](#investigate-triage-ticket)), and `w` to send it to a tree (same worktree-creation flow as Issues). The Triage tab only appears when the active tracker has a triage concept, gated on `tracker.supportsTriage` (feature detection — Linear sets it; GitHub/Local don't). **Issues** = backlog/planning (tracker issues with no worktree; supports `n`/`e`/`d` create/edit/delete when `tracker.canMutate`, and `w` to start work which creates a worktree and moves the row to Trees), **Trees** = worktrees in progress (issues that have a worktree, plus the synthetic Main-repo row and orphaned worktrees; commit/PR/fix/diff/remove live here), **Reviews** = PRs awaiting your review. `loadDashboardData` partitions one enriched pass into `flatTriage`/`triageGroups` (triage inbox), `flatIssues`/`groups` (backlog), and `flatTrees`/`treeGroups` (work in progress); each tab has its own selection/scroll slices in `DashboardState`, plus a per-issue `triageCommentsById` cache lazily filled from `getIssue` on selection. `tabOrder` (and the numeric keybinds) is built from `supportsTriage`, so tab numbering shifts when Triage is present. When no tracker is configured (`!isRepoTrackerConfigured`), the `tracker-select` overlay (also reachable anytime via `t`) appears instead of the error screen — Local enters immediately, Linear picks an authenticated workspace, GitHub verifies `gh`.

The Triage **SLA-countdown** badge is rendered by `formatSla()` in `lib/dashboard/sla.ts` (Linear's `slaBreachesAt`: breached/<24h → red, <48h → yellow, else gray; format like Linear's own `2d 23h`/`13h`/`45m`) — shown right-aligned in the issue list (`IssueList` `variant="triage"` swaps the WT/CI columns for it) and as a line in `DetailPanel` (`triage` prop hides worktree/PR/checks, drops the redundant Triage status pill, and shows the comment thread instead). Snoozed issues (`isSnoozed()` on `snoozedUntilAt`) are greyed and sorted to the bottom of the list so active work stands out. The Triage tab is scoped to issues **assigned to the viewer** (it's built from the same `listAssigned` pass as the other tabs), and its list is one flat group under an "Assigned to me" header — no project grouping, no per-status sub-header (the empty `StatusGroup.name` makes `buildIssueListRows` skip it). The ask flow renders `prompts/ask.njk` via `askTicketQuestion()` in `lib/ai.ts` (grants read-only `Read`/`Grep`/`Glob` so Claude can judge fixability against the code); the `triage-ask` overlay has `input`→`running`→`answer`/`error` phases.

**Issue readiness (dependencies)**: the Issues tab uses `IssueList` `variant="issues"`, whose right column is a `RDY` glyph from `issueReadiness(issue.blockedBy)` — `✓` green (ready, no open blockers) / `⊘` yellow (blocked) / `·` gray (no dependency data). `DetailPanel` renders a **Dependencies** section (blocked-by with each blocker's done/open state, and what the issue blocks) with a ready/blocked badge in the header. Data is Linear-only (`blockedBy`/`blocking` on the issue).

**Investigate triage ticket**: `i` on the Triage tab launches a Claude investigation of the selected ticket in a new multiplexer window. The invocation is configured per-repo in `.santree/metadata.json` under `_triage` (gitignored, so it's per-machine — each dev points it at their own skill/prompt without committing it): `skill_name` runs `/<skill_name> <ticketId>` (e.g. `"investigate-ticket-live"` → `/investigate-ticket-live TEAM-123`), or `prompt` is a free-form template with `{ticket_id}` substituted. `skill_name` wins when both are set. Config read/prompt-building live in `lib/triage-config.ts` (`readTriageInvestigateConfig`/`buildInvestigatePrompt`/`buildInvestigateCommand`); the window runs `<resolveClaudeBinary()> '<prompt>'` with `cwd` = main repo root so Claude can read the codebase and use the repo's MCP servers. When unconfigured the `[i]` action renders greyed and pressing it prints a hint; the configured flag is read fresh on every dashboard refresh (so manual `metadata.json` edits propagate within a cycle), while the keypress itself re-reads the file so a launch always honors the latest config. Requires an active multiplexer (tmux/cmux) — there's no inline fallback.

**Triage on-call schedule**: `s` on the Triage tab opens the `triage-schedule` full-area overlay (`TriageScheduleOverlay`) listing the viewer's Linear triage rotations — each shift's date range + resolved name, current shift and the viewer's own shifts highlighted. Data comes from `tracker.getTriageSchedules()` (fetched best-effort on every refresh into `state.triageSchedules`); `DetailPanel` also shows a compact `onCall` line at the top in triage mode (current on-call + the viewer's next shift). Works with an empty inbox.

**Worktree deletion** is concurrent and non-blocking: confirming `d` fires `removeWorktreeWithProgress()` without awaiting, so you can confirm several removals back-to-back. Each is tracked in `state.deletingTickets` (a `ticketId → DeleteStatus { logs, phase, error }` map) — `removeWorktree(branch, root, force, onProgress)` streams staged messages ("Removing worktree…" / "Cleaning up…" / "Deleting branch…" / "Done") into the entry, which `DetailPanel` renders (`deleteStatus` prop) when that row is selected, and `IssueList` marks with a `⌫` glyph in the WT column (`deletingIds` prop). `SET_DATA` prunes entries whose worktree is gone (successful removal), so in-progress and failed (`error`) deletions stay visible until resolved.

**Optimistic PR creation** mirrors that pattern. After `gh pr create` succeeds, `PR_CREATE_DONE` immediately attaches a placeholder `PRInfo` (number parsed from the returned URL, `state: "OPEN"`) to the just-created ticket's `flatTrees` row and records it in `state.pendingPrs` (a `ticketId → PRInfo` map) — so the `[p] Open PR` action and PR section appear instantly instead of after the next 5-min refresh. Only that one ticket is affected; every other PR keeps its already-loaded data. `DetailPanel` shows a "⟳ loading checks & reviews…" line for it (`prSyncing` prop). `SET_DATA` reconciles: once a refresh surfaces the real PR the pending entry is dropped; if the refresh ran before GitHub indexed the PR (real `pr` still null) the placeholder is preserved and stays pending.

**Layout**: Two-pane split — left pane (`IssueList`) shows issues grouped by project. Each issue with a worktree expands into one or more nested **detail sub-rows** below its title (`· diff`, `· pr`, `· session`); issues without worktrees stay as a single row. The shared row builder `buildIssueListRows()` is exported from `IssueList.tsx` and used by both the renderer and the dashboard's mouse-click row→issue mapper, so click coordinates always resolve to the correct parent issue (sub-rows resolve to the parent's `flatIndex`). Right pane (`DetailPanel`) shows issue detail with description, git status, PR info, checks, reviews, and context-aware actions.

**State management**: `useReducer` with `DashboardState`/`DashboardAction` (defined in `lib/dashboard/types.ts`). Right-pane overlays (`mode-select`, `confirm-delete`, `commit`, `pr-create`) replace just the right pane; full-area overlays (`context-input`, `triage-ask`, `diff`, `base-select`, `confirm-setup`, `tracker-select`, `issue-form`, `confirm-delete-issue`) replace the entire content area below the tab bar. `issue-form` reuses `MultilineTextArea` in two steps (title → description, Ctrl+D advance/save, Ctrl+G cancel) like `context-input`, so the outer `useInput` is disabled and SGR mouse tracking is suppressed while it (and its title/description phases) is mounted.

**Inline flows** (never leave the dashboard):

- **Commit & push** (`C` key): stage confirm → AI-drafts a message via `fillCommitMessage()` (renders `fill-commit.njk` with ticket + diff, seeded via `COMMIT_MESSAGE`) → user edits it in `TextInput` → commit → push. Uses `{ cwd: worktreePath }` for all git operations (not `git -C`); the commit itself runs via `execFileAsync("git", ["commit", "-m", msg])` (array args, no shell — the message is user-typed). The CLI equivalent is `worktree commit --fill`.
- **PR creation** (`c` key): choose fill/web → push → create via `gh pr create`. Fill mode uses `--fill --base --head` flags.
- **Diff overlay** (`v` key): full-area split — file tree (left) + colored diff content (right). Uses `git merge-base <base> HEAD` so upstream-only commits are excluded (matches GitHub PR diff). `computeDiffLayout()` in `DiffOverlay.tsx` is shared between rendering and the dashboard's mouse handler so click coordinates map to the same row→file mapping the renderer uses. When `SANTREE_DIFF_TOOL` is set, file content is piped through that tool and rendered with raw ANSI passthrough (Ink supports ANSI in `<Text>` content); otherwise lines are colorized manually based on `+`/`-`/`@@` prefixes.

**Multiplexer-launched flows** (open new windows/workspaces in the active multiplexer — see [Multiplexer abstraction](#multiplexer-abstraction-libmultiplexer)):

- **Work** (`w` key): opens mode-select overlay → launches `santree worktree work` in a new window/workspace named `<ticketId>`, with its tab named `work` (cmux).
- **Fix loop** (`f` key): launches `santree pr fix --loop` (the self-driving auto-fix loop — see [Auto-fix loop](#auto-fix-loop-pr-fix---loop)) as a **`fix-loop` tab inside the ticket's workspace** (next to its `work` tab), via the `addTab` primitive, and seeds the `⟳` badge. **Review PR** (`r` key): launches `santree pr review` as a **`review` tab** in the ticket's workspace (same `addTab` primitive). All per-ticket agent flows (`work`/`fix-loop`/`review`) land as tabs in the one `<ticketId>` workspace on cmux; investigate (triage, no worktree yet) still opens its own window.

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
| `SANTREE_DIFF_TOOL` | One-off **override** for the diff pager used by `worktree diff` (CLI) and the dashboard `[v]` overlay. The persistent value lives in `~/.config/santree/config.json` (`diffTool`, set from `santree config`); this env var wins when set. CLI passes `-c core.pager=<tool>` to git (the pager handles render + scroll, as usual). The dashboard captures `git diff --color=always \| <tool>` stdout as a string and handles scrolling itself in Ink — the pager's render half is what we want there, the scroll half is bypassed. Both paths resolve via `getConfiguredDiffTool()` in `lib/config-store.ts`, validated against `[A-Za-z0-9_\-/.+]` to keep the spawn arg surface tight. |
| `SANTREE_THEME` | Dashboard color theme: `light`, `dark`, or `auto` (default). In auto mode, `detectTerminalTheme()` in `lib/dashboard/theme.ts` queries the terminal background via OSC 11 (`\x1b]11;?\x07`), parses the RGB response, and picks light/dark by Rec. 709 luminance. Re-detected and applied **first** on every refresh — before `loadDashboardData()`/`loadReviewsData()` — so the colorscheme (the most visible change) flips immediately on a manual `R` or a light↔dark switch instead of waiting on the slower gh-backed data fetch. Theme switches still propagate within ~5 minutes on the auto-refresh cycle. Falls back to `dark` on non-TTY or 150ms timeout. Affects `selectionBg` (only theme-sensitive style — terminal-native foreground colors render correctly on either background). |
| `SANTREE_EDITOR` | One-off **override** for the editor used by `e` (open in editor) actions and Ctrl+O in text areas. The persistent value lives in `~/.config/santree/config.json` (`editor`, set from `santree config`); this env var wins when set. Resolved via `getConfiguredEditor()` in `lib/config-store.ts`; GUI-open call sites fall back to `code`, in-terminal editing falls back to the `$VISUAL`/`$EDITOR`/`vim` chain. |

Santree launches Claude with `--permission-mode auto` for implement runs and `--permission-mode plan` for plan-mode runs (`santree worktree work --plan`). Auto-acceptance of non-mutating tools while planning is governed by Claude Code's `useAutoModeDuringPlan` setting in `~/.claude/settings.json`, not by santree. There is no opt-in env var — worktree-scoped automation is the default. Set `--permission-mode default` upstream if you ever need stricter prompting.

## External Dependencies

Required: Node.js >= 20, Git, GitHub CLI (`gh`), Claude Code CLI (`claude`)
Optional:
- A terminal multiplexer for new-window flows — **cmux** is suggested (deepest Claude Code integration, macOS-only; narrow `sendCommand` limitation from [manaflow-ai/cmux#1472](https://github.com/manaflow-ai/cmux/issues/1472)) or **tmux** (fully supported, all platforms, the only auto-installable one)
- `git-delta` (or any unified-diff pager) — used by `worktree diff` and the dashboard `v` overlay when `SANTREE_DIFF_TOOL` is set. `santree config` surfaces it as the diff-tool row.

### Issue tracker setup

Each repo picks one tracker. The **tracker row in `santree config`** is the entry point: it lists Local/Linear/GitHub, marks the active one, switches instantly, runs Linear OAuth inline and surfaces the `gh auth login` hint for GitHub (all via the inline `lib/config/TrackerPicker.tsx`). The dashboard's `t` overlay shares the same picker logic. `santree linear auth` can also set it as a side effect. There is no separate tracker-selection command — selection lives in `santree config` (use the `SANTREE_TRACKER` env var for one-off non-interactive overrides).

**Local (built-in)** — no auth, no SaaS. Pick "Local" from the tracker row in `santree config` (or the dashboard `t` overlay). Issues live as version-controlled Markdown files in `.santree/issues/LOCAL-<n>.md`. Create/edit/delete from the dashboard Issues tab (`n`/`e`/`d`); CLI CRUD is not exposed yet (dashboard-only by design). Start work with `w` exactly like Linear/GitHub issues — the branch is `feature/LOCAL-<n>-<slug>`.

**Linear** — OAuth PKCE + GraphQL. Run `santree linear auth` to authenticate (opens browser, stores tokens in `$XDG_CONFIG_HOME/santree/auth.json`, defaults to `~/.config/santree/auth.json`), and links the org to the current repo. Ticket data (title, description, comments, images) is injected into prompts before launching Claude. Auth tokens auto-refresh; images are downloaded to `/tmp/santree-images-{ticketId}/`. `listAssigned` excludes `completed`/`canceled`-type states (in the GraphQL filter) plus any state whose **name** is in `HIDDEN_STATE_NAMES` (`lib/trackers/linear/api.ts` — currently `"duplicate"`, matched case-insensitively): Linear's default "Duplicate" resolution state is often typed non-terminal in a workspace, so it leaks past the type filter and would otherwise clutter the backlog.

**GitHub Issues** — uses the existing `gh` CLI (no separate OAuth). Log in with `gh auth login` yourself, then pick GitHub from the tracker row in `santree config` — santree never writes a GitHub token of its own. The dashboard then lists `gh search issues --assignee=@me --state=open --repo <owner>/<name>`. Priority is derived from labels (`P0`/`P1`/`urgent`/`high`/etc.); attached images are downloaded from `user-images.githubusercontent.com` / `github.com/.../assets/`. Cross-repo issues are not surfaced — scope is the current repo.
