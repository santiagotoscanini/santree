---
title: Integrations
nav_order: 10
---

# Integrations
{: .no_toc }

Optional integrations that make santree fit your existing setup.

1. TOC
{:toc}

---

## Claude Code

Santree lives next to Claude Code — it launches `claude`, reads its hooks, and embeds its session state.

### Statusline

A custom statusline showing git info, model, context usage, and cost.

Add to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "santree helpers statusline"
  }
}
```

Format: `repo | branch | S: staged | U: unstaged | A: untracked | Model | Context% | $Cost`

The context-usage segment renders as a colored progress bar — green / yellow ≥60% / red ≥80%.

### Remote control

Enable [Remote Control](https://code.claude.com/docs/en/remote-control) to continue local Claude Code sessions from your phone, tablet, or any browser. This lets you kick off work with `santree worktree work` and monitor or steer the session remotely.

Run `/config` inside Claude Code and set **Enable Remote Control for all sessions** to `true`. This writes `remoteControlAtStartup: true` to `~/.claude.json`. Run `santree doctor` to verify.

### Session state signaling

Surfaces the current Claude Code session state in the dashboard, statusline, and tmux window names. You can tell at a glance whether a session is actively working, waiting for permission approval, idle, or exited.

| State | Meaning |
|---|---|
| `active` | User submitted a prompt, Claude is working |
| `waiting` | Claude needs permission approval |
| `idle` | Claude finished and is waiting for next prompt |
| `exited` | Session ended |

Install:

```bash
santree helpers session-signal install
```

Adds hooks for `Notification`, `Stop`, `UserPromptSubmit`, and `SessionEnd` to `~/.claude/settings.json`. Existing hooks are preserved.

Preview the JSON without writing: `santree helpers session-signal install --dry`

Verify with `santree doctor` — look for the "Session Signal Hooks" row under Claude Code.

### English Tutor

When enabled, Claude Code spots grammar mistakes in your prompts and replies with a one-line correction (`original -> correction (reason)`) before doing the actual work. Mistake-free prompts are ignored. Useful if English isn't your first language.

Install:

```bash
santree helpers english-tutor install
```

Adds two hooks (`UserPromptSubmit`, `SessionStart`) and a scoped `Edit` permission for the practice log to `~/.claude/settings.json`. Existing hooks and permissions are preserved.

Preview the JSON without writing: `santree helpers english-tutor install --dry`

Corrections are appended to `~/.config/santree/english-practice-log.md` (or `$XDG_CONFIG_HOME/santree/english-practice-log.md`). The `SessionStart` hook replays this log into context on new sessions so Claude can spot recurring patterns.

Remove with `santree helpers english-tutor uninstall`.

---

## Multiplexers

Santree auto-detects whichever multiplexer is active and uses it for new-window flows (`work`, `fix`, `review`).

| Multiplexer | Detection | Notes |
|---|---|---|
| **tmux** | `$TMUX` set | Default. Works on every platform. |
| **cmux** | `$CMUX_SURFACE_ID` set | macOS only. Requires the cmux.app GUI running. |
| none | neither set | New-window flows degrade to "run manually" / inline only. |

There is no env var override — each adapter declares its own runtime check.

### cmux caveats

cmux is macOS-only and tightly bound to the cmux.app GUI. Two upstream issues affect santree's integration:

{: .warning }
> **[manaflow-ai/cmux#1472](https://github.com/manaflow-ai/cmux/issues/1472)** — programmatically created workspaces have dead PTYs, so `sendCommand` is unimplemented (returns `unsupported`) and post-creation flows degrade. **tmux remains the recommended backend until #1472 lands.** `santree doctor` surfaces a warning when cmux is active.

{: .note }
> **[manaflow-ai/cmux#2048](https://github.com/manaflow-ai/cmux/issues/2048)** — cmux ships its own Claude CLI at `/Applications/cmux.app/Contents/Resources/bin/claude`, wired to the active cmux workspace. When santree detects cmux is active, it uses that bundled binary in preference to a globally-installed `claude`.

---

## Editors

Set `SANTREE_EDITOR` to whatever launches your editor with a path argument:

```bash
export SANTREE_EDITOR=zed       # or cursor, code, nvim, idea, subl, webstorm, …
```

Defaults to `code`. GUI editors (Code, Cursor, Zed, JetBrains) automatically get `--wait` when launched from `Ctrl+O` in the multi-line context input, so the dashboard pauses until you close the file.

`worktree open` also accepts `--editor <cmd>` to override per-invocation.

---

## Diff tools

Set `SANTREE_DIFF_TOOL` to a pager that accepts a unified diff on stdin:

```bash
export SANTREE_DIFF_TOOL=delta            # syntax highlighting + side-by-side
# or
export SANTREE_DIFF_TOOL=diff-so-fancy
```

Used by:

- `santree worktree diff` (CLI) — passed to git as `-c core.pager=<tool>`. The pager handles render + scroll, as usual.
- The dashboard `[v]` overlay — santree captures the pager's stdout and handles scrolling itself in Ink.
- The Reviews-tab diff (`gh pr diff` source) — same as the worktree overlay.

For `delta` specifically, santree:

- Forces `--light` / `--dark` based on the detected theme (delta's syntax-theme defaults are tuned for dark backgrounds and become unreadable on light ones).
- Disables hyperlinks (`delta.hyperlinks=false`) — OSC 8 escape sequences mangle the dashboard's column-truncation math.
- Disables line numbers (`delta.line-numbers=false`) — they eat ~6 cols of an already-narrow right pane.

These overrides are passed via `GIT_CONFIG_PARAMETERS`, scoped to the dashboard invocation only — your global delta config is untouched.
