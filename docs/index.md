---
title: Home
layout: home
nav_order: 1
description: "Santree — a CLI for managing Git worktrees with integrated AI assistance. Linear / GitHub Issues, tmux / cmux, Claude in the loop."
---

<p align="center">
  <img src="{{ site.baseurl }}/assets/icon.png" alt="Santree" width="180" />
</p>

<h1 align="center" style="margin-top: 0;">Santree</h1>

<p align="center" style="margin-top: -0.5rem;">
  <a href="https://www.npmjs.com/package/santree"><img src="https://img.shields.io/npm/v/santree.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/santree"><img src="https://img.shields.io/npm/dm/santree.svg" alt="npm downloads"></a>
  <a href="https://github.com/santiagotoscanini/santree/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/santree.svg" alt="license"></a>
  <a href="https://github.com/santiagotoscanini/santree/stargazers"><img src="https://img.shields.io/github/stars/santiagotoscanini/santree?style=social" alt="GitHub stars"></a>
</p>

<p align="center" class="fs-5 fw-300">
  Pick an issue, work on it with Claude in an isolated worktree, ship a PR, without leaving your terminal.
</p>

<p align="center">
  <a href="installation.html" class="btn btn-primary fs-5 mb-4 mb-md-0 mr-2">Get started →</a>
  <a href="quickstart.html" class="btn fs-5 mb-4 mb-md-0">5-minute tour</a>
</p>

<!-- TODO screenshot: HERO — the dashboard in its best light. Trees tab, a few real tickets, one expanded into · diff / · pr / · session sub-rows; right pane showing description + git status + CI + actions footer. Wide (~140 cols), with a diff pager (delta) configured so colors pop. This is the first thing visitors see — make it the money shot. -->

---

## What's inside

- **Interactive dashboard** — every assigned issue in one TUI, with live worktree / PR / CI / review state and the running Claude session per branch.
- **Pluggable issue trackers** — Linear (OAuth + GraphQL) and GitHub Issues (via `gh`) are first-class. Pick one per repo from the **Issue tracker** row in `santree config`.
- **Pluggable terminal multiplexers** — auto-detects cmux (suggested) or tmux; falls back to same-window flows when neither is active.
- **AI in the loop** — Claude is launched with the rendered ticket + your context. PR creation, review fix-up, and self-review all run the agent with the right inputs pre-staged.
- **Inline diff overlay** — review your branch the way GitHub does (merge-base scoped) without leaving the dashboard. Pipe through `delta` for syntax highlighting.

---

## 60-second tour

```bash
# Install
npm install -g santree

# Configure (shell-free — sets editor, diff tool, Claude Code, this repo)
santree config

# Verify
santree config --check

# Open the dashboard — manage everything from one screen
santree dashboard
```

That's it. Walk a real session in [Quickstart](quickstart.html).

---

## Where to next

| If you want to… | Go to |
|---|---|
| Install and verify | [Installation]({{ site.baseurl }}/installation.html) |
| See it work end-to-end | [Quickstart]({{ site.baseurl }}/quickstart.html) |
| Understand the mental model | [Concepts]({{ site.baseurl }}/concepts.html) |
| See the full workflow diagram | [Workflow]({{ site.baseurl }}/workflow.html) |
| Tour the dashboard | [Dashboard]({{ site.baseurl }}/dashboard.html) |
| Look up a command | [Commands]({{ site.baseurl }}/commands.html) |
| Wire up Linear or GitHub Issues | [Trackers]({{ site.baseurl }}/trackers.html) |
| Configure env vars / init scripts | [Configuration]({{ site.baseurl }}/configuration.html) |
| Add the Claude statusline / remote control | [Integrations]({{ site.baseurl }}/integrations.html) |
| Compare to alternatives | [Why santree?]({{ site.baseurl }}/comparison.html) |
| Hack on santree | [Development]({{ site.baseurl }}/development.html) |
| Troubleshoot | [FAQ]({{ site.baseurl }}/faq.html) |
