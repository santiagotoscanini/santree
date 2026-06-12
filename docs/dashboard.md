---
title: Dashboard
nav_order: 7
---

# Dashboard
{: .no_toc }

`santree dashboard` opens a full-screen TUI to manage all your work in one place. It shows your assigned issues from the active tracker (Linear or GitHub Issues) grouped by project, with live status for worktrees, PRs, CI checks, and reviews.

<!-- TODO screenshot: dashboard hero — Issues tab with several projects, one issue expanded into · diff / · pr / · session sub-rows; right pane showing the description + git status + actions footer. Wide aspect (~140 cols). -->

1. TOC
{:toc}

---

## Layout

**Tabs (top)** — press `Tab` to cycle or a number key:

- **Triage** — incoming issues awaiting triage (a `triage`-state inbox). Shown only when the active tracker has a triage concept (Linear today).
- **Issues** — your assigned tickets in this repo that don't have a worktree yet (backlog / planning).
- **Trees** — worktrees in progress, plus the synthetic main-repo row and any orphaned worktrees.
- **Reviews** — PRs where your review is requested.

When the Triage tab is present it leads, so the number keys are `1` Triage, `2` Issues, `3` Trees, `4` Reviews; without it they shift down by one.

**Left pane** — the list. Issues without worktrees show as a single row (priority + ID + title). Issues with worktrees expand into nested sub-rows below the title:

- `· diff` — files changed / additions / deletions / commits ahead of base
- `· pr` — number, state, CI summary, review count
- `· session` — Claude session state (`active` / `waiting` / `idle` / `exited`) + session ID

The far-right `WT CI` columns give an at-a-glance worktree-exists / checks-pass status without expanding rows. The right column changes per tab:

- **Trees** — `WT CI` (worktree exists / checks status).
- **Triage** — an `SLA` countdown badge showing time until the triage SLA breaches (e.g. `2d 23h`, `13h`, `45m`, or `breached`): red when breached or under a day out, yellow when under two days, gray otherwise. Snoozed issues are greyed and sorted to the bottom.
- **Issues** — a `RDY` readiness glyph driven by the issue's blocking dependencies: **`✓` green = ready to start** (no open blockers), **`⊘` yellow = blocked** by an unfinished dependency. Lets you spot which backlog tasks are startable right now without opening each one. The detail pane shows the full **Dependencies** section — what blocks this issue (with each blocker's done/open state) and what it blocks. Dependency data comes from Linear's "blocks" issue relations; other trackers show a neutral dot.

**Right pane** — context-aware detail. Issue description, worktree git status (staged / unstaged / untracked, with diff stats vs merge-base), PR body, CI checks ordered fail → pending → pass, reviews, conversation comments, the live Claude todo list for the active session, and the action footer.

The divider is draggable. Mouse, scroll wheel, and keyboard all work everywhere.

## Keyboard reference

### Navigation

| Key | Action |
|---|---|
| `Tab` / `1`–`4` | Switch tabs (Triage / Issues / Trees / Reviews) |
| `↑ ↓` / `j k` | Move selection |
| `Enter` | Resume Claude session in tmux (or switch to worktree if no session) |
| `?` | Toggle the help overlay (glyph legend + key reference) |
| `q` / `Esc` | Close overlay; from the root view, quit |
| `R` | Force refresh (auto-refresh runs every 5 minutes) |

### Triage actions

The Triage tab lists the triage-state issues assigned to you, ordered by SLA urgency (snoozed ones greyed and parked at the bottom), so you can assess them before committing to the work. The right pane shows the SLA countdown, description, and the full comment thread, and — when your team has a Linear triage on-call rotation — a one-line **on-call summary** at the top (who's on call now, and when you're next up). These keys act on the selected issue:

<!-- TODO screenshot: Triage tab — the list with color-coded SLA badges (a red breached/<24h one and a yellow <48h one for contrast), a greyed snoozed row at the bottom, and the on-call summary line + comment thread in the right pane. -->


