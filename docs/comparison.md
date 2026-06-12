---
title: Why santree?
nav_order: 2
description: How santree compares to other Git worktree tools and AI coding workflows.
---

# Why santree?
{: .no_toc }

Santree is opinionated. This page explains the choices and how it differs from alternatives.

1. TOC
{:toc}

---

## The problem

Real day-to-day flow looks like this:

1. You're working on feature A.
2. A reviewer comments on PR for feature B.
3. A bug ticket lands for feature C.

In a one-checkout world, each switch costs a stash + checkout + rebuild + reload. Worse: any AI session loses its context window and has to be re-warmed.

Santree gives each branch its own directory, its own terminal pane, its own running AI session, and one TUI to see all of them at once.

## Design opinions

### Worktrees, not stashes

Built on top of `git worktree`. Switching is `cd`, not `checkout`. Your editor, terminal history, and Claude session for branch A stay alive while you work on branch B.

### Issue tracker is a first-class concept

Most worktree managers don't know about issues. Santree fetches the active ticket on every AI invocation and injects it into the prompt — title, description, comments, attached images. That's what turns "ask Claude to do X" into "ask Claude to do this ticket."

Today: Linear and GitHub Issues. Tomorrow: anything that fits the [`IssueTracker` interface]({{ site.baseurl }}/development.html#adding-a-provider).

### The AI is part of the loop, not a separate tool

`work`, `pr fix`, `pr review`, and `pr create --fill` all launch Claude with the right context pre-staged. You're not copy-pasting tickets into a chat window.

### Everything stays in the terminal

The dashboard, diff overlay, commit input, PR-body editor, and review flows all run inside the TUI. No browser context-switch unless you explicitly ask for it (`[o]` to open the issue, `[p]` to open the PR).

### Pluggable, with a *small* surface

Trackers and multiplexers are behind interfaces. Adding a new option (Jira, Zellij, GitLab) is one new directory + one factory branch. The dashboard, prompt rendering, and AI flows speak generic terms — no `if vendor === "linear"` outside the factory.

---

## Compared to other tools

### vs. plain `git worktree`

| | git worktree | santree |
|---|---|---|
| Create branch + checkout | manual | `santree worktree create` |
| Track which branches you have open | `git worktree list` | dashboard with PR / CI / review state |
| Per-branch tmux window | manual | `--tmux` flag, or auto from dashboard |
| Issue context in branch name | manual | extracted automatically |
| Per-branch init script | shell function | `.santree/init.sh` |
| Cleanup merged worktrees | manual | `santree worktree clean` |

Santree is an opinionated wrapper. If you don't want the opinions, plain `git worktree` is fine.

### vs. [git-town](https://www.git-town.com/)

git-town is a structural git workflow tool — it formalizes child branches, sync, ship, propose. It's branch-heavy by design.

Santree is a worktree-and-AI tool — its unit of work is "the directory I'm coding in," not "the branch graph." They aren't competitors; you can use both. (git-town for the merge/sync conventions, santree for the per-branch workspaces and AI integration.)

### vs. [gworktree](https://github.com/gh-utils/gworktree) / [git-wt](https://github.com/lordcodes/git-wt) / similar wrappers

These are thin worktree creators — better ergonomics on top of `git worktree add`. They don't surface issues, run AI, or give you a dashboard.

If all you want is faster `worktree add`, those are lighter. Santree assumes you also want the issue tracker, the AI agent, and the live dashboard view.

### vs. an IDE workspace per branch (VSCode multi-root, etc.)

IDE workspaces give you per-branch editor state. They don't give you per-branch *terminal* state, AI sessions, or PR/CI visibility.

Santree complements this — `[e]` from the dashboard opens the worktree in your editor. The dashboard, diff overlay, and AI flows run alongside.

### vs. running Claude Code by hand

You can absolutely just `cd` into a worktree and run `claude`. Santree adds:

- Auto-fetching the issue from your tracker and injecting it into the prompt
- A consistent prompt template per task (work / fix / review / fill-PR) so you're not re-writing the same instructions
- Resume support — the dashboard remembers the Claude session ID per worktree, so `Enter` resumes instead of starting fresh
- Live session-state surfacing in the dashboard (active / waiting / idle / exited)

If you only ever work on one branch at a time and don't mind re-prompting, the manual flow is simpler.

---

## When santree is *not* the right fit

- **You don't use an issue tracker.** Most of santree's value is binding worktrees to tickets. Without a tracker the dashboard is mostly empty and you're just using a worktree wrapper.
- **You don't use Claude Code.** The AI flows assume the `claude` CLI is on your PATH. There's no equivalent for OpenAI Codex, Cursor, or others *yet* — the agent layer is behind an interface but only Claude is implemented today.
- **You're on Windows.** Tested on macOS and Linux only. PRs welcome.
- **You don't want a dashboard.** All the inline flows have CLI equivalents (`santree worktree commit`, `santree pr create`, `santree worktree diff`), so you can use santree without ever opening the dashboard — but at that point you're using ~30% of it.

---

## Roadmap

The "Planned" column in the [Workflow → Supported tools]({{ site.baseurl }}/workflow.html#supported-tools-per-stage) table is the public roadmap:

- More AI agents (OpenAI Codex, OpenCode, Cursor, Aider)
- More forges (GitLab, Bitbucket, Gitea)
- More trackers (Jira, Shortcut)
- Zellij as a third multiplexer

PRs against any of these are welcome — see [Development → Adding a provider]({{ site.baseurl }}/development.html#adding-a-provider).
