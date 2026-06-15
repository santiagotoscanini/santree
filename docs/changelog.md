---
title: Changelog
nav_order: 14
description: Release history. Detailed notes live on the GitHub Releases page.
---

# Changelog
{: .no_toc }

Full release notes — including diff stats and links to PRs — live on the **[GitHub Releases page](https://github.com/santiagotoscanini/santree/releases)**.

This page is a curated highlight reel.

1. TOC
{:toc}

---

## Recent highlights

### 0.7.x (May–June 2026)

- `santree config` — one command to inspect and configure santree, replacing the separate `doctor`, `setup`, and `tracker` commands. It's a live panel: read-only diagnostics (tool versions, update-available) sit alongside settings you can change in place — each row applies the moment you toggle it. Pick your issue tracker (Local / Linear / GitHub, with Linear OAuth inline) right inside it. `santree config --check` prints the old flat status report for scripts/CI; `--yes` applies recommended defaults non-interactively; `--dry-run` previews.
- Optimistic PR creation — after you create a PR from the dashboard, its "Open PR" action appears immediately (with a "loading checks & reviews…" hint) instead of waiting for the next refresh. Only the just-created PR shows the loading state; existing PRs keep their info.
- Shell integration removed — santree is now a plain binary with no `santree` shell function, alias, or hook (so `which santree` just works). Worktree create/switch from the CLI print a `cd` command to copy; the dashboard with tmux/cmux opens a new window in the worktree as before. If you had `eval "$(santree helpers shell-init …)"` in your shell config, you can delete that line.
- `santree setup` — a guided wizard that fixes what `santree doctor` reports: a checklist of only the steps that still need doing (diff tool + `brew install git-delta`, editor, Claude Code statusline / hooks / remote control, GitHub CLI auth, and per-repo `.santree` scaffold / `.gitignore` / issue-tracker setup). Space to toggle, Enter to apply; `--dry-run` to preview, `--yes` to apply recommended defaults.
- Triage tab — when Linear is the active tracker, the dashboard leads with a **Triage** inbox: the triage-state issues assigned to you, ordered by an urgency-coded `SLA` countdown badge (snoozed issues greyed and parked at the bottom), the full comment thread in the detail pane, `a` to ask Claude a read-only clarifying question about the issue, `w` to send it to a tree, and `s` to view your team's triage on-call rotation.
- Tabs split into four — **Triage** (Linear only) · **Issues** (backlog) · **Trees** (worktrees in progress) · **Reviews** (PRs awaiting your review).
- Non-blocking worktree deletion — confirm `d` and removal runs in the background with staged progress; fire several in a row without waiting.
- PR draft/ready toggle, browser PR compose pre-fill, and dashboard auto-refresh throttled to 5 minutes.

### 0.6.x (May 2026)

- Reviews tab — `[v]` opens the PR diff inline (parsed from `gh pr diff`), now with `SANTREE_DIFF_TOOL` syntax highlighting in parity with the worktree diff overlay.
- Dashboard `?` help overlay — press anywhere to see the glyph legend + key reference.
- Dashboard "Tasks" section — live Claude todo list for the active worktree session.
- Commit `--fill` — draft commit messages via Claude. Dashboard `[C]` flow gained a choose-mode (fill / manual) step.
- Dashboard "Main repo" synthetic row — surfaces the parent repo's branch + commits-behind alongside worktree rows.
- View PR diffs from the Reviews tab — `[v]` works for PRs without local worktrees too (uses `gh pr diff`).
- Squirrel SDF loader — replaces the previous donut/cube loaders. (Standalone via `santree helpers squirrel`.)

### 0.5.x

- Multiplexer abstraction — auto-detects tmux / cmux. The `SANTREE_MULTIPLEXER` env var was removed in favour of pure auto-detection.
- Centralized issue tracking + multiplexer logic; cleaner `lib/trackers/` and `lib/multiplexer/`.
- Delta integration — `SANTREE_DIFF_TOOL=delta` for syntax highlighting in the diff overlay; `splitCombinedSgr()` works around an upstream `slice-ansi` bug.
- Linear OAuth PKCE flow + GraphQL ticket fetching.
- GitHub Issues tracker — full parity with Linear via the `gh` CLI.

### 0.4.x and earlier

See **[GitHub Releases](https://github.com/santiagotoscanini/santree/releases)** for the full history.

---

## Versioning

Santree follows [SemVer](https://semver.org/) with a relaxed major-zero convention:

- **Patch** (`0.x.Y` → `0.x.Y+1`) — bug fixes, minor polish
- **Minor** (`0.X.y` → `0.X+1.0`) — new features, possibly breaking
- **Major** (`X.y.z` → `X+1.0.0`) — reserved for the 1.0 GA

While we're at `0.x`, expect occasional breaking changes in minor releases — they'll always be called out in the release notes.

## Update notifications

`santree config --check` and the dashboard banner check npm for newer versions (cached for 6 hours per package). Run `santree update` to upgrade — it auto-detects your package manager (npm / pnpm / yarn / bun).
