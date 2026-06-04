# argus — Research Synthesis (Phase 1 gate)

**Date:** 2026-06-04 · **Lead synthesizer output.** This document locks the
research-phase decisions, folds in every high-severity review fix, and hands a
milestone plan to the architecture/prototype/live/inspect workpads.

> **Source-of-truth note.** Where this synthesis and the research/design inputs
> disagree about the on-disk format, **`workpads/research/knowledge.md` and
> `project.md` win** (they were verified by direct inspection). The most important
> such correction: **`workflows/wf_<id>.json` does NOT exist while a run is in
> progress — it is written only at finalize.** Several inputs assumed a live
> "re-read-and-diff `wf_*.json`" path; that path is **invalid for detecting/serving
> a running run** and is corrected below. All on-disk claims in the tables were
> re-verified on disk during synthesis (see Verified Facts).

**Verdict: `plan-needs-user-input`.** The architecture is sound and the milestone
plan is reachable, but (a) several **high-severity** review findings require design
corrections that are now folded into Locked Decisions, and (b) three genuinely
product-level questions (web-vs-Tauri, framework, interact-as-a-goal) must be
answered by the user before M0. All high-severity must_fixes are *addressed* (a
fix is specified); none is left dangling.

---

## 1. Verified Facts

Confidence: **high** = directly inspected on disk or quoted from official docs;
**med** = single source / inference. Every "on-disk" row was re-checked during this
synthesis against `~/.claude/projects/`.

### 1a. Claude Code client availability & connection strategy

| # | Claim | Source | Conf |
|---|-------|--------|------|
| A1 | Claude Code remains a **proprietary, paid, closed-source** product. A March 2026 npm source-map leak exposed ~512k lines of TS, but it was human error, not an open-source release; argus must **not** depend on leaked code. | lowcode.agency / findskill.ai leak writeups; anthropics/claude-code#19073 | high |
| A2 | **No official API** exists for reading workflow runs programmatically. Workflow interaction is documented only via CLI (`/workflows`, `/deep-research`) + REPL; the docs point at on-disk journals as the read contract. | code.claude.com/docs/en/workflows.md (no API section) | high |
| A3 | The **Agent SDK** (TS/Python) documents subagents and a Workflow tool (TS SDK ≥0.3.149) for *invoking* workflows, but exposes **no client library to read/parse runs from disk**. | code.claude.com/docs/en/agent-sdk/subagents.md | high |
| A4 | **ACP** (Agent Client Protocol, v1 stable 2026) standardizes *editor↔coding-agent code editing*, NOT workflow orchestration or run inspection. It is a **non-starter** for argus's read/inspect needs. | github.com/agentclientprotocol | high |
| A5 | **Managed Agents** (cloud agent harness) offers session retrieve/list/update/event-streams but exposes **no workflow-specific** structures (phases, pipelines). Wrong channel for local file-based runs. | platform.claude.com/docs/.../managed-agents | high |
| A6 | The on-disk format is **undocumented, unversioned, and read-only at rest**: finalized runs are not modified by the client after completion; argus reads them without API/auth. | docs + on-disk inspection; project.md stance 1 | high |
| A7 | **Remote control / driving a live run** is not available via any official API (only in-CLI pause/resume/stop). | workflows.md | high |

### 1b. On-disk data contract (from `knowledge.md`/`project.md`, re-verified on disk)

