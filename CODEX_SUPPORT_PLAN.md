# Codex CLI support — implementation plan

Goal: make the AI agent backend **pluggable** so santree can drive **OpenAI Codex CLI** (`codex`) as an alternative to Claude Code, selectable from `santree config`. Default stays Claude. "Full support" = port everything Codex can actually do, and degrade gracefully (capability-gated) where it can't.

Pattern to follow: this is a third instance of santree's existing **pluggable-backend** shape — `lib/trackers/` (`getIssueTracker()` + `canMutate`/`supportsTriage` flags) and `lib/multiplexer/` (`getMultiplexer()` adapter list). UI gates on **capability flags**, never on `kind === "codex"`.

---

## What ports, what degrades, what's lost

| Capability | Claude | Codex | Plan |
|---|---|---|---|
| Headless (`claude -p`) | ✅ | ✅ `codex exec` + `-o <file>` | **Port** (Phase 2) |
| Interactive launch | ✅ | ✅ `codex` | **Port** (Phase 2) |
| Model flag | ✅ `--model` | ✅ `--model`/`-m` | **Port** (Phase 2) |
| Autonomous run | `--permission-mode auto` | `--sandbox workspace-write --ask-for-approval never` | **Port** (Phase 2) |
| Plan mode | `--permission-mode plan` | `--sandbox read-only` (loose) | **Map** (Phase 4) |
| Read-only tool gate | `--allowedTools Read,Grep,Glob` | `--sandbox read-only` (coarse) | **Map** (Phase 4) |
| Resume | `--resume <id>` (cwd-scoped) | `codex exec resume <id>` / `resume --last` | **Port w/ caveat** (Phase 2) — Codex can't *preset* a session id |
| Version/install | `@anthropic-ai/claude-code` | `@openai/codex` (native binary) | **Port** (Phase 2/3) |
| Instruction file | `CLAUDE.md` | `AGENTS.md` | **Map** (Phase 6) |
| Investigate via skill | `/<skill> <id>` | skills / free-form prompt | **Map** (Phase 6) |
| `pr fix` loop | `/loop` self-paced (`ScheduleWakeup`) | ❌ no self-scheduling | **Reimplement** as santree-driven loop (Phase 5) |
| Statusline | ✅ scriptable hook | ❌ none (openai/codex#17827) | **Drop row** when Codex active (Phase 4) |
| Remote control | `~/.claude.json` | ⚠️ WebSocket app-server, different model | **Drop row** when Codex active (Phase 4) |
| Dashboard "Tasks" | `~/.claude/todos/*.json` | ❌ no external file | **Hide section** when Codex active (Phase 4) |
| MCP / hooks | ✅ | ✅ (no `Notification`/statusline hook) | santree manages neither today — no work |

Three hard losses on Codex: **scriptable statusline, self-paced loop, readable todos**. All other features port or map.

---

## Phase 0 — Spike: confirm the uncertain Codex behaviors (½ day)

These came back "not in the docs" from research; verify hands-on with `codex` installed before committing to Phases 2/5/6. Don't build on guesses.

- [ ] **Headless final-message capture** — does `codex exec "prompt" -o /tmp/out.md` write *only* the final assistant message (clean, like `claude -p --output-format text`)? Try `--json` JSONL as fallback.
- [ ] **Session id preset** — confirm Codex **cannot** be told a session id up front (Claude's `--session-id`). If true, santree's "generate id per ticket, store in git config, `--resume` it" pattern must change to cwd-scoped `codex exec resume --last`.
- [ ] **Resume cwd-scoping** — confirm `codex resume`/`exec resume` is cwd-scoped (and `--all` lifts it), matching the Claude caveat santree already handles.
- [ ] **Skill/prompt invocation from a launched session** — how does a non-interactive/new-window run trigger a reusable workflow? (skills vs deprecated custom prompts vs just inlining the prompt). Determines the investigate flow.
- [ ] **Plan/read-only mapping** — `--sandbox read-only --ask-for-approval never` actually prevents writes end-to-end.
- [ ] **Rollout JSONL** — does `~/.codex/sessions/YYYY/MM/DD/*.jsonl` contain plan/todo items in a parseable form? (decides whether the Tasks section can be salvaged later instead of just hidden).

Output: a short findings note appended here; adjust later phases accordingly.

---

## Phase 1 — Agent abstraction + refactor (no behavior change)

Introduce `lib/agents/` and make `lib/ai.ts` delegate to it. Claude stays the only/default backend — this phase is a pure refactor, fully shippable on its own.

**New `source/lib/agents/types.ts`:**

```ts
export type AiAgentKind = "claude" | "codex";

export interface LaunchOpts { planMode?: boolean; sessionId?: string; resume?: boolean; cwd?: string; }
export interface HeadlessOpts { readOnly?: boolean; allowedTools?: string[]; cwd?: string; }
export interface RunResult { success: boolean; output: string; }

export interface AiAgent {
  readonly kind: AiAgentKind;
  readonly displayName: string;        // "Claude Code" / "Codex"
  readonly installPackage: string;     // npm package for install/version rows

  resolveBinary(): string | null;
  getInstalledVersion(): Promise<string | null>;

  launchInteractive(prompt: string, opts?: LaunchOpts): ChildProcess;
  runHeadless(prompt: string, opts?: HeadlessOpts): RunResult;          // sync (CLI)
  runHeadlessAsync(prompt: string, opts?: HeadlessOpts): Promise<RunResult>; // Ink

  buildResumeCommand(sessionId: string | null, cwd: string): string;   // for dashboard resume

  // capability flags — UI/feature gates read these
  readonly canPresetSessionId?: boolean;   // claude ✓  codex ✗
  readonly supportsStatusline?: boolean;   // claude ✓  codex ✗
  readonly supportsRemoteControl?: boolean;// claude ✓  codex ✗
  readonly supportsReadableTodos?: boolean;// claude ✓  codex ✗
  readonly supportsSelfPacedLoop?: boolean;// claude ✓  codex ✗
  readonly supportsSlashSkills?: boolean;  // claude ✓  codex ?  (Phase 0)

  // optional capabilities (feature-detected, like canMutate/getTriageSchedules)
  readTodos?(sessionId: string): TodoItem[];
  findSessionCwd?(worktreeRoot: string, sessionId: string): string | null;
}
```

**New `source/lib/agents/index.ts`** — factory mirroring `getIssueTracker()`:

```ts
export function getAiAgent(): AiAgent {
  // 1. SANTREE_AGENT env override ("claude" | "codex")
  // 2. getConfiguredAgent() from config-store (~/.config/santree/config.json)
  // 3. default "claude"
}
export function getActiveAgentKind(): AiAgentKind;
```

Selection is **global** (which CLI you have installed), not per-repo — so it lives in `config-store.ts`, alongside `editor`/`diffTool`, not in `.santree/metadata.json`.

**`source/lib/config-store.ts`:** add `agent?: AiAgentKind` to `SantreeConfig`; add `getConfiguredAgent()` (env `SANTREE_AGENT` → file → `"claude"`).

**Refactor `source/lib/ai.ts`:**
- Move the current Claude flags into `source/lib/agents/claude/index.ts` (`ClaudeAgent` implementing `AiAgent`). It owns `resolveClaudeBinary()` (move it here; re-export from `ai.ts` for back-compat), the `--permission-mode`/`--session-id`/`--resume`/`-p --output-format text`/`--allowedTools` logic verbatim, `supportsStatusline/RemoteControl/ReadableTodos/SelfPacedLoop = true`, `canPresetSessionId = true`.
- `launchAgent()` / `runAgent()` / `runAgentAsync()` in `ai.ts` become thin wrappers: `getAiAgent().launchInteractive(...)` etc. All existing call sites (`worktree/work`, `pr/review`, `pr/create`, `worktree/commit`, `askTicketQuestion`) keep working unchanged.
- `resolveAgentBinary()` (already a `@deprecated` alias) → `getAiAgent().resolveBinary()`.

**`source/lib/version.ts`:** `getInstalledClaudeVersion()` → keep, but add `getInstalledAgentVersion()` delegating to `getAiAgent().getInstalledVersion()`; `CLAUDE_CODE_PACKAGE` joined by an agent-provided `installPackage`.

**Acceptance:** all existing Claude flows behave identically; `SANTREE_AGENT=claude` is a no-op; `npm run build` + lint clean. No Codex code yet.

---

## Phase 2 — Codex adapter: Tier-A parity

`source/lib/agents/codex/index.ts` — `CodexAgent implements AiAgent`. Flags from Phase 0 findings.

- **resolveBinary():** `which codex` → fallback known install path. No cmux-bundled variant.
- **getInstalledVersion():** `codex --version` parse; `installPackage = "@openai/codex"`.
- **launchInteractive(prompt, opts):**
  - `planMode` → `--sandbox read-only`; else `--sandbox workspace-write --ask-for-approval never`.
  - `resume` → `codex resume <id>` (or `resume --last` if `!canPresetSessionId`); new → plain `codex` (no `--session-id`). Prompt as positional/`--` arg.
- **runHeadless / runHeadlessAsync:** `codex exec <prompt> -o <tmpfile>` → read tmpfile as `output` (clean final message). `readOnly` → `--sandbox read-only`. Map `allowedTools` presence → read-only sandbox (no per-tool list).
- **buildResumeCommand(id, cwd):** `cd <cwd> && codex resume <id|--last>`.
- Capability flags: `supportsStatusline/RemoteControl/ReadableTodos/SelfPacedLoop = false (undefined)`, `canPresetSessionId = false`, `supportsSlashSkills` per Phase 0.
- Reuse `promptArg()` ARG_MAX handling and `getConfigured* ` shell-escaping helpers from `ai.ts`.

**Session-id divergence (`worktree/work.tsx`):** today it generates a UUID, stores via `setSessionId(repoRoot, ticketId, …)`, passes `--session-id`/`--resume`. For Codex (`!canPresetSessionId`): on first launch, don't preset; on re-entry, resume via the agent's cwd-scoped `resume --last`. Gate this branch on `agent.canPresetSessionId`. Keep the git-config session store for Claude only.

**Acceptance:** with `SANTREE_AGENT=codex`, `worktree work`, `pr review`, `worktree commit --fill`, `pr create` (fill), and triage `ask` all run on Codex and return sane output. Verified manually.

---

## Phase 3 — `santree config`: backend selector + install/version rows

**`source/lib/setup/steps.ts`:**
- New **select** step `id: "agent"`, scope `system` (or global), `options: [{value:"claude",label:"Claude Code"},{value:"codex",label:"Codex"}]`, `apply(choice) → setConfigValue("agent", choice)`, no `unapply`. Mirrors the `editor`/`diff-tool` select rows.
- Replace the hard-coded `claude` install step with an **agent-driven** one: title/detail/`installPackage` come from `getAiAgent()` (so when Codex is active it installs `@openai/codex` and detects `codex`). Keep `gh` etc. unchanged.

**`source/commands/config.tsx`:** `currentConfigValue("agent")` returns the resolved backend for the select row. Add `"agent"` to `ROW_ORDER` in the System section. `stepToRow` already turns `options`-bearing steps into selects — no new row kind.

**`source/lib/config/diagnostics.ts`:** the Claude version/update info row generalizes to the active agent (path, version, latest, update hint via `installPackage`). cmux-bundled hint stays Claude-only (gate on kind in the *diagnostics* string — allowed, it's the backend-named reporting surface).

**Adaptive options (the core ask):** rows appear/disappear purely via capability flags + `detect`:

| Row | Claude active | Codex active |
|---|---|---|
| Agent install/version | Claude Code / `@anthropic-ai/claude-code` | Codex / `@openai/codex` |
| Statusline (toggle) | shown | `detect: "unavailable"` → dropped (`!supportsStatusline`) |
| Remote control (toggle) | shown | dropped (`!supportsRemoteControl`) |
| Scaffold instruction file | CLAUDE.md | AGENTS.md (Phase 6) |

Implementation: in `buildSteps()`, gate the `statusline` and `remote-control` steps on `getAiAgent().supportsStatusline` / `supportsRemoteControl`; when false, set `detect: "unavailable"` (the panel already filters those out, and `--check` already skips them). No panel-level special-casing.

**Acceptance:** selecting Codex in `santree config` instantly removes the statusline + remote-control rows and swaps the install/version row; selecting Claude restores them. `--check` reflects the active agent.

---

## Phase 4 — Capability-gated degradations elsewhere

- **Statusline command** (`commands/helpers/statusline.tsx`, `lib/claude-config.ts`): unchanged and Claude-only by nature. Just ensure nothing tries to configure it when `!supportsStatusline` (handled in Phase 3).
- **Dashboard "Tasks" section** (`lib/claude-todos.ts` + DetailPanel): wrap reads in `agent.readTodos?.(...)`; when the optional method is absent (Codex), DetailPanel omits the Tasks section. Feature-detect, exactly like `canMutate`.
- **Dashboard resume** (`dashboard.tsx`): build the resume command via `agent.buildResumeCommand(...)` and `agent.findSessionCwd?.(...)`; if `findSessionCwd` absent, fall back to `cd <worktreeRoot> && <resume --last>`.
- **Plan mode / read-only**: already handled in the adapter via sandbox mapping (Phase 2).

**Acceptance:** on Codex, the dashboard renders cleanly with no Tasks section and a working resume; on Claude, identical to today.

---

## Phase 5 — `pr fix` loop on Codex (santree-driven)

Codex has no `/loop`/`ScheduleWakeup`. Reimplement the loop **outside** the agent, reusing the existing stateless brain.

- **`source/commands/pr/fix.tsx`:** branch on `agent.supportsSelfPacedLoop`.
  - **true (Claude):** today's path — `launchInteractive("/loop " + fix-loop.njk)`, unchanged.
  - **false (Codex):** santree owns the loop. A `while` loop in the command:
    1. `fetchAndRenderFixContext(branch, santreeCmd)` → the same brief + computed `directive`.
    2. If `directive ∈ {stop-clean, stop-stuck}` → exit. If `wait` → sleep ~5 min (or poll), continue. If `merge`/`work` → run `agent.runHeadlessAsync(brief)` with write sandbox, then push, then resolve approved threads (existing `resolveReviewThread`).
    3. Heartbeat the `.santree/fix-loops/<ticketId>.json` marker each iteration (existing `lib/fix-loop.ts`), so the dashboard `⟳` badge works identically.
    4. Track the "tried-a-fix-twice → stuck" judgment in the loop variable (the stateless command can't, but the owning process can).
  - Reuse `prompts/fix-context.njk` verbatim; the directive logic in `lib/github.ts` is agent-agnostic already.
- The marker/dashboard plumbing (`readFixLoopRuntime`, `FIXLOOP_START`, badge) needs **no change** — it's timestamp-based.

**Acceptance:** `SANTREE_AGENT=codex santree pr fix` drives CI-fix + 👍-approved review-thread application across iterations and self-terminates on clean/stuck, with the dashboard badge live. Claude path byte-identical to today.

---

## Phase 6 — Instruction files, skills, investigate

- **Scaffold step** (`steps.ts` `scaffold`): write `AGENTS.md` when `getAiAgent().kind === "codex"`, `CLAUDE.md` otherwise (or always-AGENTS since it's cross-vendor — decide in Phase 0). 
- **Investigate triage** (`lib/triage-config.ts`, `dashboard.tsx`): `buildInvestigateCommand` already takes the resolved binary. Gate the skill-slash form (`/<skill> <id>`) on `agent.supportsSlashSkills`; when false (Codex, pending Phase 0), require the free-form `prompt` template (`{ticket_id}`) and render the `[i]` action's unconfigured-hint accordingly. Pass through Codex's skill mechanism if Phase 0 finds one.

**Acceptance:** investigate launches a working Codex window for a configured prompt; scaffold writes the right instruction file.

---

## Phase 7 — Docs + release

Per CLAUDE.md, docs are part of the deliverable:
- [ ] `docs/`: new "AI agent backend" page (Claude vs Codex, capability matrix, `SANTREE_AGENT`), update `config`, `pr fix`, env-vars, and external-dependencies pages.
- [ ] `CLAUDE.md`: document `lib/agents/` abstraction, `SANTREE_AGENT`, capability flags, the Codex fix-loop divergence.
- [ ] `README` / install docs: Codex as an alternative agent.
- [ ] `/bump-version` (minor — new feature).

---

## File-touch summary

| Area | Files | Phase |
|---|---|---|
| New abstraction | `lib/agents/{types,index}.ts`, `lib/agents/claude/index.ts`, `lib/agents/codex/index.ts` | 1–2 |
| Delegate | `lib/ai.ts`, `lib/version.ts`, `lib/config-store.ts` | 1–2 |
| Config UI | `lib/setup/steps.ts`, `commands/config.tsx`, `lib/config/diagnostics.ts` | 3 |
| Degradations | `lib/claude-todos.ts`, `commands/dashboard.tsx`, DetailPanel | 4 |
| Fix loop | `commands/pr/fix.tsx` | 5 |
| Instruction/investigate | `lib/setup/steps.ts` (scaffold), `lib/triage-config.ts`, `dashboard.tsx` | 6 |
| Docs | `docs/`, `CLAUDE.md`, `README` | 7 |

## Sequencing & risk

- Phases 1 and 3 are independently shippable (refactor + selector), low risk, no Codex needed.
- Phase 0 gates 2/5/6 — do it first.
- Highest-risk item: **Phase 5** (loop reimplementation) and the **session-id divergence** in Phase 2. Both are isolated behind capability flags, so Claude is never affected.
- Keep the rule: **no `kind === "codex"` outside the factory / diagnostics strings** — gate on flags.
