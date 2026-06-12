---
title: Installation
nav_order: 3
---

# Installation
{: .no_toc }

1. TOC
{:toc}

---

## Install the CLI

```bash
npm install -g santree
```

That installs the `santree` binary. There's nothing to add to your shell config — santree is a plain CLI, and the [dashboard](dashboard.html) is the primary way to drive it (`santree dashboard`).

## Guided setup (recommended)

```bash
santree setup
```

`santree setup` is the fastest way to get from a fresh install to a working santree. Where `santree doctor` **reports** what's missing, `santree setup` **fixes it** — it detects the gaps, shows only the steps that still need doing as a checklist, and applies the ones you pick:

- **Diff tool** — detects an installed diff pager, or offers to `brew install git-delta` (macOS), then sets `SANTREE_DIFF_TOOL`.
- **Editor** — detects installed editors (`code`/`cursor`/`zed`/`vim`/…), lets you pick, and sets `SANTREE_EDITOR`.
- **Claude Code** — statusline, session-state signal hooks, remote control, and the CLI itself.
- **GitHub CLI** — install + `gh auth login`.
- **This repo** — scaffolds `.santree/`, adds the right `.gitignore` (or `.git/info/exclude`) entries, and picks/authenticates an issue tracker.

Use the arrow keys to move, **Space** to toggle a step, **Enter** to apply, **Esc** to cancel.

<!-- TODO screenshot: `santree setup` checklist mid-flow — a few steps checked (e.g. Diff tool, Editor, Statusline), the cursor on one, the [x]/[ ] toggles visible. Shows the wizard is interactive, not a wall of prompts. -->

| Flag | Effect |
|---|---|
| `--dry-run` | Show what would change without writing anything. |
| `--yes` | Apply all recommended steps non-interactively. |

Everything `setup` does is also doable by hand (see [Configuration](configuration.html) for the env vars and [Integrations](integrations.html) for the Claude Code hooks) — but the wizard is the quickest path.

## Entering worktrees

santree is a plain binary, and a child process can't change its parent shell's directory. So when you switch to or create a worktree from the **CLI**, santree prints the command to enter it:

```text
→ Run this to enter the worktree:
  cd '/path/to/repo/.santree/worktrees/TEAM-123'
```

Copy-paste it (or wrap it in your own alias). If you run inside **tmux or cmux**, the [dashboard](dashboard.html) skips this entirely — switching opens a new window already `cd`-ed into the worktree, which is the recommended workflow.

## Verify your setup

```bash
santree doctor
```

This walks every required and optional integration and prints a row per check:

<!-- TODO screenshot: `santree doctor` output — the full check list with a mix of green ✓ and a yellow ○ or two (e.g. remote control not enabled), so readers see the at-a-glance health view. -->

- Required: Node ≥ 20, Git, GitHub CLI, Claude Code CLI
- Optional: tmux/cmux, `git-delta` (or any unified-diff pager), an editor, the active issue tracker's auth status, Claude Code statusline + remote control + session-signal hooks

If any required check fails, the row tells you what's missing and how to fix it. To apply those fixes automatically, run [`santree setup`](#guided-setup-recommended).

## Requirements

| Tool | Version | Purpose |
|---|---|---|
| **Node.js** | ≥ 20 | Runtime |
| **Git** | any modern | Worktree operations |
| **GitHub CLI** (`gh`) | any | PR integration |
| **Claude Code** (`claude`) | any | AI agent for `work`, `fix`, `review`, PR-fill |

Optional, picked up if available:

| Tool | Purpose |
|---|---|
| **tmux** or **cmux** | New-window flows from the dashboard. tmux is recommended (cross-platform). cmux is macOS-only and limited by [manaflow-ai/cmux#1472](https://github.com/manaflow-ai/cmux/issues/1472). |
| **delta** (or any unified-diff pager) | Syntax-highlighted diffs in `worktree diff` and the dashboard `[v]` overlay. Activated by `SANTREE_DIFF_TOOL`. |
| **VSCode / Cursor / Zed / nvim / JetBrains** | Editor for the `[e]` action. Configurable via `SANTREE_EDITOR`. |

## Updating

```bash
npm update -g santree
```

`santree doctor` warns when a newer version is on npm, so you'll know when to run that.
