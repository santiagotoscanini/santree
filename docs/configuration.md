---
title: Configuration
nav_order: 8
---

# Configuration
{: .no_toc }

How to point santree at your tools, workflows, and conventions.

1. TOC
{:toc}

---

## Environment variables

| Variable | Effect |
|---|---|
| `SANTREE_TRACKER` | Override the active issue tracker for a single invocation: `linear` or `github`. Takes precedence over the per-repo `_tracker.kind`. If unset, falls back to repo config → legacy `_linear.org` → auto-detect. |
| `SANTREE_EDITOR` | Editor used by `[e]` (open in editor) actions in the dashboard, and by `Ctrl+O` in the multi-line context input. Defaults to `code`. Examples: `cursor`, `zed`, `code`, `nvim`. GUI editors get `--wait` automatically. |
| `SANTREE_DIFF_TOOL` | Pager used by `worktree diff` (CLI) and the dashboard `[v]` overlay. Passed to git as `-c core.pager=<tool>` for the CLI, and used to pipe content for the overlay. Examples: `delta`, `diff-so-fancy`. Must accept a unified diff on stdin. Names are restricted to `[A-Za-z0-9_\-/.+]`. |
| `SANTREE_THEME` | Dashboard color theme: `light`, `dark`, or `auto` (default). In `auto` mode, santree queries the terminal's background via OSC 11 and re-detects on each refresh cycle so theme switches propagate within ~5 minutes (or sooner on a manual `R`). Set explicitly when your terminal doesn't respond to OSC 11. |

Santree always launches Claude with `--permission-mode auto` (Claude Code's auto mode), or `plan` when invoked in plan mode. Worktree-scoped automation is the default — there is no opt-in flag.

## Init script

Create `.santree/init.sh` in your repository root. It runs after each `worktree create` (and on `worktree setup`) inside the new worktree directory.

```bash
#!/bin/bash
# Copy env files, install dependencies, anything project-specific.
cp "$SANTREE_REPO_ROOT/.env" "$SANTREE_WORKTREE_PATH/.env"
npm install
```

The script gets `SANTREE_REPO_ROOT` and `SANTREE_WORKTREE_PATH` in its environment. `santree doctor` reports whether the script exists and is executable.

## Branch naming

Branch names need to encode the issue ID so santree can link the worktree back to the right ticket. The accepted format depends on the active tracker.

### Linear

Letter prefix + dash + digits, anywhere in the branch name. The `extractIdFromBranch` regex is `[A-Z]+-\d+`.

```
user/TEAM-123-feature-description
feature/PROJ-456-add-auth
TEAM-789
```

### GitHub Issues

Explicit prefix required, by design — a commit-style branch like `fix-typo-1` would otherwise match. Accepted patterns:

```
feature/issue-42-add-auth
gh-42-add-auth
42-add-auth
#42
```

The leading number form (`42-add-auth`) only matches at the start of the branch or after a `/` — `chore/some-thing-1` is *not* an issue 1 reference.

## Worktree storage

Worktrees live at `.santree/worktrees/<TICKET-ID>/`. Per-worktree metadata (only when the base branch differs from the repo default) is stored in `.santree/metadata.json`, keyed by ticket ID. The auth file (`~/.config/santree/auth.json`) stores tracker tokens; gh's own token is owned by the `gh` CLI.

Both directories are `.gitignore`-friendly:

```gitignore
.santree/worktrees/
.santree/session-states/
```

{: .important }
> The trailing slash matters — without it, you'd ignore a *file* named `worktrees`, not the directory.

## Triage investigation

The Triage tab's `[i]` action launches a Claude investigation of the selected ticket in a new multiplexer window. Configure what it runs per repo by adding a `_triage` block to `.santree/metadata.json`:

```json
{
  "_triage": { "skill_name": "investigate-ticket-live" }
}
```

| Key | Effect |
|---|---|
| `_triage.skill_name` | A Claude skill / slash command. Santree runs `/<skill_name> <TICKET-ID>` (e.g. `/investigate-ticket-live TEAM-123`). |
| `_triage.prompt` | A free-form prompt template used instead; every `{ticket_id}` is replaced with the ticket. Example: `"investigate {ticket_id} using the prod logs and the codebase"`. |

If both keys are set, `skill_name` wins. The investigation window opens in the main repo root, so Claude can read the codebase and use the repo's MCP servers. `metadata.json` is gitignored, so this is per-machine. Until it's set, the `[i]` action is greyed and an active multiplexer (tmux/cmux) is required.

---

## See also

- [Trackers]({{ site.baseurl }}/trackers.html) — Linear / GitHub Issues setup
- [Integrations]({{ site.baseurl }}/integrations.html) — Claude Code hooks, multiplexers, editors, diff tools
