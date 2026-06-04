# research — knowledge

Decisions, findings, open questions, confidence. **Seeded** below with the on-disk
data contract verified by direct inspection on 2026-06-04 (the strongest evidence
we have for the undocumented format). The `plan-research.js` workflow extends and
hardens this; later findings append under "Findings".

---

## SEED (verified 2026-06-04) — the on-disk workflow data contract

**Confidence: high** for everything tagged *[verified]* (inspected on real runs
under `~/.claude/projects/-Users-nicolas-devel-modal-rust/27b1a6f8-92a6-42eb-a6f1-5f34d8db36b4/`).
*[inferred]* / *[open]* tags mark what still needs confirmation in R3.

### Location & slug

- *[verified]* Runs live under `~/.claude/projects/<project-slug>/<session-id>/`.
- *[verified]* `<project-slug>` = the project's absolute cwd with **every
  non-alphanumeric char replaced by `-`**. Evidence: `/Users/nicolas/devel/modal-rust`
  → `-Users-nicolas-devel-modal-rust`; `/Users/nicolas/.config/ghostty` →
  `-Users-nicolas--config-ghostty` (note the `--` from `/.`);
  `…/zodl-desktop/.claude/worktrees/…` → `…-zodl-desktop--claude-worktrees-…`.
- *[verified]* `<session-id>` is a UUID. A project has many sessions; a session has
  many runs.

### Files in a session dir

| Path | Role | Status |
| --- | --- | --- |
| `workflows/wf_<id>.json` | Finalized run journal (the richest single source) | *[verified]* |
| `workflows/scripts/<name>-wf_<id>.js` | Persisted workflow script source for that run | *[verified]* |
| `subagents/workflows/wf_<id>/journal.jsonl` | Live append-only event stream (resume journal) | *[verified]* |
| `subagents/workflows/wf_<id>/agent-<agentId>.jsonl` | Per-subagent transcript (`isSidechain:true`) | *[verified]* |
| `subagents/workflows/wf_<id>/agent-<agentId>.meta.json` | `{"agentType":"workflow-subagent"}` | *[verified]* |
| `subagents/agent-<id>.{jsonl,meta.json}` | Top-level `Agent`-tool subagents (not workflow-bound) | *[verified]* |
| `tool-results/<id>.txt` | Overflow tool outputs | *[verified]* |

### `wf_<id>.json` shape (finalized run)

*[verified]* top-level fields: `runId`, `timestamp` (ISO), `taskId`, `script`
(inline source), `scriptPath`, `args` (JSON **string**), `result` (the returned
object — arbitrary shape per workflow), `agentCount` (int), `logs` (string[] — the
`log()` narrator lines), `durationMs` (int), `summary` (string), `workflowName`
(string), `status`, `startTime` (epoch ms), `phases` (`{title, detail}[]`),
`defaultModel` (e.g. `claude-opus-4-8[1m]`), `workflowProgress` (the tree, below).

- *[verified]* `status` observed values across 16 runs: `completed`, `failed`,
  `killed`. *[inferred]* `running` while live (before finalize). `agentCount`
  ranged 1–14; `failed`/`killed` runs had `agentCount: 1` in the sample.

### `workflowProgress[]` — the render tree (PRIMARY source)

Two node types *[verified]*:

```jsonc
{ "type": "workflow_phase", "index": 1, "title": "Research", "detail": "…" }

{ "type": "workflow_agent", "index": 1,
  "label": "research:modal-images",
  "phaseIndex": 1, "phaseTitle": "Research",
  "agentId": "a32b0bc2ad23245d2",
  "model": "claude-opus-4-8[1m]",
  "state": "done",
  "startedAt": 1780474963312, "queuedAt": 1780474963296, "lastProgressAt": 1780475106848,
  "attempt": 1,
  "lastToolName": "StructuredOutput",
  "lastToolSummary": "Modal Images — local file inclusion …",
  "promptPreview": "You are researching to ground …",
  "resultPreview": "{\"dimension\":\"Modal Images …",
  "tokens": 33498, "toolCalls": 11, "durationMs": 143535 }
```

So agents carry phase grouping (`phaseIndex`/`phaseTitle`), identity (`agentId` →
links to `agent-<agentId>.jsonl`), `model`, `state`, full timing
(`queuedAt`/`startedAt`/`lastProgressAt`/`durationMs`), retry (`attempt`), last-tool
info, prompt/result previews, and metrics (`tokens`, `toolCalls`). *[verified]* on
the 14-agent `modal-rust-plan-research` run.

### Consequences for argus