| Key | Action |
|---|---|
| `a` | Ask Claude a clarifying question about the issue + all its comments — inline, read-only Q&A (Claude may inspect the codebase to judge whether it's fixable). The answer appears in place; press `a` again to ask another, `q`/`Esc` to close. |
| `i` | **Investigate the ticket** — launch a Claude investigation in a new multiplexer window, driven by a skill or prompt you configure per repo (see [Investigate triage ticket](#investigate-triage-ticket)). Greyed until configured. |
| `w` | Send it to a tree — creates a worktree and starts work, exactly like the Issues tab. The issue moves to the Trees tab. |
| `s` | Open the **triage on-call schedule** — the full weekly rotation for your team(s), pulled from Linear's "Triage responsibility" (current shift highlighted, your own shifts marked). Works even when the inbox is empty. `q`/`Esc` to close. |
| `o` | Open the issue in the active tracker (Linear) |

#### Investigate triage ticket

Press `i` on the Triage tab to hand the selected ticket to Claude in a new multiplexer window (tmux/cmux). You decide what "investigate" means per repo by adding a `_triage` block to `.santree/metadata.json`:

```json
{
  "_triage": { "skill_name": "investigate-ticket-live" }
}
```

- **`skill_name`** — a Claude skill / slash command. Santree runs `/<skill_name> <TICKET-ID>` (e.g. `/investigate-ticket-live TEAM-123`). Best when the investigation logic lives in a reusable skill.
- **`prompt`** — a free-form prompt instead, with `{ticket_id}` substituted: `{ "prompt": "investigate {ticket_id} using the prod logs and the codebase" }`.

If both are present, `skill_name` wins. The window opens in the main repo root, so Claude can read the codebase and use the repo's MCP servers.

`.santree/metadata.json` is gitignored, so this is per-machine — each person points it at their own skill or prompt without committing it. Until you configure it, the `[i]` action shows greyed and pressing it just prints a reminder. An active multiplexer is required (there's no inline fallback).

### Worktree actions

| Key | Action |
|---|---|
| `w` | Create worktree & start working — opens mode-select (plan / implement) → context input → launch |
| `e` | Open the worktree in your editor (`SANTREE_EDITOR`, defaults to `code`) |
| `d` | Remove the worktree and its branch — confirm, then it runs in the background (staged progress in the right pane when that row is selected). Fire several in a row without waiting; each in-progress row is marked `⌫` in the WT column. |
| `o` | Open the issue in the active tracker (Linear / GitHub) |

### PR actions

<!-- TODO screenshot: an inline flow — the `[C]` commit overlay (stage confirm or the message text area) or the `[c]` PR-create body review, to show these happen in-pane without leaving the dashboard. -->

| Key | Action |
|---|---|
| `C` | Inline commit & push — choose mode (manual message / `--fill` via Claude) |
| `c` | Create the PR — fill the template via Claude (review/edit the body, toggle draft vs ready with `d`, then create), or open the new-PR page pre-filled in the browser |
| `p` | Open the PR in the browser |
| `f` | Apply PR review comments + CI failures with Claude (in tmux) |
| `r` | Self-review the PR with Claude (in tmux) |

### Diff overlay

`[v]` opens a full-area, two-pane overlay: file tree (left) + diff content (right). Branch-only diff vs the base branch's merge-base — same scope as a GitHub PR diff (upstream changes don't leak in).

<!-- TODO screenshot: diff overlay with delta enabled — file tree on the left, syntax-highlighted diff on the right. Pick a colorful change (a TS file with type changes works well). -->

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

Set with `SANTREE_THEME=light|dark|auto` (default `auto`). In auto mode, santree queries the terminal background via OSC 11 on first paint and on every refresh, so theme switches propagate within ~5 minutes (or sooner if you press `R`). Falls back to dark on non-TTY or 150 ms timeout.

Only the selection background is theme-sensitive; foreground colors are terminal-native and read on either background.

## Inline flows vs new-window flows

| Inline (right-pane / full-area overlay) | New tmux/cmux window |
|---|---|
| `[C]` commit + push | `[w]` work (plan / implement) |
| `[c]` PR create | `[f]` fix PR |
| `[v]` diff overlay | `[r]` self-review PR |
| `[a]` ask Claude (Triage) | `[i]` investigate ticket (Triage) |
| `[?]` help | |

Inline flows never leave the dashboard. New-window flows hand off to a multiplexer window so you can interact with Claude directly.

---

## Behind the scenes

The dashboard fetches issues via `getIssueTracker(repoRoot).listAssigned(repoRoot)` and enriches each one in parallel — worktree status, PR info, checks, reviews, diff shortstat — via `Promise.all`. Auto-refreshes every 5 minutes. Use `R` to force-refresh.