| # | Claim | Source | Conf |
|---|-------|--------|------|
| D1 | Runs live at `~/.claude/projects/<slug>/<session-id>/`. **Slug = absolute cwd with every non-alphanumeric char → `-`, NO collapsing** (`/Users/nicolas/.config/ghostty` → `-Users-nicolas--config-ghostty`, double dash preserved). Slug is **lossy and not reversible**; collisions exist (`/devel/modal-rust`, `/devel-modal-rust`, `/devel/modal/rust` → same slug). | knowledge.md; project.md; on-disk | high |
| D2 | **A finished run renders entirely from `workflows/wf_<id>.json`.** Top-level keys (14-agent run): `runId, timestamp, taskId, script, scriptPath, args, result, agentCount, logs, durationMs, summary, workflowName, status, startTime, phases, defaultModel, totalTokens, totalToolCalls, workflowProgress`. | on-disk `jq keys` | high |
| D3 | **`wf_<id>.json` has NO `version` field** (`has("version")` → false). The client `version` (e.g. **`2.1.161`**) lives ONLY on `agent-*.jsonl` transcript lines. | on-disk | high |
| D4 | **`args` is a JSON-encoded STRING**, not an object (`"{\"date\":\"2026-06-03\"}"`); must `JSON.parse` defensively, degrade to raw string on failure. | on-disk | high |
| D5 | **`script` field carries the full user workflow JS source (~18,231 chars)** + `scriptPath` carries the absolute path. Both are a **privacy/secret + XSS surface** (prompt templates, possibly inlined keys, dir layout). | on-disk | high |
| D6 | **`result` can be very large (198,220 chars on the 14-agent run).** It is NOT a small field; inlining it into every snapshot/diff is a heavy-snapshot hazard. | on-disk | high |
| D7 | `workflowProgress[]` is a **FLAT array** of two node types. `workflow_phase` = `{type,index,title}` (1-indexed; **NO `detail`**). `workflow_agent` carries `{type,index,label,phaseIndex,phaseTitle,agentId,agentType,model,state,cached,attempt,startedAt,queuedAt,lastProgressAt,durationMs,tokens,toolCalls,lastToolName,lastToolSummary,promptPreview,resultPreview}`. | knowledge.md; on-disk | high |
| D8 | **Phase `detail` lives ONLY on top-level `phases[]`** (0-indexed `{title,detail}`), NOT on `workflow_phase` nodes (1-indexed). The adapter **must join** by `phaseNode.index − 1` with a length-mismatch guard, or lane descriptions are silently lost / mis-attributed. | on-disk | high |
| D9 | **No explicit edge/parent/depends/stage/group fields anywhere.** Agents are grouped ONLY by `phaseIndex`. **Pipeline/parallel structure MUST be INFERRED** from timing (`queuedAt`/`startedAt`/`durationMs` overlap) + `label` conventions; the only synthesizable relationship is sequential **phase_i → phase_i+1**. | knowledge.md; on-disk | high |
| D10 | **Agent `state` in finalized journals is only `done` (1176×) or `progress` (6×)**; `progress` = caught mid-flight at finalize (killed/failed run). Live `queued`/`running`/`error` are NOT stored — they must be derived from the live event stream. New fields vs seed: **`agentType`, `cached`** (`cached` = result reused from resume cache). | knowledge.md; on-disk | high |
| D11 | **`journal.jsonl` event vocabulary is EXACTLY two types, machine-wide: `{type:"started",key,agentId}` and `{type:"result",key,agentId,result}`** (912 started / 853 result across files). **NO progress/tool/token/phase events.** `key` is a v2 content hash and **is the resume cache** (NOT the join key — correlate by `agentId`). | knowledge.md; on-disk | high |
| D12 | **Running-run detection (file-first):** while running, `subagents/workflows/wf_<id>/` exists (journal + `agent-*.jsonl`) but `workflows/wf_<id>.json` does **NOT** yet exist. ⇒ `subagents/workflows/wf_<id>/` present **without** `workflows/wf_<id>.json` ⇒ **running**. | knowledge.md | high |
| D13 | **`/private/tmp/claude-<uid>/<slug>/<session>/tasks/<taskId>.output`**: `w<id>.output` = final result JSON, **empty (0 bytes) while running** (a clean running signal); `b<id>.output` = live raw stdout of a tool call; `<hex>.output` = an agent's output. These are **hardlinked** to `~/.claude/projects/.../tool-results/<id>.txt` (same inode) ⇒ **live tool output is reachable from `~/.claude` without depending on `/tmp`.** tmp is a useful *secondary* signal but ephemeral; discovery must target the **exact slug**, never broad-scan tmp. | knowledge.md | high |
| D14 | **Failed/killed runs carry a top-level `error` string** that embeds `/$bunfs/root/src/entrypoints/cli.js` stack traces (verified verbatim on killed `wf_7233276f` and failed `wf_d219195d`). The **completed-with-hidden-failure** 14-agent run has **NO `error` field** (`has("error")`→false). ⇒ adapter must read **both** `error` and `logs[]`. | on-disk | high |
| D15 | **Hidden partial failure:** the 14-agent run is `status:completed`, all agents `state:done`, yet `logs[]` contains `parallel[0] failed: agent({schema}): subagent completed without calling StructuredOutput`. The failing log line names **`agent({schema})` (a nested sub-agent type), NOT any of the 14 top-level labels**, and `parallel[0]` is a positional index, not an `agentId`. ⇒ failure is **not reliably attributable to a top-level agent node**. | on-disk | high |
| D16 | **Killed-run journal asymmetry** = `wf_7233276f`: 9 `started` / 7 `result`; wf shows `done=7, progress=2`, status=killed. ⇒ started-without-result correlates with **`progress` (interrupted)**, NOT failure. The "14 started/13 result ⇒ failure" framing in some inputs is **wrong**; that 14-agent failure is a **logs-only** signal. | on-disk | high |
| D17 | `promptPreview`/`resultPreview` truncate at **exactly 401 chars** in the sample; empty (len 0) is distinct from truncated (e.g. red-team's empty result = a failure signal, not truncation). `tokens=0` with `toolCalls=23` is real (review:red-team) — must render as activity, never "did nothing". | knowledge.md; on-disk | high |
| D18 | **Named workflows** are statically parseable from `<project>/.claude/workflows/*.js` via `export const meta = {name, description, whenToUse?, phases[], model?}`. Built-ins ship in the client, not on disk. modal-rust has 5 named workflows. | knowledge.md; on-disk | high |
| D19 | **Scale (this machine):** ~48 finalized run journals (38 completed / 5 failed / 5 killed); ~1199 `agent-*.jsonl` transcripts (~100–350KB each); ~330MB total. Largest run-journal ~237KB (mostly the 198KB `result`). Well within one Node process + in-memory index; **no DB for v1**; transcripts must be **lazy-loaded**, never eagerly indexed. | on-disk | high |
| D20 | **No live/running run exists anywhere on disk right now** (0 runs with status `running`; all 48 are terminal). ⇒ journal-flush timing and whether `wf_*.json` is ever written incrementally **cannot be confirmed without capturing a fresh live run**. | on-disk | high |

### 1c. Graph-viz library + layout engine

| # | Claim | Source | Conf |
|---|-------|--------|------|
| G1 | **React Flow (`@xyflow/react`) v12.x** (12.11.0, days old) — MIT, production-mature, renders nodes as **real DOM** (ideal for rich agent cards), native grouping (`type:'group'` + `parentId` + `extent:'parent'`), ships MiniMap/Controls/Background/fitView. | reactflow.dev; npm | high |
| G2 | **Svelte Flow (`@xyflow/svelte`) is ALPHA** in 2026 (same team, shared core, less hardened). Choosing it trades the UI-quality invariant for an immature lib. | xyflow.com/blog; npm | high |
| G3 | Among React Flow layout integrations, **only dagre and elkjs support sub-flows**; **dagre has a known open bug** when in-group nodes connect outside the group — exactly argus's phase-group→next-phase topology. **elkjs** (`layered` + `hierarchyHandling:INCLUDE_CHILDREN`) supports nested groups but is ~1.45MB and async, and **may render nested boxes rather than crisp swimlanes** for the 7-then-1 shape (the single biggest viz-quality risk). | reactflow.dev/learn/layouting | high |
| G4 | argus data is a **strictly layered swimlane/Gantt**: phases sequential, agents parallel within a phase (verified timing: 7 Research agents at t=0; Design at 271s = end of Research; etc.). It is **not** a free-form DAG; edge routing/auto-layout is largely **avoidable**. | knowledge.md; on-disk timing | high |
| G5 | **Scale is tiny (1–14 agents, 2–6 phases).** DOM rendering is the right trade; spend the perf budget on aesthetics + motion. Canvas/WebGL libs (Cytoscape/Sigma/vis-network) are mis-fit (their large-graph edge is irrelevant; they cost rich-HTML-card ergonomics). | on-disk | high |
| G6 | Prior art convergence: **LangSmith** (tree + waterfall + persistent right detail panel), **Phoenix** (sort/flag outlier spans by metric), **OpenAI traces** & **GitHub Actions** (list → detail, one-click node→evidence, status icon left of name). | langchain/arize/openai/github docs | high |

### 1d. TypeScript stack & app shape

| # | Claim | Source | Conf |
|---|-------|--------|------|
| S1 | **Node v24** + thin typed HTTP server is the v1 backend. Node `fs.watch` is unreliable on macOS (no filenames, missed/double events, rename-only); **chokidar** is the production watcher. | chokidar README; project.md | high |
| S2 | **SSE (EventSource)** is the right live channel for a **strictly server→client read-only** feed: free protocol-level reconnection + `Last-Event-ID` replay; WebSocket's bidirectionality is unused weight until a future interact phase. | ably/websocket.org comparisons | high |
| S3 | **Vite v7** + **Vitest v3** (optionally Browser Mode via Playwright provider) + **Playwright** for UI smokes is the canonical build/test stack. | context7 vite; vitest.dev | high |
| S4 | **Web app + local TS backend** for v1 is the only shape that lets a browser read the local `~/.claude` tree. The **HTTP+SSE contract is the swap seam**: a later **Tauri v2** build embeds the same server as a **Node sidecar** (documented pattern); a remote/team mode hosts it elsewhere. | v2.tauri.app sidecar docs; project.md | high |
| S5 | A localhost server exposing `~/.claude` (prompts/code/secrets) to a browser origin is the **biggest privacy risk**. 127.0.0.1-bind + CORS allowlist + per-launch token are **necessary but not sufficient** (DNS-rebinding, XSS token-exfil, path traversal must also be handled). | red-team review; web security canon | high |

---

## 2. Locked Decisions

Every high-severity review must_fix is folded in below, tagged **[FIX]** with what
changed. Review conflicts are resolved explicitly at the end of this section.

### 2.1 Client dependency boundary
- **ZERO dependency on leaked client code or any Claude API for the read path.** argus
  reads only the observable on-disk contract (Verified Facts 1b). Clean from an
  IP/licensing standpoint. (A1, A6)
- The **only** network reach in v1 is an **opt-in, server-side, additive** "describe
  this workflow" call to the Claude API (M11), which never gates anything and never
  sends run/transcript content without explicit consent. (project.md stance 1)

### 2.2 Connection strategy (per phase)
- **File-watch (chokidar) is sufficient for v1** across discover/prototype/live/inspect.
- **ACP and Managed Agents are rejected** for v1 (A4, A5). Remote control is deferred
  to the exploratory interact phase. (A7)
- **[FIX — live source authority, corrects multiple inputs]** Per **D12/D11/D20**:
  `wf_*.json` **does not exist while running**, and the journal carries only
  `started`/`result`. Therefore the live path is:
  1. **Detect running** = `subagents/workflows/wf_<id>/` present **without**
     `workflows/wf_<id>.json` (corroborated by an empty `w<id>.output` in tmp, D13).
  2. **Authoritative live source = `journal.jsonl` (tail, cursor-based) + per-agent
     `agent-*.jsonl`**, correlated by `agentId`. Live UI is honestly scoped to the
     **lifecycle the journal guarantees** (queued→started→done), with per-card
     **metrics/tokens/tools/duration shown only on finalize** (they live in
     `wf_*.json`, which appears at the end). For richer live tool output, read the
     **hardlinked `tool-results/<id>.txt`** (D13) — no `/tmp` dependency.
  3. **On finalize**, `wf_*.json` lands → reconcile the live-built graph to it
     (journal is authoritative until it stops appending; only then does `wf_*.json`
     structure take over, resolving the finalize-vs-tail race).
  - The previously-proposed "re-read-and-diff `wf_*.json` on each fs event" is **only
    valid post-finalize**, not for running runs. (Resolves red-team & data-contract
    must_fixes on the live assumption.)

### 2.3 Adapter contract (the single format-aware module)
- **One runtime-agnostic `packages/adapter`** is the ONLY module that knows the raw
  format. It parses everything (`wf_*.json`, `journal.jsonl`, `agent-*.jsonl`,
  `.claude/workflows/*.js` meta) behind an **injected `FileSystemPort`** (no direct
  `node:fs` import) so it can later move to a Tauri sidecar / browser / remote host.
- **Defensive by contract:** zod schemas with `.passthrough()`/`.catch()`; unknown
  node `type` dropped with a counted warning; unknown agent `state` → `Unknown`
  (neutral); torn/missing `wf_*.json` → reconstruct a partial model from journal +
  agent labels, `incomplete=true`; a single bad JSONL line skipped (line-independent).
- **[FIX — parse-permissive, emit-allowlisted]** `.passthrough()` keeps unknown fields
  *internally* for tolerance, **but the emitted `RunModel` is constructed by explicit
  field projection (allowlist), never by spreading parsed JSON** — so a future
  secret-bearing field can never silently ride to the client. (red-team must_fix #5)
- **[FIX — drop `script` from the default model]** Per **D5**, the 18KB `script`
  source and `scriptPath` are **not** included in the snapshot by default. "View
  workflow source" is a **separate lazy fetch** like transcripts; `scriptPath` is
  sanitized to a basename in any UI. (red-team must_fix #5)
- **[FIX — clientVersion is best-effort & decoupled]** Per **D3**, `version` is NOT in
  `wf_*.json`; it lives on transcript lines (`2.1.161`). `loadRun`/`discoverRuns`
  stay **zero-transcript-I/O**. `clientVersion` is **optional**, resolved lazily by
  reading only the **first line** of any one `agent-*.jsonl` per session, cached, and
  never blocks/slows the snapshot. The always-on stamp is the internal
  `ADAPTER_FORMAT = 'cc-workflow/observed-2026-06-04'` constant. The "tested on" badge
  uses the real observed version (2.1.161) when available, else shows "untested
  format". (red-team must_fix #1; data-contract must_fix #2)
- **[FIX — phase `detail` join]** Per **D8**, build phases by merging both sources
  keyed on the **1-based** `workflow_phase.index`, enriching `detail` from
  **0-indexed** `phases[]` via `index − 1`, pushing a `warnings[]` entry on length
  mismatch. `phaseIndex`/`index` zod default changes from `.catch(0)` to
  `.catch(undefined)`; nodes with unresolvable `phaseIndex` are dropped-with-warning,
  **never** dumped into a phantom phase 0 (which would also produce a bogus
  `from:0→1` edge). (data-contract must_fix #1; red-team must_fix #6)
- **[FIX — cap heavy fields]** Per **D6/D17**, `result`/`promptPreview`/`resultPreview`
  are hard-capped at the adapter boundary (~4–8KB, `truncated:true`); the full
  `result` is exposed only via a **lazy handle**, never inlined into `RunModel`.
  `truncated=true` heuristic = length===401 for previews; **empty (len 0) ≠ truncated**
  (empty result is a real failure signal). A perf test asserts emitted `RunModel` JSON
  stays under a fixed budget on the 198KB run. (red-team must_fix #4)

### 2.4 Run-model contract
- `Run → Phase[] → Agent[]`. **No agent-level edges**; the only synthesized edge is
  **phase_i → phase_i+1** (D9). Agents grouped by `phaseIndex`, ordered by `index`.
- **State enum derived, not assumed:** `{queued, running, done, error, unknown}` from
  raw `done|progress` + `run.status` + reconciliation. **Reconcile against run.status:
  a `progress` agent in a `killed`/`failed` run renders `interrupted` (static), not a
  perpetual live pulse** (D10, D16).
- **[FIX — failure attribution demoted to run-level]** Per **D15/D16**: a `logs[]`
  `/failed/` line raises a **run-level "partial failure" badge** and shows the raw
  failing line **verbatim** in the narrator strip. `failedInLogs` is set on an agent
  **only on an exact `label`/`agentId` string match**; otherwise agents stay neutral
  (no mis-attribution slander). **The journal `started`-vs-`result` count is NOT used
  as a failure heuristic** — on real data it flags interrupted (`progress`) agents on
  killed runs, not failures. The adapter reads **both** `error` and `logs[]` (a failed
  run has `error`; a completed-with-hidden-failure run has only `logs[]`). (red-team
  must_fix #2; data-contract nice-to-have) A fixture test asserts the 14-agent run
  yields a run-level partial-failure badge and **zero** mis-attributed agent chips.
- **[FIX — bunfs sanitization]** `error` is split into `{message, internalDetail}`; the
  `/$bunfs/.../cli.js` stack goes into a collapsed `internalDetail`, **never rendered
  raw** (no-leaked-binary stance). (D14)
- `cached` and `agentType` are surfaced (cached = resume-cache reuse badge). `tokens=0`
  vs `null` preserved (0-with-tools = activity, not "did nothing"). `args` JSON-parsed
  defensively, raw-string fallback (D4).

### 2.5 Server↔client API
- **REST snapshot + SSE live deltas**, all wire types in `packages/contract`.
  Endpoints: `GET /api/projects`, `/api/projects/:slug/runs`,
  `/api/runs/:slug/:session/:runId` (snapshot), `.../stream` (SSE),
  `.../agents/:id/transcript` (lazy, paginated).
- **[FIX — slug→path recovery]** Per **D1**, slug is lossy and collisions exist. The
  authoritative project path is recovered from **`wf_*.json`'s `scriptPath`**
  (`/Users/nicolas/devel/modal-rust/.claude/workflows/plan-research.js` → dirname×2 =
  project root) — **no transcript I/O** needed. Key `RunRef` and all caches by the
  **recovered absolute path**, not slug; when multiple cwds share one slug dir, show
  **multiple switcher entries** grouped by recovered cwd. (red-team must_fix #3)
- **[FIX — security hardening, beyond bind+CORS+token]** (red-team must_fix #9, #10):
  - **Bind 127.0.0.1 only**; reject any request whose `Host`/`Origin` is not exactly
    `127.0.0.1:PORT`/`localhost:PORT` (defeats **DNS rebinding** regardless of CORS).
  - **Per-launch bearer token on ALL routes incl. SSE** (EventSource can't set
    headers → token in URL or `SameSite=Strict` cookie + preflighted companion fetch);
    401 before any FS access.
  - **Strict CSP** (no inline script, `connect-src 'self'`) to mitigate token exfil.
  - **Render all preview/transcript/log/error/result text as text nodes only** (never
    `dangerouslySetInnerHTML`); a test injects `<img onerror>`/`<script>` into a
    preview fixture and asserts no execution.
  - **Path-escape guard:** validate `slug`/`session`/`runId`/`agentId` against a strict
    charset and `resolve()`-verify the final path is inside `claudeHome` (block `../`).
  - **Logging/redaction policy:** never log file **contents** (counts/codes only),
    never log full paths (basename/hash), scrub `/Users/`+`$bunfs` from any logged
    error, `warnings[].detail` carries codes not raw text. A test greps logs for
    `/Users/`, `$bunfs`, and known-secret fixtures and asserts absence.

### 2.6 Graph-viz library + layout engine
- **`@xyflow/react` v12** is the library (G1). Svelte Flow rejected as alpha (G2);
  rendering logic stays behind the framework-agnostic run model so the viz layer is
  replaceable. **dagre rejected as the engine** (sub-flow cross-boundary bug, G3).
- **[FIX — resolve the elk-vs-hand-rolled conflict; uiDirection wins]** The two inputs
  conflicted: architecture defaulted to **elkjs**; uiDirection defaulted to a
  **deterministic hand-rolled lane layout**. **Resolution: the uiDirection default
  wins** — at strictly-layered ≤14 nodes (G4/G5), lane geometry is pure arithmetic,
  jitter-free, and produces the exact swimlane aesthetic; it sidesteps the biggest
  viz-quality risk (elk nested-box mush) and the ~1.45MB bundle. **elkjs is the
  swappable fallback** kept behind a thin `layout` module, reserved for a future
  real cross-phase DAG (agent-spawns-agent). M3 acceptance is **engine-agnostic**
  ("reads as crisp vertical phase lanes behind a swappable layout module"); elkjs is a
  **deferred/lazy dependency**, not a day-0 install. (sequencing must_fix #5; nice-to-have)

### 2.7 UI / visual direction
- **Primary run view = vertical phase lanes** (phases stacked top→down by index;
  agents wrap in a grid inside their lane), **one synthetic spine edge** phase_i→i+1
  (animated only while downstream is running). No agent-level edges (G4, G6).
- **AgentCard** (~260px): state dot + mono label + model badge; `lastToolSummary`
  line (2-line clamp); metric pills (duration / tokens / tools). 3px state-colored
  left rail. All fields come from `wf_*.json` with **zero transcript I/O**.
- **State/motion:** looping motion (pulse, indeterminate bar, flowing spine) **only for
  live states**; finished runs are calm. `tokens=0` → dimmed `—`, never "0"; killed-run
  `progress` agents → **interrupted** badge, not a live pulse (D10/D16).
- **logs[] & error first-class:** narrator lines as phase-boundary chips;
  partial-failure badge in the run header even when `status=completed` (D15); bunfs
  trace collapsed (D14).
- **Shell:** fullscreen canvas; **collapsible left icon rail** (project switcher with
  **decoded absolute path**, run list with status-icon/agentCount/duration/timestamp,
  settings); **right detail panel** (LangSmith pattern) filled instantly from card
  data, "open transcript" lazy-loads `agent-*.jsonl`. Themed MiniMap/Controls/Background.
- **Design system:** dark-first (light deferred); mono for machine identifiers;
  saturation reserved for state semantics; 4px grid; 150–200ms ease for UI, looping
  only for live. **No `$` cost framing** in v1 (tokens/tools are raw activity; `tokens=0`
  anomaly + no verified rates make a dollar figure misleading). Deep-linkable
  project+session+run+agent in the URL.
- **[FIX — live layout / fitView thrash]** Batch structural relayout + fitView in a
  ~150–250ms window (7 phase-start agents arrive near-simultaneously); during live,
  animate new nodes into existing positions and **only fitView on first render or
  explicit user action**, not on every node add. (red-team must_fix #11)

### 2.8 TS stack + web-vs-desktop shape
- **Web app + local Node v24 TS backend for v1** (S4); **Tauri deferred** as a later
  sidecar swap of the same HTTP+SSE seam.
- **React 19 + @xyflow/react + Vite 7 + TanStack Query + EventSource** (front);
  **chokidar + SSE** (back); **Vitest + Playwright** (test).
- **npm-workspaces monorepo, exactly 4 packages** (the two load-bearing seams kept
  physically separate): `packages/adapter`, `packages/contract`, `apps/server`,
  `apps/web`. Captured fixtures + generated output under gitignored `.argus/`.

### Review-conflict resolutions (explicit)
1. **elkjs vs hand-rolled lanes (architecture vs uiDirection):** → **hand-rolled lane
   layout is the default**, elkjs the swappable fallback; M3 acceptance engine-agnostic.
2. **Live source = re-read `wf_*.json` vs journal-tail:** → **journal-tail is
   authoritative while running** (`wf_*.json` doesn't exist live, D12); re-read is
   post-finalize only.
3. **Per-agent failure attribution vs run-level:** → **run-level partial-failure badge
   + verbatim log line**; per-agent flag only on exact string match.
4. **clientVersion always-stamped vs lazy:** → **lazy, best-effort, off the snapshot
   path** (it's transcript-only, D3).
5. **Synthetic-only live gate (M8) vs real live run:** → a **real captured live run is
   a hard precondition** for declaring the LIVE gate (see §3 M8); synthetic replay is
   for CI regression only.

---

## 3. Milestone Plan (M0–M11)

Maps to the workpads: **M0–M5 = prototype** (gate at **M5**); **M6–M8 = live**
(gate at **M8**); **M9–M11 = inspect** (gate at **M11**). Research (this doc) and
architecture are upstream of M0. Dogfood dataset: `…/-Users-nicolas-devel-modal-rust`
(richest run `wf_9f32796b-c0b` = 14 agents / 4 phases / 7-2-4-1).

**Sequencing fixes folded in:**
- **M1 owns the `FileSystemPort` + node-fs impl + a port contract test** (it was an
  implicit seam smuggled into M2). M1 reads ONE real `wf_*.json` through the port.
- **M6 re-parented to depend on M2, not M5** — the journal-tail backend depends only on
  the run model + run-locating, not on the rendered UI; this pulls the highest-risk
  unknown (live timing) forward. M7 still depends on M5 (needs the rendered graph).
- **Capture one real live run** is a hard prerequisite that can run during M0–M2.
- M3 acceptance is **engine-agnostic** (hand-rolled lanes default).
- **Inspect gate (M11) is defined on the file-based capabilities** (navigate + detail +
  transcript); the Claude-API "describe" is a post-gate, opt-in enhancement.

| ID | Name | Validates (workpad) | Key acceptance | Evidence | depends_on |
|----|------|--------------------|----------------|----------|------------|
| **M0** | Scaffold stack | prototype | 4-pkg npm-workspaces; React19+Vite7+@xyflow/react; Node server **binds 127.0.0.1 only** + Host/Origin allowlist + per-launch token + `/health`; tsc/lint/`vitest`/`vite build` green; `.gitignore` covers `.argus/` | Exit-0 logs; `lsof`/`ss` proving 127.0.0.1 bind; empty fullscreen screenshot | — |
| **M1** | Adapter v0 + FS port | prototype | `parseFinalizedRun(raw)` (pure) **+ `FileSystemPort` + node-fs impl + port contract test**; zod passthrough/catch; **emit-allowlisted** model (drops `script`); phases joined w/ `detail` from `phases[]`; synth phase edges; **run-level** partial-failure from `logs[]`+`error`; bunfs split; tokens 0≠null; reconcile `progress`-on-killed→interrupted | Vitest over `.argus/fixtures/` incl. 14-agent (logs-only failure, no `error`), killed 9-agent (9-started/7-result→2 interrupted), failed (has `error`), unknown-field, missing-field; assert **zero mis-attributed agent chips**; perf test caps RunModel JSON on the 198KB run | M0 |
| **M2** | Discovery | prototype | slug derivation (`/.config/ghostty`→`--`); **recover project path from `scriptPath`**; key/dedup by **recovered abs path**, multi-entry on slug collision; read **header fields only** (no `workflowProgress`/transcripts); bogus path → empty-with-reason; static `meta` listing | API JSON for modal-rust session w/ correct status mix; slug unit tests incl. real `-Users-nicolas--config-ghostty`; bogus-path test | M1 |
| **M3** | Render one finished run | prototype | run model → fullscreen lanes via @xyflow/react (phases=groups, agents=children sorted by index); **hand-rolled lane layout default behind swappable module** (elk fallback, lazy); MiniMap/Controls/Background; synth phase edges only; 1-agent and 14-agent both clean | Playwright fullscreen screenshot of 14-agent run (4 lanes 7/2/4/1, no overlap); 1-agent screenshot; console-clean | M2 |
| **M4** | Shell (collapsible left toolbar) | prototype | two-level nav (run list→detail); collapsible rail keeps >90% viewport; project switcher shows **decoded abs path**; URL deep-link; killed/failed show sanitized error + collapsed bunfs | Expanded/collapsed screenshots; run-list status mix; select-run-changes-graph flow; killed-run sanitized-error screenshot | M3 |
| **M5** | UI polish + smoke (**PROTOTYPE GATE**) | prototype, GATE | 14-agent run reads beautifully at a glance, scales 1–14; passes UI/UX review lens; logs[] surfaced (hidden `parallel[0] failed` visible, not buried); committed Playwright smoke; README "Try it" + tested-version note (**2.1.161**); tsc/lint/test/build green; demo on real data, no synthetic fixtures | Signed-off fullscreen screenshot; review verdict in workpad; fresh-clone dry run | M4 |
| **M6** | Running-run detection + journal tail | live | chokidar watches `subagents/workflows/wf_<id>/`; **running = subagents dir present without `wf_*.json`** (+ empty `w<id>.output`); journal parsed line-by-line, torn line skipped; correlate by **agentId**; started-without-result → still-running/incomplete; cursor tailing; validated on **synthetic replay** | Replay harness logs correct lifecycle incl. started-without-result→incomplete; torn-line-skipped test; workpad note on captured-live-run + observed `wf_*.json` write behavior | **M2** |
| **M7** | SSE live channel + in-place deltas | live | SSE (not WS); on fs event, re-normalize affected run via adapter, emit versioned delta keyed runId+eventId; **patch node.data in place** (CSS animate); **re-layout only on structural add/remove** (batched), never on tick; reconnect via Last-Event-ID/snapshot; **serialize per-run reads** (single-flight) + discard stale-mtime diffs; torn read during live → keep last-good, don't flip `incomplete` | Recording of progress→done animation; network log: deltas, no full re-fetch; kill-SSE reconnect test; **5-rapid-events test asserts no done→running regression** | M6, M5 |
| **M8** | Live re-layout + finalize reconciliation (**LIVE GATE**) | live, GATE | structural add → batched relayout+fitView; on finalize, reconcile live graph == finalized `wf_*.json`; **journal authoritative until quiescent**, then `wf_*.json`; **a REAL captured live run is REQUIRED to declare the gate** (synthetic only for CI regression); killed/failed animate to terminal state, started-without-result→incomplete | Recording of a **real** live run to completion; diff asserting live graph == finalized graph; workpad note on real-run capture + residual limitation | M7 |
| **M9** | Node detail panel | inspect | LangSmith right panel from card data, **zero transcript I/O**; long previews truncate+expand; `tokens=0`→`—`; truncated marked; text sanitized; Phoenix-style sort/critical-path within phase | Panel screenshot for research:modal-images (33.5k tok/11 tools) and review:red-team (0→`—`); truncation+expand screenshot; click-node asserts no transcript request fires | **M5** |
| **M10** | Transcript view (lazy) | inspect | `agent-*.jsonl` loaded **only on explicit action**, paginated; `agentId`→file mapping + journal lifecycle merge; missing transcript → "unavailable" badge, no crash; endpoint behind 127.0.0.1+token; format knowledge only in adapter | Real transcript screenshot; "unavailable" badge for simulated missing file; network log: transcript request only on click | M9 |
| **M11** | Structure nav + opt-in "describe" (**INSPECT GATE**) | inspect, GATE | phase nav (jump/expand/collapse, follow synth edges, node→detail/transcript in one click) **defines the gate**; "describe" calls Claude API **server-side**, key from env, degrades gracefully w/o key, **no transcript/script/result/previews sent without explicit opt-in**, uses claude-api skill (caching/current model) | Phase-nav + one-click-to-transcript screenshot; "describe" result w/ consent notice; test: API no-ops w/o key, no transcript bytes sent without opt-in | M10 |

---

## 4. Open Questions For The User (with recommended defaults)

1. **Web app + local backend vs desktop (Tauri) for v1?**
   *Recommendation: web + local Node/TS backend.* It's the only shape that lets a
   browser read `~/.claude` without bundling a desktop shell, and the HTTP+SSE
   contract makes a later Tauri sidecar a cheap swap. Cost: a localhost server exposing
   `~/.claude` to the browser origin — mitigated by 127.0.0.1-bind + Host/Origin
   allowlist (anti-rebinding) + per-launch token + strict CSP + path guards (§2.5).
   Choose Tauri now only if that exposure is unacceptable for your environment.

2. **Frontend framework — React or Svelte/Solid?**
   *Recommendation: React 19 + @xyflow/react.* React Flow is production-mature and is
   the run view's core surface; Svelte Flow is alpha. The run model is
   framework-agnostic, so the data layer stays portable, but the viz components would
   be real rewrite work to move. Need your sign-off since it ties the run view to React.

3. **Read-only forever, or is editing/driving workflows (interact) a real near-term goal?**
   *Recommendation: keep v1 strictly server→client (SSE) and add nothing for interact
   now, but reserve the seam.* The biggest architectural lever. If interact is a
   definite goal, I'll add a one-line "control port" interface stub so the seam is
   reserved (the FileSystemPort can gain write ops; SSE can be paired with a separate
   control channel) — without building any of it. If speculative, leave it out entirely.

4. **Live in v1, or ship finished-runs first?**
   *Recommendation: ship the prototype (M0–M5) first; gate live (M6–M8) behind a
   captured real live run.* No running run exists on disk (D20); journal-flush timing
   and whether `wf_*.json` ever writes incrementally are unconfirmed. Capturing one
   fresh modal-rust run is trivial and is the prerequisite to de-risk the live track.

5. **Partial-failure headline: honesty-to-source or honesty-to-reality?**
   *Recommendation: keep the run badge matching the on-disk `status` (e.g. "completed")
   AND show a prominent run-level "partial failure" chip + the verbatim failing log
   line.* Do **not** mis-attribute the failure to a specific top-level agent (D15 shows
   it's a nested sub-agent the journal can't map). Alternative: a derived
   "completed-with-failures" status that overrides the raw status — say the word if you
   prefer that as the headline.

6. **Token/cost framing.**
   *Recommendation: tokens/tools as raw activity metrics, no `$` cost in v1.* `tokens=0`
   anomalies + no verified per-model rates make a dollar figure misleading; cost
   rollups deferred to backlog.

7. **Dark-only v1, or a light theme from the start?**
   *Recommendation: dark-only for v1*, light deferred to the theming backlog.

---

## 5. Residual Risks

1. **Live timing is unverified (highest).** No running run exists on disk (D20); journal
   carries only `started`/`result` (D11) and `wf_*.json` appears only at finalize (D12).
   If `wf_*.json` is write-at-end and the journal is coarse, the live view shows
   lifecycle dots but **no live metrics until completion**. Mitigation: capture a real
   live run before M7/M8; scope the live UI honestly; metrics labeled "final".
2. **Format drift.** Undocumented, unversioned format; the bunfs stack confirms we read
   an internal surface. Mitigation: all knowledge in `packages/adapter`, zod
   passthrough/catch, `ADAPTER_FORMAT` pin + lazy `clientVersion` (2.1.161), captured
   fixtures incl. torn/killed/zero-token, "untested format" badge on drift.
3. **Slug lossiness/collisions.** Slug is irreversible; multiple cwds collide. Mitigated
   by recovering the true path from `scriptPath` and keying everything by abs path —
   but a slug dir whose runs were produced under genuinely different cwds must surface
   as multiple switcher entries (edge case to test).
4. **Localhost FS exposure.** Even with 127.0.0.1 + Host allowlist + token + CSP + path
   guards, a determined XSS in untrusted rendered content remains the residual surface;
   text-node-only rendering + CSP reduce it. Inherent cost of web+local vs sandboxed
   desktop.
5. **Heavy fields.** 198KB `result` + 100–350KB transcripts × ~1199 files (~330MB).
   Mitigated by hard caps + lazy handles + pagination + emit-allowlist; regressions
   easy if a dev re-inlines `result` or eagerly indexes transcripts.
6. **Lane aesthetic at the 7-then-1 shape.** Even hand-rolled lanes must look crisp when
   a 7-card lane precedes a 1-card lane; cap cards/row, center single-agent lanes,
   prototype on `wf_9f32796b` first.
7. **Strict-sequential-phase assumption.** Holds for all observed runs; if the Workflow
   tool ever overlaps phases or spawns agent-from-agent, lanes misrepresent it.
   Mitigation: derive lane position from observed `phaseIndex`/timing; keep the layout
   module thin so a real DAG layout can swap in.
8. **React lock-in.** Choosing React ties the run view to React; a later Svelte move is
   real component-rewrite work (the data layer is portable).
9. **HTTP/1.1 connection cap** (~6/origin) if many live tabs open; low risk for a
   single-user local tool; HTTP/2 or one stream-at-a-time removes it.
10. **Claude TOS/licensing ambiguity** for a tool reading an internal format; low but
    real. Mitigation: read-only, public on-disk files only, no leaked code; consider
    outreach to Anthropic if argus goes commercial.
