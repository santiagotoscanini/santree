---
title: Home
layout: home
nav_order: 1
---

# Santree

A beautiful CLI for managing Git worktrees, with integrated AI assistance.
{: .fs-6 .fw-300 }

Santree turns "switch tasks" into a one-keystroke operation. It creates isolated worktrees per branch, surfaces them in an interactive dashboard alongside live PR / CI / review status, and launches Claude with full ticket context when you're ready to work.

[Get started](installation.html){: .btn .btn-primary .fs-5 .mb-4 .mb-md-0 .mr-2 }
[View on GitHub](https://github.com/stoscanini/santree){: .btn .fs-5 .mb-4 .mb-md-0 }

---

## What's inside

- **Interactive dashboard** — `santree dashboard` shows every assigned issue, the worktrees you have open, PR state, CI checks, review counts, and the live state of any Claude session attached to each worktree.
- **Pluggable issue trackers** — Linear (OAuth + GraphQL) and GitHub Issues (via `gh`) are first-class. Pick one per repo with `santree issue switch`.
- **Pluggable terminal multiplexers** — auto-detects tmux or cmux; falls back gracefully when neither is active.
- **AI built into the loop** — Claude is launched with the rendered ticket + your custom context. PR creation, fix-from-review, and self-review all run the agent against the right inputs.
- **Inline diff overlay** — review your branch the way GitHub does (merge-base scoped) without leaving the dashboard. Pipe through `delta` for syntax highlighting.

---

## 60-second tour

```bash
# Install
npm install -g santree

# Wire up shell integration (one-time)
eval "$(santree helpers shell-init zsh)"   # or bash

# Verify
santree doctor

# Open the dashboard — manage everything from one screen
santree dashboard
```

---

## Where to next

| If you want to… | Go to |
|---|---|
| Install and verify | [Installation](installation.html) |
| See it work end-to-end | [Quickstart](quickstart.html) |
| Understand the mental model | [Concepts](concepts.html) |
| Tour the dashboard | [Dashboard](dashboard.html) |
| Look up a command | [Commands](commands.html) |
| Wire up Linear or GitHub Issues | [Trackers](trackers.html) |
| Configure env vars / init scripts | [Configuration](configuration.html) |
| Hack on santree | [Development](development.html) |
