---
title: Development
nav_order: 13
---

# Development
{: .no_toc }

Hacking on santree.

1. TOC
{:toc}

---

## Setup

```bash
git clone https://github.com/santiagotoscanini/santree.git
cd santree
npm install
```

## Build & run

```bash
# Compile TypeScript
npm run build

# Run the local build
node dist/cli.js <command>

# Watch mode (recompiles on save)
npm run dev
```

During development, use `node dist/cli.js` instead of `santree` to avoid clashing with the globally-installed version:

```bash
node dist/cli.js worktree list
node dist/cli.js worktree work
node dist/cli.js linear auth --test TEAM-123
```

## Link globally

To use `santree` as a global command pointing to your local build:

```bash
npm link
```

Verify it picked up your local copy:

```bash
santree --version    # should match the version in your local package.json
```

If it shows a different version, `npm` resolved a different binary — check `which santree`. Unlink with `npm unlink -g santree`.

## Code quality

```bash
npm run lint        # Check for lint + formatting errors
npm run lint:fix    # Auto-fix lint + formatting errors
npm run format      # Format all source files with Prettier
```

A pre-commit hook (via husky + lint-staged) runs ESLint + Prettier on staged files automatically.

## Project structure

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
│   ├── config/          # diagnostics + inline TrackerPicker for `santree config`
│   ├── setup/           # SetupStep catalog + apply engine (used by `santree config`)
│   └── dashboard/       # Dashboard UI components
│       ├── types.ts     # State types, action types, phase enums
│       ├── IssueList.tsx
│       ├── DetailPanel.tsx
│       └── DiffOverlay.tsx
└── commands/            # One React (Ink) component per CLI command
    ├── config.tsx       # System / Global / This-repo settings panel (--check, --yes, --dry-run)
    ├── dashboard.tsx
    ├── worktree/        # create, list, switch, remove, clean, sync, work, open, setup, commit, diff
    ├── pr/              # create, open, fix, context, review
    ├── linear/          # auth
    ├── issue/           # open
    ├── helpers/         # statusline, squirrel, template, text-editor
    └── update.tsx       # self-update + version check
prompts/                 # Nunjucks templates: work, review, fix-loop, fix-context, fill-pr, fill-commit, pr, diff, ticket, ask
```

## Adding a provider

Trackers and multiplexers are both behind interfaces. Adding a new option in either category is a small, contained change.

**To add a tracker** (e.g. Jira):

1. Create `source/lib/trackers/jira/` with the GraphQL/REST client.
2. Implement the `IssueTracker` interface from `lib/trackers/types.ts` — `kind`, `displayName`, `issueNoun`, `getAuthStatus`, `signOut`, `extractIdFromBranch`, `cleanupCache`, `listAssigned`, `getIssue`.
3. Add `"jira"` to the `IssueTrackerKind` union and a branch in `getIssueTracker()` (`lib/trackers/index.ts`).

That's it. The dashboard, prompt rendering, and AI flows speak generic terms (`issue`, `tracker.displayName`) — no other code changes.

**To add a multiplexer** (e.g. zellij):

1. Create `source/lib/multiplexer/zellij.ts`.
2. Implement the `Multiplexer` interface — `isActive()`, `createWindow()`, `addTab()`, `selectWindow()`, `sendCommand()`.
3. Register the adapter in `lib/multiplexer/index.ts`. Detection is auto — `getMultiplexer()` iterates the adapter list and picks the first whose `isActive()` returns true.

## Patterns to know

- **Ink + state machine** — every command exports a `Status` union driving the UI. Spinner during async work, success / error text after.
- **Sync git via `run()`, async via `execAsync` / `spawnAsync`** — `lib/exec.ts` wraps both. Yield with `await new Promise(r => setTimeout(r, 10))` between batches of sync calls so the spinner animates.
- **Prompt-driven AI** — Nunjucks templates in `prompts/` render the context that goes to Claude. Prompts are tracker-agnostic (no Linear/GitHub vendor names in templates).
- **No tracker conditionals outside `getIssueTracker()`** — vendor names appear in user-facing strings only via `tracker.displayName`, in the named commands (`santree linear auth` etc.), or in `config.tsx` reporting the active backend. Everywhere else speaks generically.

## Contributing

Issues and pull requests welcome. See [github.com/santiagotoscanini/santree](https://github.com/santiagotoscanini/santree).