- *[verified]* A **finished** run renders entirely from `wf_<id>.json` (tree +
  result + logs + phases + status + timing). Phase 3 (prototype) needs only this
  one file.
- *[inferred]* A **running** run renders by tailing
  `subagents/workflows/wf_<id>/journal.jsonl` (events) + `agent-<id>.jsonl`
  (transcripts) until the finalized `wf_<id>.json` lands. Phase 4 (live).
- *[verified]* **Named workflows** are parseable statically from
  `<project>/.claude/workflows/*.js` via `export const meta = {name, description,
  whenToUse?, phases[], model?}` — argus can list available workflows + declared
  phases even before any run. *[verified]* No global/built-in saved workflows on
  disk under `~/.claude/workflows`; built-ins ship inside the client.

### Contract questions (R3) — mostly RESOLVED 2026-06-04 by direct inspection

Inspected all 16 modal-rust runs + capo runs + argus's own (failed) research run.

- *[verified]* **`workflow_agent.state` in FINALIZED journals** is `done` (1176×) or
  `progress` (6×) — `progress` is an agent caught mid-flight when the run finalized
  (e.g. a killed/failed run). Live `queued`/`running`/`error` are **not** stored in
  the finalized file; they exist only transiently and must be derived from the live
  event stream. So argus's live phase derives queued/running from `journal.jsonl` +
  `agent-*.jsonl`, not from a stored state.
- *[verified]* **No explicit pipeline/parallel/parent/stage/group/edge fields exist.**
  The full union of `workflow_agent` keys across all runs is: `type, index, label,
  agentId, agentType, model, state, cached, attempt, phaseIndex, phaseTitle,
  startedAt, queuedAt, lastProgressAt, durationMs, tokens, toolCalls, lastToolName,
  lastToolSummary, promptPreview, resultPreview`. Agents are grouped **only by
  `phaseIndex`**. ⇒ **argus must INFER concurrency / pipeline structure from timing
  (`queuedAt`/`startedAt`/`durationMs` overlap) and `label` conventions, never from
  explicit edges.** (Two new fields vs the seed: `agentType` and `cached` — `cached`
  = the result came from the resume cache; worth surfacing in the UI.)
- *[verified]* **`journal.jsonl` event schema** is just two types: `{type:"started",
  key, agentId}` and `{type:"result", key, agentId, result}`. The `key` is the v2
  content hash; this file **is the resume cache** (match `key` → reuse `result`). No
  separate error/phase/log events here — narrator `log()` lines and phase markers
  live in the finalized `wf_*.json` (`logs[]`, `phases[]`, `workflowProgress[]`).
- *[verified]* **Running-run detection:** while a run is in progress, the live data
  lives in `subagents/workflows/wf_<id>/` (`journal.jsonl` + `agent-*.jsonl`), and
  `workflows/wf_<id>.json` does **not** exist yet — it is written only at finalize.
  So: `subagents/workflows/wf_<id>/` present **without** `workflows/wf_<id>.json` ⇒
  running. (Corroborated by the tmp signal below: an empty `tasks/w<id>.output`.)
- *[verified]* **Per-agent `tokens` + `toolCalls`** are present; run-level totals are
  derivable (sum) — no stored `$` cost field observed. `agentCount` is stored.
- *[open]* Sub-workflows via `workflow()` — whether a child gets its own `wf_*.json`
  or nests in the parent tree (no nested-workflow run in the dataset yet; revisit).

### SEED (verified 2026-06-04) — runtime/ephemeral state under `/private/tmp/claude-<uid>/`

User tip, confirmed by inspection. Claude Code mirrors per-task output to a tmp
tree, useful for the **live** + **inspect** phases ("see latest output").

- *[verified]* Path: `/private/tmp/claude-<uid>/<project-slug>/<session-id>/tasks/<taskId>.output`
  (`<uid>` = numeric user id, e.g. `501`; same slug rule as `~/.claude/projects`).
  `/tmp/claude-<uid>` is the same tree (macOS `/tmp`→`/private/tmp`).
