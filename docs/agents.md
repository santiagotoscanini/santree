---
title: AI agents
nav_order: 11
---

# AI agent backend
{: .no_toc }

Santree drives an AI coding agent for `worktree work`, `pr review`, `pr fix`, commit/PR drafting, and triage Q&A. The backend is pluggable: **Claude Code** (default) or **OpenAI Codex**.

1. TOC
{:toc}

---

## Selecting an agent

The agent is a global preference (it reflects which CLI you have installed), set in `santree config` under **System → AI agent**. Pick **Claude Code** or **Codex**; the choice is written to `~/.config/santree/config.json` and takes effect on the next run.

For a single invocation or in CI, `SANTREE_AGENT` overrides the stored value:

```bash
SANTREE_AGENT=codex santree worktree work
SANTREE_AGENT=claude santree dashboard
```

When neither is set, santree defaults to Claude Code.

## What each agent needs

| | Claude Code | Codex |
|---|---|---|
| Install | `npm install -g @anthropic-ai/claude-code` | `npm install -g @openai/codex` |
| Binary | `claude` (or the cmux-bundled copy) | `codex` |
| Instruction file | `CLAUDE.md` | `AGENTS.md` |

`santree config` shows the active agent's install state and version, and offers to install it if it's missing.

## The options adapt to the agent

Selecting Codex changes what `santree config` shows and what the dashboard offers, because some features have no Codex equivalent. Santree gates each feature on a capability — it never assumes a specific agent.

| Capability | Claude Code | Codex |
|---|---|---|
| `worktree work` (implement / plan) | ✅ | ✅ |
| `pr review` | ✅ | ✅ |
| Commit & PR drafting, triage **ask** | ✅ | ✅ |
| Model selection, MCP servers | ✅ | ✅ |
| Session resume from the dashboard | ✅ | — santree doesn't track Codex session ids |
| `pr fix` auto-loop | ✅ self-paced `/loop` | ✅ **santree-driven loop** |
| Dashboard **Tasks** section | ✅ reads the agent's todos | — no external todos file |
| **Statusline** | ✅ scriptable | — not available ([openai/codex#17827](https://github.com/openai/codex/issues/17827)) |
| **Remote control** | ✅ `~/.claude.json` toggle | — different model, not managed by santree |
| Triage **investigate** via a skill | ✅ `/<skill> <id>` | configure a free-form `_triage.prompt` instead |

When Codex is active, the **Statusline** and **Remote control** rows disappear from `santree config`, the dashboard hides the **Tasks** section, and triage **investigate** uses a free-form prompt rather than a slash-command skill.

## The fix loop on Codex

[`santree pr fix`](commands.html) keeps fixing CI failures and applying 👍-approved review comments until the PR is clean or stuck. On Claude this runs as a self-paced `/loop` that keeps context across iterations. Codex has no self-scheduling primitive, so **santree drives the loop itself**: each iteration it regenerates the same per-iteration brief (via `pr context`), runs Codex to act on it, then re-checks state to decide whether to continue, wait for CI, or stop. The dashboard `⟳` badge and the `.santree/fix-loops/` marker behave identically.

For the loop to push commits and resolve threads, Codex needs a sandbox/approval policy that permits the required git and network operations — santree launches it autonomously (`--sandbox workspace-write --ask-for-approval never`); adjust your Codex config if your environment needs broader access.

## Tool permissions

Claude runs with a per-tool allowlist (e.g. read-only `Read,Grep,Glob` for triage **ask**). Codex has no per-tool allowlist; santree maps any read-only intent to `--sandbox read-only`, which is broadly equivalent (no writes) at a coarser grain.
