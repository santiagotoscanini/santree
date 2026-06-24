---
title: FAQ & Troubleshooting
nav_order: 13
---

# FAQ & Troubleshooting
{: .no_toc }

1. TOC
{:toc}

---

## Why a separate worktree per branch instead of just `git checkout`?

Switching branches with `git checkout` overwrites your working tree. If you have an in-progress feature, you stash, switch, do the other thing, switch back, pop, and hope nothing collided. Worktrees skip all of that — every branch has its own directory, so your editor, terminal, and Claude session stay where you left them.

The trade-off is disk space (one checkout per active branch) and a bit of structure (`.santree/worktrees/<TICKET-ID>/`). For most workflows it's a net win.

## How do I enter a new worktree from the CLI?

A child process can't change its parent shell's directory, so when you create or switch worktrees from the **CLI**, santree prints the `cd` command for you to run:

```text
→ Run this to enter the worktree:
  cd '/path/to/repo/.santree/worktrees/TEAM-123'
```

Copy-paste it, or wrap it in your own shell alias. santree itself is just a binary — there's nothing to source into your shell config, and `which santree` points straight at it.

If you run inside **tmux or cmux**, the [dashboard](dashboard.html) avoids the cd dance entirely: switching to a worktree opens a new window already in the right directory. That's the recommended workflow.

## My dashboard is empty

Some possibilities:

- **No tracker configured**: run `santree config` and pick one from the **Issue tracker** row (Linear authenticates inline; GitHub uses `gh auth login`). The dashboard speaks to whichever tracker is active for the repo.
- **Tracker mismatch**: maybe the repo's `_tracker.kind` is set to one backend but you're authed for the other. Check with `santree config --check`, or fix it from the **Issue tracker** row in `santree config`.
- **GitHub Issues — no assignees**: `gh search issues --assignee=@me` returns nothing if your team uses Projects without assignees. Self-assign the issues you're working on.
- **Cross-repo issues**: only current-repo issues are surfaced today.

## `santree --version` shows a different version than my repo

You probably have both a globally-installed santree and an `npm link`ed dev copy. `which santree` will tell you which binary is winning. Re-link with `npm link` from the repo, or uninstall the global version.

## Diff overlay shows no syntax highlighting

You haven't set a diff tool. Install `delta` (`brew install git-delta` on macOS), then set it in `santree config` under **Global → Diff tool** (the row also offers the `brew install` on macOS). It takes effect on santree's next run.

Both the worktree diff (`[v]` on a worktree row) and the Reviews-tab diff (`[v]` on a PR with no local worktree) honor your configured diff tool. For a one-off you can prefix the command with `SANTREE_DIFF_TOOL=delta`, which overrides the stored value.

## Diff overlay text is wrapping weirdly / cut in half

Ink's built-in `wrap="truncate"` measures by string length and counts ANSI escape bytes as visible characters, which makes color-heavy lines wrap very early. Santree works around this with its own truncator (`truncateVisible()`) and SGR-splitter (`splitCombinedSgr()`). If you still see wrapping, file an issue with a screenshot — there may be an escape pattern we haven't seen yet.

## Claude says "I don't have permission to read /tmp/santree-images-…"

This was a known bug fixed by passing `--allowedTools Read` to the Claude CLI when running the PR-fill flow, so the agent can read locally-downloaded ticket images. If you see this on a recent santree, file an issue.

## cmux's `sendCommand` doesn't work

That's [manaflow-ai/cmux#1472](https://github.com/manaflow-ai/cmux/issues/1472) — programmatically created cmux workspaces have dead PTYs, so `sendCommand` returns `unsupported`. It only bites when santree re-sends a command into an **already-open** window (the resume / re-launch path), where it falls back to focusing the window and printing the command. New-window flows work normally, so cmux is still the suggested multiplexer; switch to tmux if this edge case matters to you.

## My terminal theme switched but the dashboard didn't follow

`SANTREE_THEME=auto` polls the terminal background via OSC 11 on each refresh (every ~5 minutes, or when you press `R`). If your terminal doesn't respond to OSC 11 — some legacy terminals don't — set the theme explicitly:

```bash
export SANTREE_THEME=light    # or dark
```

## Where do tokens live?

`~/.config/santree/auth.json` (or `$XDG_CONFIG_HOME/santree/auth.json`). The file is versioned — v1 (Linear-flat) is migrated to v2 (`{version:2, linear, github}`) on first read. The `github` namespace is reserved — `gh` owns its own token, santree never writes one.

## How do I stop the auto-refresh?

You can't, but it's infrequent. The dashboard fetches issues + worktree status + PR info + checks + reviews every 5 minutes in parallel — spaced out so the per-PR `gh` calls (which hit GitHub's GraphQL API) don't exhaust the hourly rate limit. Force a refresh anytime with `R`.

## I want a different prompt

Edit the templates in `prompts/`. They're Nunjucks, get rendered with the issue + diff + PR context, and passed to Claude. Most behavior (style, scope, what to ask for) lives in those templates — change them, rebuild, run.
