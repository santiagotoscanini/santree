---
title: Installation
nav_order: 2
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

That installs `santree` (and the `st` alias from the shell wrapper, see below).

## Shell setup (required)

{: .important }
> Without the shell integration you can still use santree, but commands that change directory (`worktree create`, `worktree switch`) won't follow you back to your shell — you'll need to `cd` manually. Wire it up once and forget it.

Santree commands like `worktree create` and `worktree switch` need to change the directory of the *parent shell*. A child process can't do that on its own, so the shell wrapper reads marker lines from santree's stdout (`SANTREE_CD:<path>`, `SANTREE_WORK:<mode>`) and `cd`s on your behalf.

Add to your `.zshrc` or `.bashrc`:

```bash
eval "$(santree helpers shell-init zsh)"   # for zsh
eval "$(santree helpers shell-init bash)"  # for bash
```

Reload your shell. The wrapper installs three aliases:

| Alias | Expansion |
|---|---|
| `st` | `santree` |
| `stw` | `santree worktree` |
| `stn` | `santree worktree create --work --plan --tmux` (prompts for branch name) |

## Verify your setup

```bash
santree doctor
```

This walks every required and optional integration and prints a row per check:

- Required: Node ≥ 20, Git, GitHub CLI, Claude Code CLI
- Optional: tmux/cmux, `git-delta` (or any unified-diff pager), an editor, the active issue tracker's auth status, Claude Code statusline + remote control + session-signal hooks

If any required check fails, the row tells you what's missing and how to fix it.

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
