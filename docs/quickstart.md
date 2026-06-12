---
title: Quickstart
nav_order: 4
---

# Quickstart
{: .no_toc }

Five-minute walkthrough — pick an issue, work on it, ship a PR. Assumes you've finished [Installation](installation.html).

1. TOC
{:toc}

---

## 1. Authenticate your tracker

If you ran `santree setup` during [Installation](installation.html), you already did this — skip to step 2.

Otherwise, pick one and run the matching auth command from inside any repo where you want santree to surface issues:

```bash
# Linear (OAuth in browser)
santree linear auth

# OR GitHub Issues (uses the existing gh CLI — no separate OAuth)
santree github auth
```

The auth command also flips the repo's active tracker, so you only do this once per repo. See [Trackers](trackers.html) for the full setup.

## 2. Open the dashboard

```bash
santree dashboard
```

You'll see a two-pane TUI: assigned issues on the left, detail on the right. Mouse + keyboard both work — click a row to select, drag the divider to resize, scroll wheel scrolls.

<!-- TODO screenshot: dashboard on first open, fresh install — Issues tab with a few real assigned tickets, no worktrees yet (clean slate). -->

## 3. Start working on a ticket

Select an issue and press `w`. A mode-select overlay asks plan-vs-implement, then opens a context input where you can add custom instructions to the prompt (`Ctrl+O` to drop into your editor). Press Enter to launch.

<!-- TODO screenshot: the `w` flow — either the plan/implement mode-select overlay or the context-input box with a line or two of custom instructions typed in. -->


What happens behind the scenes:

1. A worktree is created at `.santree/worktrees/<TICKET-ID>/` from the base branch.
2. (Optional) `.santree/init.sh` runs to set up env files / dependencies.
3. A new tmux/cmux window is opened in the worktree.
4. Claude is launched with the rendered ticket + your context as input.

## 4. Iterate with the inline diff

Back in the dashboard, press `[v]` on the issue to open the diff overlay. Left pane is the file tree, right pane shows the diff content. Use `j/k` to move between files, `J/K` to scroll the diff.

The diff is **branch-only** — it uses `git merge-base` against the configured base, so upstream changes you haven't pulled don't leak in. Same scope as a GitHub PR diff.

<!-- TODO screenshot: diff overlay mid-review — file tree with a couple of files selected, syntax-highlighted diff on the right. -->

{: .note }
> Install [`delta`](https://github.com/dandavison/delta) (`brew install git-delta`) and `export SANTREE_DIFF_TOOL=delta` to get syntax highlighting in the overlay. Works for both worktree diffs and Reviews-tab PR diffs.

## 5. Commit, push, and PR — without leaving the dashboard

| Key | Action |
|---|---|
| `[C]` | Stage + commit + push (inline message input or `--fill` from Claude) |
| `[c]` | Create the PR (fill template via Claude with a draft/ready toggle, or open the new-PR page pre-filled in the browser) |
| `[r]` | Self-review the PR with Claude |
| `[f]` | Apply review comments / CI failures with Claude |

<!-- TODO screenshot: the `[c]` PR-create flow — the fill-mode body review step (generated PR body in the editable text area with the draft/ready toggle visible), or the right-pane PR section right after creation showing the new PR. -->

Once the PR is merged, `[d]` removes the worktree, or `santree worktree clean` does it in bulk for any branch whose PR is merged or closed.

---

## What just happened

You went from "pick an issue" to "open PR" without leaving the terminal. Each stage corresponds to a node in the [Workflow diagram](workflow.html). The mental model behind it lives in [Concepts](concepts.html).
