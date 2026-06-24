---
title: Integrations
nav_order: 12
---

# Integrations
{: .no_toc }

Optional integrations that make santree fit your existing setup.

1. TOC
{:toc}

---

## Claude Code

Santree lives next to Claude Code — it launches `claude`, wires up a statusline, and resumes its sessions. Claude Code is the default [AI agent backend](agents.html); the statusline and remote control below are Claude features and only appear in `santree config` when Claude is the active agent. To run santree on **OpenAI Codex** instead, see [AI agents](agents.html).

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

<!-- TODO screenshot: the statusline rendered at the bottom of a Claude Code session — ideally with the context bar in the yellow/red zone so the colored progress bar is visible. A tight crop of just the statusline row works best. -->


### Remote control

Enable [Remote Control](https://code.claude.com/docs/en/remote-control) to continue local Claude Code sessions from your phone, tablet, or any browser. This lets you kick off work with `santree worktree work` and monitor or steer the session remotely.

Run `/config` inside Claude Code and set **Enable Remote Control for all sessions** to `true`. This writes `remoteControlAtStartup: true` to `~/.claude.json`. Run `santree config --check` to verify.

---

## Multiplexers

Santree auto-detects whichever multiplexer is active and uses it for new-window flows (`work`, `fix`, `review`). **[cmux](https://cmux.com) is the suggested multiplexer** — it treats Claude Code as a first-class citizen (it even ships its own wired-up Claude CLI; see [#2048](https://github.com/manaflow-ai/cmux/issues/2048) below), so the agent flows feel native. **tmux is fully supported** too, and is the right choice when you're not on macOS or prefer a terminal-native multiplexer.

| Multiplexer | Detection | Notes |
|---|---|---|
| **cmux** | `$CMUX_SURFACE_ID` set | Suggested. Deepest Claude Code integration. macOS only; requires the cmux.app GUI running. |
| **tmux** | `$TMUX` set | Fully supported. Works on every platform; the only auto-installable option (`santree config`). |
| none | neither set | New-window flows degrade to "run manually" / inline only. |

There is no env var override — each adapter declares its own runtime check.

### cmux: per-project folders & per-ticket tabs

On cmux, santree organizes its windows to match how you think about work:

- **Each ticket gets one workspace** named after the ticket (e.g. `TEAM-123`). Starting work names its tab `work`; the [fix loop](dashboard.html#fix-loop) (`f`) and self-review (`r`) add `fix-loop` and `review` tabs to that *same* workspace — so everything for a ticket lives together instead of scattering across windows.
- **Workspaces are grouped into sidebar folders by Linear project.** Launching work / investigate / review / fix for a ticket files its workspace under a folder named after the issue's project, so the cmux sidebar mirrors your project structure. Grouping is best-effort and never blocks a launch.

(tmux has no in-workspace tabs or sidebar folders, so the fix loop and review open separate `fix-loop-<ticket>` / `review-<ticket>` windows there.)

### cmux caveats

cmux is macOS-only and tightly bound to the cmux.app GUI. Two upstream issues affect santree's integration:

{: .note }
> **[manaflow-ai/cmux#1472](https://github.com/manaflow-ai/cmux/issues/1472)** — programmatically created workspaces have dead PTYs, so `sendCommand` returns `unsupported`. In practice this only affects re-sending a command into an **already-open** window (the resume / re-launch path): santree falls back to focusing the window and printing the command to run. New-window flows — the common case — bake the command into `createWindow` and work normally. If this edge case matters to your workflow, use tmux until #1472 lands.

{: .note }
> **[manaflow-ai/cmux#2048](https://github.com/manaflow-ai/cmux/issues/2048)** — cmux ships its own Claude CLI at `/Applications/cmux.app/Contents/Resources/bin/claude`, wired to the active cmux workspace. When santree detects cmux is active, it uses that bundled binary in preference to a globally-installed `claude`.

---

## Editors

Set your editor in `santree config` — under **Global**, the **Default editor** row. Pick whatever launches your editor with a path argument (`zed`, `cursor`, `code`, `nvim`, `idea`, `subl`, `webstorm`, …). It writes to santree's config file and takes effect on the next run — no shell restart.

For a single invocation or in CI, `SANTREE_EDITOR` still works as a one-off override that wins over the stored value:

```bash
SANTREE_EDITOR=zed santree dashboard
```

When unset, GUI "open in editor" actions fall back to `code`. GUI editors (Code, Cursor, Zed, JetBrains) automatically get `--wait` when launched from `Ctrl+O` in the multi-line context input, so the dashboard pauses until you close the file.

`worktree open` also accepts `--editor <cmd>` to override per-invocation.

---

## Diff tools

Set your diff tool in `santree config` — under **Global**, the **Diff tool** row (on macOS it also offers `brew install git-delta` if you don't have delta yet). Pick a pager that accepts a unified diff on stdin (`delta` for syntax highlighting + side-by-side, `diff-so-fancy`, …). It writes to santree's config file and takes effect on the next run.

For a single invocation or in CI, `SANTREE_DIFF_TOOL` still works as a one-off override that wins over the stored value:

```bash
SANTREE_DIFF_TOOL=delta santree worktree diff
```

When unset, santree falls back to its own colorizer (dashboard overlay) or git's default pager (CLI).

Used by:

- `santree worktree diff` (CLI) — passed to git as `-c core.pager=<tool>`. The pager handles render + scroll, as usual.
- The dashboard `[v]` overlay — santree captures the pager's stdout and handles scrolling itself in Ink.
- The Reviews-tab diff (`gh pr diff` source) — same as the worktree overlay.

For `delta` specifically, santree:

- Forces `--light` / `--dark` based on the detected theme (delta's syntax-theme defaults are tuned for dark backgrounds and become unreadable on light ones).
- Disables hyperlinks (`delta.hyperlinks=false`) — OSC 8 escape sequences mangle the dashboard's column-truncation math.
- Disables line numbers (`delta.line-numbers=false`) — they eat ~6 cols of an already-narrow right pane.

These overrides are passed via `GIT_CONFIG_PARAMETERS`, scoped to the dashboard invocation only — your global delta config is untouched.
