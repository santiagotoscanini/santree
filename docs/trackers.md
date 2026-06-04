---
title: Trackers
nav_order: 9
---

# Issue trackers
{: .no_toc }

Santree supports Linear and GitHub Issues behind a single interface. Each repo picks one.

1. TOC
{:toc}

---

## Choosing a tracker

The active tracker is resolved in this order:

1. `SANTREE_TRACKER` env var (one-off override)
2. Per-repo `_tracker.kind` in `.santree/metadata.json`
3. Legacy `_linear.org` (treated as Linear, for back-compat)
4. Auto-detect — any Linear creds present → Linear, else GitHub

To set the per-repo tracker explicitly:

```bash
santree issue switch linear
santree issue switch github
```

The auth commands also flip the tracker as a side effect, so usually you just run the auth command for whichever backend you want and you're done.

For one-off overrides (testing, scripting):

```bash
SANTREE_TRACKER=github santree dashboard
```

---

## Linear

Santree fetches Linear ticket data via the GraphQL API (OAuth PKCE).

### Auth

```bash
# Authenticate with Linear (opens browser for OAuth)
santree linear auth

# Check auth status
santree linear auth --status

# Verify a ticket fetches correctly
santree linear auth --test TEAM-123

# Log out
santree linear auth --logout

# Switch between authenticated workspaces
santree linear switch
```

On first run, `santree linear auth` opens your browser to authorize the app with your Linear workspace. Tokens are stored in `$XDG_CONFIG_HOME/santree/auth.json` (defaults to `~/.config/santree/auth.json`) and auto-refresh transparently.

If you have multiple workspaces authenticated, running `santree linear auth` in a new repo lets you pick which one to link.

### What gets fetched

- Title, description, comments
- State (name + type), priority, labels
- Project name + ID
- Due date — surfaced as the urgency-coded `DUE` badge on the [Triage tab](dashboard.html)
- Attached images — downloaded to `/tmp/santree-images-<ticketId>/` and the URLs in the description are rewritten to local paths so Claude can read them. (Cleanup is handled by macOS clearing `/tmp` on reboot — no explicit cleanup runs.)

### Triage inbox

Linear is the one tracker today with a native triage concept, so the dashboard grows a **Triage** tab when Linear is the active tracker. It lists issues in a `triage`-state inbox that don't have a worktree yet, with due dates, the full comment thread, and an `a` key to ask Claude a read-only clarifying question about the issue before you commit to it. Press `s` to see your team's **triage on-call rotation**, pulled from Linear's "Triage responsibility" schedule (current shift and your own shifts highlighted). See the [Dashboard → Triage actions](dashboard.html#triage-actions) reference for the full keymap.

### Branch naming

Linear's parser is permissive: any uppercased letter prefix + dash + digits anywhere in the branch matches. See [Branch naming](configuration.html#branch-naming).

---

## GitHub Issues

Santree uses the existing `gh` CLI — no separate OAuth.

### Auth

```bash
# Verify gh is authenticated; flip this repo's tracker to GitHub
santree github auth
```

`gh` owns its own token; santree never writes a GitHub token of its own.

### What gets fetched

Issues are listed via `gh search issues --assignee=@me --state=open --repo <owner>/<name>` — current repo only. Cross-repo issues aren't surfaced today.

- Title, body, comments
- State (open / closed)
- Labels — priority is derived from labels matching `P0` / `P1` / `P2` / `P3` / `urgent` / `critical` / `high` / `medium` / `low`, falling back to "No priority"
- Project name = `repository.nameWithOwner`
- Attached images on `user-images.githubusercontent.com` and `github.com/.../assets/` are downloaded so Claude can read them when filling PR templates

### Empty dashboard?

{: .important }
> `gh search issues --assignee=@me` returns nothing if the issues you care about aren't *assigned* to you. GitHub Projects affiliation doesn't count — assignees do. If your team uses Projects without assignees, self-assign the issues you're working on.

### Branch naming

{: .note }
> GitHub's branch parser is strict to avoid false positives — a commit-style branch like `fix-typo-1` would otherwise match issue 1. See [Branch naming]({{ site.baseurl }}/configuration.html#branch-naming) for the accepted patterns.

---

## Cross-tracker resolution (Reviews tab)

When the Reviews tab encounters a PR whose branch was created using another tracker's convention (e.g. a Linear-style `TEAM-1234-…` branch in a repo configured for GitHub Issues), santree's `getCandidateTrackers()` falls back to other trackers with active credentials. If Linear is authed, the Linear ticket context shows up in the PR detail panel even though the repo's active tracker is GitHub.

This is by design — your repo is configured one way, but contributors may use whatever convention they like.
