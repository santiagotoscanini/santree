---
title: Dashboard
nav_order: 6
---

# Dashboard
{: .no_toc }

`santree dashboard` opens a full-screen TUI to manage all your work in one place. It shows your assigned issues from the active tracker (Linear or GitHub Issues) grouped by project, with live status for worktrees, PRs, CI checks, and reviews.

1. TOC
{:toc}

---

## Layout

**Tabs (top)** — switch between **Issues** (your assigned tickets in this repo) and **Reviews** (PRs where your review is requested). Press `Tab` or `1`/`2`.

**Left pane** — the list. Issues without worktrees show as a single row (priority + ID + title). Issues with worktrees expand into nested sub-rows below the title:

- `· diff` — files changed / additions / deletions / commits ahead of base
- `· pr` — number, state, CI summary, review count
- `· session` — Claude session state (`active` / `waiting` / `idle` / `exited`) + session ID

The far-right `WT CI` columns give an at-a-glance worktree-exists / checks-pass status without expanding rows.

**Right pane** — context-aware detail. Issue description, worktree git status (staged / unstaged / untracked, with diff stats vs merge-base), PR body, CI checks ordered fail → pending → pass, reviews, conversation comments, the live Claude todo list for the active session, and the action footer.

The divider is draggable. Mouse, scroll wheel, and keyboard all work everywhere.

## Keyboard reference

### Navigation

| Key | Action |
|---|---|
| `Tab` / `1` / `2` | Switch between Issues / Reviews tabs |
| `↑ ↓` / `j k` | Move selection |
| `Enter` | Resume Claude session in tmux (or switch to worktree if no session) |
| `?` | Toggle the help overlay (glyph legend + key reference) |
| `q` / `Esc` | Close overlay; from the root view, quit |
| `R` | Force refresh (auto-refresh runs every 30s) |

### Worktree actions

| Key | Action |
|---|---|
| `w` | Create worktree & start working — opens mode-select (plan / implement) → context input → launch |
| `e` | Open the worktree in your editor (`SANTREE_EDITOR`, defaults to `code`) |
| `d` | Remove the worktree and its branch |
| `o` | Open the issue in the active tracker (Linear / GitHub) |

### PR actions

| Key | Action |
|---|---|
| `C` | Inline commit & push — choose mode (manual message / `--fill` via Claude) |
| `c` | Create the PR (fill template from commits via Claude, or open the new-PR page in browser) |
| `p` | Open the PR in the browser |
| `f` | Apply PR review comments + CI failures with Claude (in tmux) |
| `r` | Self-review the PR with Claude (in tmux) |

### Diff overlay

`[v]` opens a full-area, two-pane overlay: file tree (left) + diff content (right). Branch-only diff vs the base branch's merge-base — same scope as a GitHub PR diff (upstream changes don't leak in).

| Key | Action |
|---|---|
| `j` / `k` | Next / previous file |
| `J` / `K` (or `Shift+↓` / `Shift+↑`) | Scroll diff content |
| `g` / `G` | Jump to top / bottom of diff |
| `q` / `Esc` | Close overlay |
| Mouse | Click a file to select; scroll wheel scrolls; drag the divider to resize |

If `SANTREE_DIFF_TOOL` is set, the diff is piped through that tool (e.g. `delta`) and rendered with ANSI passthrough for syntax highlighting. The dashboard owns scrolling — the pager is used purely for rendering.

The Reviews-tab diff path uses `gh pr diff` for branches that don't exist locally; the worktree path uses `git diff` against `merge-base`. Both honor `SANTREE_DIFF_TOOL`.

## Theme

Set with `SANTREE_THEME=light|dark|auto` (default `auto`). In auto mode, santree queries the terminal background via OSC 11 on first paint and on every refresh, so theme switches propagate within ~30s. Falls back to dark on non-TTY or 150 ms timeout.

Only the selection background is theme-sensitive; foreground colors are terminal-native and read on either background.

## Inline flows vs new-window flows

| Inline (right-pane / full-area overlay) | New tmux/cmux window |
|---|---|
| `[C]` commit + push | `[w]` work (plan / implement) |
| `[c]` PR create | `[f]` fix PR |
| `[v]` diff overlay | `[r]` self-review PR |
| `[?]` help | |

Inline flows never leave the dashboard. New-window flows hand off to a multiplexer window so you can interact with Claude directly.

---

## Behind the scenes

The dashboard fetches issues via `getIssueTracker(repoRoot).listAssigned(repoRoot)` and enriches each one in parallel — worktree status, PR info, checks, reviews, diff shortstat — via `Promise.all`. Auto-refreshes every 30s. Use `R` to force-refresh.
