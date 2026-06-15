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
santree config
```

`santree config` is the fastest way to get from a fresh install to a working santree. It's a live settings panel organized into three sections, and each change applies immediately:

- **System** — tool versions and status (Node, Git, GitHub CLI, Claude Code, the active multiplexer, "update available"). These are read-only diagnostic rows.
- **Global** — your **Default editor**, the **Diff tool** (with an offer to `brew install git-delta` on macOS), and Claude Code integration (statusline, remote control). Editor and diff-tool picks are stored in santree's config; the `SANTREE_EDITOR` / `SANTREE_DIFF_TOOL` env vars still work as one-off overrides.
- **This repo** — scaffolds `.santree/`, adds the right `.gitignore` (or `.git/info/exclude`) entries, and picks/authenticates an issue tracker via the **Issue tracker** row.

Navigate with the arrow keys: **↑/↓** move between rows, **Space** toggles a setting on or off, **Enter** or **→** changes a setting or drills into a sub-menu (e.g. the **Issue tracker** row opens Local / Linear / GitHub), and **←** or **Esc** backs out of a sub-menu or quits. Read-only diagnostic rows (tool versions, active multiplexer, workspace editor) are shown but skipped over.

<!-- TODO screenshot: `santree config` panel mid-flow — the System / Global / This repo sections with a mix of toggles and diagnostic rows, the cursor on one. Shows the panel is interactive, not a wall of prompts. -->

| Flag | Effect |
|---|---|
| `--check` | Print the flat read-only status report and exit (non-zero if a required tool is missing). |
| `--dry-run` | Show what would change without writing anything. |
| `--yes` | Apply all recommended changes non-interactively. |

Everything `santree config` does is also doable by hand (see [Configuration](configuration.html) for the env vars and [Integrations](integrations.html) for the Claude Code statusline and remote control) — but the panel is the quickest path.

## Entering worktrees

santree is a plain binary, and a child process can't change its parent shell's directory. So when you switch to or create a worktree from the **CLI**, santree prints the command to enter it:

```text
→ Run this to enter the worktree:
  cd '/path/to/repo/.santree/worktrees/TEAM-123'
```

Copy-paste it (or wrap it in your own alias). If you run inside **tmux or cmux**, the [dashboard](dashboard.html) skips this entirely — switching opens a new window already `cd`-ed into the worktree, which is the recommended workflow.

## Verify your setup

```bash
santree config --check
```

This walks every required and optional integration and prints a row per check:

<!-- TODO screenshot: `santree config --check` output — the full check list with a mix of green ✓ and a yellow ○ or two (e.g. remote control not enabled), so readers see the at-a-glance health view. -->

- Required: Node ≥ 20, Git, GitHub CLI, Claude Code CLI
- Optional: tmux/cmux, `git-delta` (or any unified-diff pager), an editor, the active issue tracker's auth status, Claude Code statusline + remote control

`--check` exits non-zero if a required tool is missing, so it's handy in scripts and CI. If any required check fails, the row tells you what's missing and how to fix it. To apply those fixes interactively, run [`santree config`](#guided-setup-recommended).

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
| **cmux** or **tmux** | New-window flows from the dashboard. cmux is suggested — deepest Claude Code integration (macOS only, needs cmux.app). tmux is fully supported and cross-platform. See [Integrations → Multiplexers](integrations.html#multiplexers). |
| **delta** (or any unified-diff pager) | Syntax-highlighted diffs in `worktree diff` and the dashboard `[v]` overlay. Set it in `santree config` (Global → Diff tool); `SANTREE_DIFF_TOOL` overrides per-invocation. |
| **VSCode / Cursor / Zed / nvim / JetBrains** | Editor for the `[e]` action. Set it in `santree config` (Global → Default editor); `SANTREE_EDITOR` overrides per-invocation. |

## Updating

```bash
npm update -g santree
```

`santree config --check` warns when a newer version is on npm, so you'll know when to run that.
