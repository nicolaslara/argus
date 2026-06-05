# interact — decision-ready design

**Status:** exploratory design + spike plan (the workpad gate). This document does
**not** authorize a build. It defines the candidate mechanisms, the recommended first
approach, the smallest reversible spike, the write-safety model, and the open
questions. **Hard constraint (the interact gate):** nothing here changes argus's
proven read-only path — the adapter (`packages/adapter`), the run model
(`packages/contract`), and the web app's read-only consumption stay byte-for-byte
untouched. Every interact capability is a **separate, opt-in, default-OFF seam** that
lives server-side in `apps/server` behind a flag + the existing bearer-token / Host /
Origin gates.

Synthesized from four research threads (all primary-source, dated 2026-06-05): ACP +
the official Claude ACP adapter; the headless `claude -p` CLI / Claude Agent SDK;
session-jump (`claude --resume` + deep links); and embedded-agent safety/UX prior art
(Zed / Copilot / Claude IDE). Confidence is **high** on protocol/CLI/SDK surfaces
(verified against spec text, local `claude 2.1.162 --help`, a captured `stream-json`
run, and the SDK TS docs), **medium** on Claude-subscription auth viability through the
ACP adapter and on SDK pre-1.0 field stability.

---

## 0. Goal restated

From a run shown in argus, let the user:
- **(A) Jump into that session** — open / resume the exact Claude Code session that
  produced the run (or branch from it), with the least new mechanism.
- **(B) Run an embedded agent** in the target **project dir** (`cwd = RunRef.projectPath`)
  to **review and modify** that project's `.claude/workflows/*.js`, then **re-run** the
  workflow — with writes strictly gated and isolated.

These are **two distinct mechanisms** (the research is unanimous on this):
- **(A) jump-in** is a pure UI affordance / handoff — argus writes nothing, drives
  nothing. Cheapest, zero risk to the read path. Ship-ready as designed.
- **(B) embedded edit** is a real coding agent that *writes*. It needs a gate, isolation,
  and a flag. It is the actual spike.
- **"Re-run the workflow"** is a third action and is *free*: a re-run produces a new
  `wf_*.json` that argus's **existing read path renders with zero new code** — the
  dogfood loop closes itself.

---

## 1. Decision matrix

Six candidates × six criteria. Effort: **S** ≈ 1–2 days, **M** ≈ several days, **L** ≈
week+. "Read-only seam" = does it stay strictly additive / off the proven read path.

