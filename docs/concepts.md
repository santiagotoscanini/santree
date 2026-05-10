---
title: Concepts
nav_order: 4
---

# Concepts
{: .no_toc }

The mental model behind santree, in four parts.

1. TOC
{:toc}

---

## Worktrees as your unit of work

Santree uses [`git worktree`](https://git-scm.com/docs/git-worktree) so each branch you're working on lives in its own directory. No more stashing or committing WIP just to switch tasks — `cd` to the other worktree and your editor, terminal, and AI session are right where you left them.

Worktrees are stored under `.santree/worktrees/<TICKET-ID>/`. Per-worktree metadata (base branch, optional Claude session ID) is centralized in `.santree/metadata.json`, keyed by ticket ID.

The worktree commands (`create`, `switch`, `list`, `remove`, `clean`, `sync`) operate on this layout. Branch naming is opinionated — see [Branch naming](configuration.html#branch-naming) — so santree can extract the ticket ID from the branch name and link the worktree back to its issue.

## Issue trackers as a pluggable layer

Santree treats Linear and GitHub Issues as interchangeable backends behind a single `IssueTracker` interface. Each repo picks one. Resolution order:

1. `SANTREE_TRACKER` env var (one-off override)
2. Per-repo `_tracker.kind` (in `.santree/metadata.json`)
3. Legacy `_linear.org` (treated as Linear for back-compat)
4. Auto-detect — any Linear creds present → Linear, else GitHub

Adding a third tracker is "one new directory under `lib/trackers/` and one branch in the factory." Nothing else changes — the dashboard, prompt rendering, and AI flows speak generic terms (`issue`, `tracker.displayName`).

See [Trackers](trackers.html) for setup.

## Multiplexers as a pluggable layer

Same shape as trackers. Santree auto-detects tmux (`$TMUX`) or cmux (`$CMUX_SURFACE_ID`) and uses whichever is active. Falls back to a no-op adapter when neither is present. There is no env var to override — each adapter declares its own runtime check.

Multiplexer-launched flows (`work`, `fix`, `review`) open new windows; inline flows (`commit`, `pr create`, `diff`) stay in the dashboard. See [Integrations → Multiplexers](integrations.html#multiplexers) for cmux-specific caveats.

## AI as a launchable agent

The Claude CLI is the AI layer today. Three commands wrap it:

| Command | Prompt template | Used for |
|---|---|---|
| `santree worktree work` | `prompts/work.njk` | Implement (or `--plan` to plan) |
| `santree pr fix` | `prompts/fix-pr.njk` | Apply PR review comments + CI failures |
| `santree pr review` | `prompts/review.njk` | Self-review the branch against the ticket |

Plus `pr create --fill` runs `prompts/fill-pr.njk` non-interactively to draft a PR body from the diff + commits + ticket.

Each invocation goes through `lib/ai.ts`, which:

1. Resolves the active worktree, branch, and ticket ID
2. Fetches the issue from the active tracker
3. Renders the prompt template with that context
4. Spawns Claude (`--permission-mode auto`, `plan` for plan mode)

Worktree-scoped automation is the default — there is no opt-in flag for permission mode. The blast radius is the worktree directory.

---

## Putting it together

The four pieces compose: dashboard picks an issue from your **tracker**, creates a **worktree**, opens it in your **multiplexer**, and launches the **AI agent** with the ticket as context. Walk the full flow in [Workflow](workflow.html).