- *[verified]* `<taskId>.output` semantics by id prefix:
  - **`w<id>.output`** (a workflow) = the workflow's final **result JSON**, written
    on completion; **empty while the workflow is still running** (our live research
    run's `w405q7cl8.output` was 0 bytes mid-run → a clean running signal).
  - **`b<id>.output`** (a Bash/tool call) = the **live, raw stdout stream** of that
    tool call (ASCII, appended in real time).
  - **`<hex>.output`** (an agent id) = that agent's output.
- *[verified]* These tmp `.output` files are **hardlinked** to the durable tree:
  `…/tasks/b<id>.output` shares an inode with
  `~/.claude/projects/<slug>/<session>/tool-results/<id>.txt` (confirmed: inode
  `387447917`). ⇒ The same live tool output is reachable from `~/.claude/projects/`,
  so **argus's file-first stance holds even for live output without depending on
  `/private/tmp`.** The tmp tree is a useful *secondary* signal (esp. empty
  `w<id>.output` = running) but not required, and it is ephemeral (cleared on reboot).
- *[note]* `/private/tmp/claude-<uid>/` also holds large amounts of **unrelated
  scratch** (e.g. 223k `*-<nanosecond-ts>` worktree/sandbox dirs from other tools).
  ⇒ argus discovery must target the **exact derived slug**, never scan tmp broadly.

---

## Findings

The full research synthesis (the phase-1 gate deliverable) is in
[`synthesis.md`](./synthesis.md): Verified Facts → Locked Decisions → Milestone
Plan M0–M11 → User Questions → Residual Risks. Produced by `argus-plan-research`
(run `wf_56991fcb-71b`, 13 agents). Key new facts beyond the seeded contract:

- *[verified, high]* **R1 — client availability.** Claude Code's full source leaked
  2026-03-31 (npm `2.1.88` shipped a 59.8 MB source map → complete ZIP on Anthropic's
  R2; ~512k lines TS). It remains proprietary/closed. **Official workflow docs now
  exist** (`code.claude.com/docs/en/workflows.md`) and the Workflow tool is in the TS
  Agent SDK (v0.3.149+). Neither documents the on-disk format. **argus depends on
  neither the leak nor any API** — read path is observable public files only. v1
  dependency boundary = ZERO client/API dependency.
- *[verified, high]* **R2 — connection.** File-watch (chokidar) suffices for v1.
  ACP / Managed Agents rejected; remote control deferred to interact. Authoritative
  *live* source is `journal.jsonl` tail + `agent-*.jsonl` (correlate by `agentId`),
  **not** a mid-run `wf_*.json` (which doesn't exist until finalize).
- *[verified, high]* **R4 — graph viz.** `@xyflow/react` v12 (React Flow), hand-rolled
  deterministic phase-lane layout as default, elkjs lazy fallback. Svelte Flow
  rejected (alpha); dagre rejected (sub-flow bug).
- *[verified, high]* **R5 — stack.** Web app + local Node TS backend; React 19 + Vite
  + TanStack Query + EventSource; chokidar + SSE; Vitest + Playwright; npm-workspaces
  monorepo of 4 packages (`adapter`, `contract`, `apps/server`, `apps/web`); fixtures
  under gitignored `.argus/`. clientVersion observed: `2.1.161`.
- *[verified]* **R6 — prior art.** LangSmith-style right-hand detail panel + a
  legible lane/spine canvas; avoid edge-spaghetti and $-cost framing.

## Decisions (locked) — confirmed by the user 2026-06-04

Full detail in `synthesis.md` §2. User-confirmed choices:

1. **App shape: web app + local Node/TS backend** (only shape that lets a browser read
   `~/.claude`; HTTP+SSE seam keeps a later Tauri sidecar a cheap swap).
2. **Frontend: React 19 + `@xyflow/react`** (run model stays framework-agnostic; viz
   layer is React-specific).
3. **Interact: read-only v1, reserve the seam** — build nothing for interact now;
   architect so `FileSystemPort` can gain write ops + SSE can pair with a control
   channel later. Not read-only-forever; the embedded-agent vision is a real later goal.
4. **Live: prototype-first (M0–M5), then live (M6–M8) gated on a real captured run.**
   **User caveat (binding):** use REAL captured data from the start so rendering is
   proven on real, messy runs — copy fixtures from this project and/or `../modal-rust`.
   ⇒ fixtures captured under `.argus/fixtures/` (see prototype workpad); M1's adapter
   tests and M3's first render must run against real runs, incl. the 14-agent
   `modal-rust-plan-research` and a `failed`/resumed run.

Defaults taken without a separate question (overridable): raw token/tool activity
metrics, **no `$` cost**; run badge matches on-disk `status` + a "partial failure"
chip (no mis-attribution to a top-level agent); **dark-only** v1.

## Open questions for the user — RESOLVED (the 4 above) + remaining

Resolved: app shape, framework, interact-seam, live-vs-prototype (above). Remaining
non-blocking unknowns carried to architecture: sub-workflow (`workflow()`) nesting on
disk; exact live journal-flush timing (must capture a real running run before M7/M8);
format-drift versioning strategy (mitigated by the single adapter + zod passthrough +
format pin).