| Candidate | Effort | Fits read-only seam | Write-safety / permission control | Streaming UX | Session continuity | Maintenance / risk |
|---|---|---|---|---|---|---|
| **1. Headless `claude -p` CLI** (`--output-format stream-json --verbose`, `--permission-mode`, `--allowedTools`) | **S** review-only / **M** gated-write | **Yes** — same spawn discipline as `explain.ts`; server-only | Coarse: `--permission-mode plan` (read-only) is a clean review floor; per-edit human approval needs hand-built stdin `stream-json` round-trips (brittle) | Good: parse NDJSON (`init`/`assistant`/`stream_event`/`result`) → bridge to existing SSE. `result.permission_denials[]` = built-in audit trail | Strong: `--resume <id>` / `--session-id` / `--fork-session`; shares session store with the SDK | Low-new-dep (argus already shells `claude`); but reproducing per-call approval over raw stdin is exactly the plumbing the SDK removes |
| **2. Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk` `query()` + `canUseTool` + `disallowedTools`) | **M** | **Yes** — additive `apps/server` module + new gated routes; separate from read path | **Best in class.** `canUseTool` fires per tool call, returns a Promise → server parks it, emits SSE permission card, resolves on the user's click. Eval order is binding: Hooks → **deny rules** → mode → allow rules → `canUseTool`. `disallowedTools` is a deny floor that holds even under bypass. `.claude/` is a protected path → prompts even in `acceptEdits` | Best: typed `SDKMessage` stream; `interrupt()`, `setPermissionMode()` live control; `includePartialMessages` token deltas | Strong: `resume`, `resumeSessionAt`, `forkSession`, `continue`; resumes CLI/workflow-created sessions by id | Pre-1.0 (`0.3.165`) → field churn; new dep. Spawns the same `claude` binary under the hood, so it's a typed wrapper, not a second engine. Mitigate: pin + keep CLI fallback |
| **3. ACP** (`@agentclientprotocol/claude-agent-acp` over stdio, server = ACP client) | **S** read-only spike / **M** gated-write | **Yes** — JSON-RPC stays server-side; browser never sees it; server bridges `session/update` → existing SSE | **Strong, by design.** ACP inverts control: the **client owns** `fs/write_text_file`, `terminal/*`, and `session/request_permission` — argus's server *is* the only thing that can satisfy a write/permission, a natural enforced gate. Capabilities only fire if the client advertises them (deny-by-default for free) | Good: `session/update` notifications stream; `session/load` **replays full history** as updates → reconstruct prior state | **Best.** `loadSession: true` + `sessionCapabilities {list, resume, fork, close}`; `listSessions({dir})` enumerates a project's sessions; `loadSession`/`resumeSession`/`forkSession` are built-in — "list sessions for this dir → load/resume" is not invented | Official, Apache-2.0, maintained (v0.41.0). But ACP young + churning (SDK v0.24, remote transport unfinished); wraps the Agent SDK so inherits its auth nuance; **heavier protocol than one-file editing needs in v1** |
| **4. `claude --resume` session-jump** (copy command / server `open`s a terminal in `cwd=projectPath`) | **S** | **Yes** — argus writes nothing, runs nothing (or only spawns a user terminal) | N/A — argus relinquishes control to the user's own CLI session; the user's normal CC permission UX applies | None inside argus (handoff). Optional: pre-fill the resume command | **Exact session resume.** `RunRef.sessionId` is the `--resume` key as-is (verified on disk). Workflow/`-p` sessions **don't show in the picker** → known id is the only clean way in. Prefer `--fork-session` to avoid transcript interleave | Minimal. Lowest-mechanism honest default |
| **5. Deep-link to IDE / terminal** (`vscode://anthropic.claude-code/open?session=<id>`; `claude-cli://open?cwd=&q=`) | **S–M** | **Yes** — plain URL the web app navigates or server `open`s; no `.claude` writes | N/A — same as #4 (hands to the user's editor/CLI) | None inside argus | **VS Code link resumes by `session` id** (one-click, exact session) **if the project is the open workspace**. `claude-cli://` has **no resume param** — opens a fresh session in the right `cwd` with a pre-filled prompt (requires CC v2.1.91+) | Low. Dependency on VS Code + extension / OS URL handler; workspace-match caveat |
| **6. Remote Control** (`claude remote-control`, drives a *live* local session) | **M** | **No** — **routes all traffic through the Anthropic API over TLS**; violates "web talks only to its own origin" + "never copy run/transcript content off-machine" | Drives a running session incl. `--spawn worktree`, but the relay itself is the problem | Via Anthropic relay, not argus's own SSE | Drives a **live** session (the one thing resume can't) | **High / out of scope.** claude.ai-OAuth-only (no API keys); cloud relay conflicts with stances. Research R2 already deferred it here — **defer again**, loud-opt-in future only |

**Reading the matrix:** #4/#5 are the cheap, zero-risk *jump-in* answer. #2 (SDK) and
#3 (ACP) are the two real *embedded-edit* contenders — both keep the read path intact,
both give a strong gate. #1 (raw CLI) is the cheapest *review-only* spike but degrades
for gated writes. #6 is disqualified by the privacy stance.

---

## 2. Recommendation

### Ship now (jump-in, mechanism A) — zero new risk
- **Primary, always:** **#4 copy-the-resume-command** — a button on a run that yields
  `claude --resume <RunRef.sessionId>` (offer `--fork-session` to avoid interleave),
  runnable in `cwd = RunRef.projectPath`. argus already has both values. Honest default
  given the deep-link gap (only VS Code resumes by id; `claude-cli://` cannot resume).
- **Best one-click, conditional:** **#5 VS Code `?session=<id>` deep link** when an IDE
  is detected (a live `~/.claude/ide/*.lock`, `0600`, `127.0.0.1`). The single affordance
  that opens the **exact** session in one click with no terminal spawning.
- **Secondary one-click:** **#5 `claude-cli://open?cwd=<projectPath>&q=<prefilled>`** —
  lands the user in the right dir with the resume command pre-typed; be explicit in the
  UI that it does **not** itself resume.

These are pure UI affordances. They need **no flag and no write gate** and can land in
the read-only app without touching the read path (they add UI + at most a `POST` that
shells `open <url>`).

### Spike first (embedded edit, mechanism B) — the recommended first approach
**Recommended primary mechanism: the Claude Agent SDK (#2), server-side, behind a
default-off flag.** Why over the alternatives:
- vs **raw CLI (#1):** `canUseTool` is the headline capability — a per-tool-call Promise
  the server resolves on a human click. It's the in-process equivalent of a UI approval
  prompt and the cleanest seam to render a diff and block until Accept/Reject.
  Reproducing that over raw stdin `stream-json` is the brittle plumbing the SDK exists to
  remove. Keep raw `claude -p` for the existing annotation path (`explain.ts` /
  `subui.ts`) — don't migrate it.
- vs **ACP (#3):** ACP is conceptually the *better long-term contract* (client-owns-
  resources forces the gate; standardized across Gemini/Codex; `listSessions`/`loadSession`
  are built in) and is the **strong second choice** — but for **v1 editing of one
  `.js` file** the full JSON-RPC-over-stdio protocol + subprocess lifecycle is heavier
  than needed, and it wraps the same Agent SDK so it inherits the same auth nuance with
  more surface. **Revisit ACP** the moment argus wants (a) multi-agent / multi-vendor
  drive, or (b) first-class list/load/resume/fork of arbitrary sessions — those are ACP's
  natural strengths.
- The SDK + CLI both spawn the same local `claude` binary, use the user's own local
  auth, touch only local files — fully consistent with argus's privacy posture.

**De-risking ramp inside the spike:** start with the CLI's `--permission-mode plan`
(read-only review, zero write risk, reuses `explain.ts`'s runner + an NDJSON line parser)
to prove the stream→SSE bridge cheaply, then adopt the SDK only for the gated-write turn.

### Explicitly do NOT do yet
- **Do not build Remote Control (#6)** for this path — it relays through Anthropic's
  cloud, violating the localhost / own-origin / no-off-machine stances. Note it only as a
  future, loud-opt-in "drive a live session" feature.
- **Do not implement the ACP wire protocol in v1** — overkill for one-file editing;
  reserve for multi-vendor / full session management.
- **Do not run any embedded agent in `bypassPermissions`, ever.** And prefer **no
  subagents** (subagents inherit a loose parent mode and can't be reined in per-subagent).
- **Do not migrate `explain.ts` / `subui.ts`** off raw `claude -p` — that path is correct
  as-is.
- **Do not write anywhere except `<projectPath>/.claude/workflows/`** (and the worktree
  under `<projectPath>/.claude/worktrees/`) — never into the `~/.claude/projects/<slug>`
  journal tree argus *reads*.
- **Do not turn the interact seam on by default**, and do not let the read-only web
  canvas import the interact UI (lazy-loaded panel only).

---

## 3. Spike plan (X4) — smallest experiment, off the read-only path

**Hypothesis:** the server can run a Claude Agent SDK `query()` in `cwd = projectPath`
that makes **one trivial, human-approved, isolated edit** to a `.claude/workflows/*.js`
file, stream it into the existing SSE channel, and prove Accept lands the change / Reject
leaves it clean — **with the read path provably unchanged.**

**Scope (build exactly this, nothing more):**
1. **New server-only module** `apps/server/src/interact.ts`, mirroring `explain.ts`'s
   injected-runner DI so it is unit-testable with a fake runner and never spawns in tests.
   It launches `query()` with: `cwd: run.ref.projectPath`, `settingSources:["project"]`,
   `permissionMode:"default"`, a `disallowedTools` **deny floor**, `allowedTools` scoped
   to `Read/Grep/Glob/Edit/Write`, and a `canUseTool` callback wired to the UI gate.
2. **Two phases, two modes:**
   - **Review turn:** `permissionMode:"plan"` (read-only; Claude proposes, never edits) +
     `allowedTools:["Read","Grep","Glob"]`. Streams analysis. Zero write risk.
   - **Modify turn:** `permissionMode:"default"` + `disallowedTools:["Bash", …destructive]`
     + a `canUseTool` that **only** allows `Edit`/`Write` whose `resolve()`d target is
     inside `<projectPath>/.claude/workflows/` (or the worktree), and bounces every such
     write to the UI for explicit approval; everything else → deny.
3. **Isolation:** the **first write spins up a git worktree** under
   `<projectPath>/.claude/worktrees/argus-<runId>` (the one writable exception inside the
   otherwise-protected `.claude` tree). Edits land on `worktree-argus-<runId>`; the live
   tree is never touched; cleanup = delete the branch.
4. **Stream to web via the existing SSE machinery** (`index.ts::handleStream`,
   `text/event-stream`, token-gated, `127.0.0.1`-bound). Map each `SDKMessage`:
   `assistant`/`stream_event` → progress text; a `canUseTool` invocation →
   `permission_request` SSE event the UI renders as a **diff Accept/Reject card**;
   `result` → done (+ `permission_denials[]` audit).
5. **Approval round-trip:** `canUseTool` returns a Promise; the server parks it in a map
   keyed by `toolUseID`, emits the SSE `permission_request`, and resolves it when the web
   POSTs the decision to a **new gated** `POST /api/interact/:id/decision`.
6. **New routes, default-OFF behind a config flag**, all behind the **existing** bearer
   token + Host/Origin checks: `POST /api/interact/:slug/:session/:runId/start`,
   `GET …/stream` (or reuse the SSE channel), `POST …/decision`. The web `interact` panel
   is **lazy-loaded**; the read-only canvas never imports it.
7. **Re-run (optional stretch):** run the workflow *from the worktree*; the new `wf_*.json`
   flows back through the **existing read path** unchanged → closes the dogfood loop.

**Acceptance criteria:**
- [ ] With the flag **off**, the server, adapter, contract, and web read path are
  **byte-for-byte unchanged**; all existing read-path tests pass untouched. A test asserts
  the interact routes return 404/disabled when the flag is off.
- [ ] **Review turn** streams a read-only analysis of a chosen `.claude/workflows/*.js`
  to the UI via SSE with **zero** filesystem writes (assert no write in `plan` mode).
- [ ] **Modify turn:** a proposed `Write`/`Edit` surfaces as a diff card; **Accept** lands
  the change **only inside the worktree branch**; **Reject** leaves the worktree clean and
  the working tree pristine.
- [ ] Any write targeting a path **outside** `<projectPath>/.claude/workflows/` (or the
  worktree) is **denied** by `canUseTool` and recorded in `permission_denials[]`. A path-
  escape fixture (`../`, symlink, absolute) is denied.
- [ ] No process ever runs with `bypassPermissions`; `disallowedTools` deny floor verified
  to block even when a mode would allow.
- [ ] Disconnect / cancel calls `interrupt()`; `--max-turns` / `maxBudgetUsd` cap runaway.
- [ ] Logs contain no file contents, no `/Users/`, no `$bunfs` (reuse the existing
  redaction test).
- [ ] **(stretch)** A re-run from the worktree produces a new `wf_*.json` that the
  existing read path renders with no new code.

**Reversibility:** the entire spike is a flag-off-by-default module + new routes + a
lazy panel; deleting the worktree branch undoes every write; removing the flag removes
the seam.

---

## 4. Safety model

Defense in depth — five layers, none of which the read path depends on.

- **L1 — Scope.** The agent runs with `cwd = RunRef.projectPath`; `additionalDirectories`
  unset. It operates on the **project's own files**, never the `~/.claude/projects/<slug>`
  journal tree argus reads.
- **L2 — Deny floor (`disallowedTools`).** Patterns (`Bash(rm *)`, network `curl|bash`,
  writes outside cwd) that hold **even under bypass** and are evaluated **before** the
  mode check. Binding eval order: Hooks → deny rules → permission mode → allow rules →
  `canUseTool`. Built-in backstop: `.claude/` is a **protected path** — even `acceptEdits`
  prompts for writes into it; `.claude/worktrees` is the deliberate writable exception.
- **L3 — Interactive diff gate (`canUseTool`).** Default is **prompt-per-edit**: every
  `Write`/`Edit` blocks on a diff modal in the UI; the Promise resolves only on the user's
  Accept/Reject (it can return `updatedInput` to apply a user-edited version). An opt-in
  "auto-accept edits for this session" maps to `acceptEdits` (still gated by the `.claude`
  protected-path prompt). **No `bypassPermissions`, ever.** Prefer no subagents.
- **L4 — git worktree isolation.** First write creates `.claude/worktrees/argus-<runId>`
  on its own branch; edits never touch the main checkout; review = a normal git diff;
  merge-back is the **user's explicit** `git merge`/PR — argus never auto-merges.
  Reversible by deleting the branch. (Caveat: target must be a git repo — argus's dogfood
  targets are; deps/`.env` aren't copied unless a `.worktreeinclude` exists, so a re-run
  may need `npm install` in the worktree.)
- **L5 — Privacy / origin.** Server-side only; the browser keeps talking **only to its own
  origin** over the existing token-gated HTTP+SSE on `127.0.0.1`. JSON-RPC/agent stdio
  never reaches the browser. **No Anthropic cloud relay (no Remote Control)** in this path
  — prompts/transcripts never leave the machine. Reuse the existing redaction (no
  `/Users/`, no `$bunfs` in logs; codes not raw text in `warnings[].detail`). Permission
  cards render previews/diffs as **text nodes only** (the existing XSS posture).

**How the read path stays untouched (the gate):** the interact seam is a **separate
module + separate routes + lazy panel**, all **default-OFF behind a flag**. It does not
modify `packages/adapter`, `packages/contract`, the read-only `FileSystemPort`, the
snapshot/SSE read API, or any existing route. The embedded agent writes only into the
project's own `.claude/workflows/` (via a worktree), never into the journal tree argus
reads; its re-run output flows back through the **existing** read path as a new
`wf_*.json` with no new read-path code. This satisfies "must NOT change the proven read
path" and stance 1 ("advanced connectivity is strictly additive, never a Phase-1
blocker"). The UI slot reuses the existing right detail panel (boundaries §7); the new
write invariant (into another project's `.claude/workflows/`) is the explicit opt-in the
stance requires.

---

## 5. Open questions

1. **Claude-subscription auth through the SDK / ACP adapter (medium confidence).** The ACP
   adapter shows a partial guard around `subscriptionType` ("does not support claude.ai
   subscriptions" on at least the gateway path). **Confirm against the user's own login**
   that the embedded agent authenticates (API-key/Console is the reliable path) before
   committing — this gates whether the embedded-edit spike runs at all on this machine.
2. **SDK pre-1.0 churn (`0.3.165`).** Field/option names may move. Pin the version, keep
   the raw-CLI fallback for the review turn, and treat the SDK adoption as a spike, not a
   commitment.
3. **"Jump into a *live* session" vs resume.** All cheap mechanisms (#4/#5) and the
   SDK/CLI are fundamentally **start-or-resume**, not attach-to-running-TUI. The only thing
   that drives a *live* session is Remote Control (#6, deferred) or a PTY argus hosts
   (out of scope, leaves read-only). Confirm "resume / fork" is acceptable UX for "jump in"
   — the research says yes, and it's the honest default.
4. **VS Code deep-link workspace-match.** The `?session=` link resumes only if the project
   is the **currently open** VS Code workspace; otherwise a fresh conversation starts.
   Decide whether to gate the one-click affordance behind IDE-lock detection
   (`~/.claude/ide/*.lock`) or just surface it with a caveat.
5. **Re-run trigger mechanism.** Re-running the edited workflow is a separate action from
   editing it: (a) a second SDK `query` with `allowedTools:["Workflow"]`, (b) telling the
   user to invoke it, or (c) shelling `claude` in the worktree. Pick one in the spike;
   re-run from the **worktree** so the live tree is never the run target until merged.
6. **Worktree ergonomics for re-run.** A re-run inside the worktree may need
   `npm install` / `.env` (not copied by default). Decide whether to require a
   `.worktreeinclude`, run deps install, or only re-run after the user merges the branch.
7. **ACP revisit trigger.** Define the concrete condition that flips the choice from SDK
   to ACP (multi-vendor drive, or first-class arbitrary-session list/load/resume/fork). If
   either lands on the roadmap, re-evaluate before extending the SDK path.

---

## References

See `workpads/interact/references.md` (X2 jump-in, verified 2026-06-05) and
`workpads/architecture/boundaries.md` §3 (`RunRef.projectPath`/`sessionId`), §4 (the
`127.0.0.1` + bearer-token + Host/Origin + redaction security envelope the interact seam
reuses), §7 (the right detail panel slot the interact UI reuses).

Primary sources (fetched 2026-06-05): agentclientprotocol.com (overview, session-setup,
agents); zed.dev/acp + /docs/ai/external-agents + blog "Claude Code via ACP"; npm
`@agentclientprotocol/claude-agent-acp` v0.41.0 (+ repo `package.json`/`src` via `gh api`);
code.claude.com/docs/en — agent-sdk/typescript, agent-sdk/permissions, permission-modes,
worktrees, remote-control, headless, cli-reference, sessions, deep-links, vs-code; local
`claude 2.1.162 --help` + a captured `claude -p --output-format stream-json` run; argus
`apps/server/src/{explain.ts,subui.ts,index.ts}` (the injected `ClaudeRunner`, the SSE
`handleStream`, the `tokenOk` gate to reuse).
