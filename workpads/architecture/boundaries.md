# boundaries.md — argus architecture contracts

The ratified contracts for argus, distilled from the adversarially-reviewed research
synthesis (`workpads/research/synthesis.md` §2). This is the stable concept file the
prototype/live/inspect phases load. Changes here are architecture decisions — record
them with rationale.

The TypeScript below is **contract sketch**, not final code; field names and shapes
are binding, signatures are indicative.

---

## 0. The one hard invariant

**All knowledge of the raw on-disk format lives in `packages/adapter` and nowhere
else.** Every other package consumes the normalized **run model** (below). The
adapter never imports `node:fs` directly — it goes through an injected
`FileSystemPort`, so it can later run in a Tauri sidecar, a browser, or a remote
host without change. Format knowledge leaking out of the adapter is a bug, not a
pattern. (synthesis §2.3, stance 4)

Corollary stances enforced here: **read-only** (no writes into any `.claude` tree),
**defensive parsing** (tolerate unknown/missing fields, partial/killed runs, huge
results), **emit-allowlisted** (never spread parsed JSON to the client), and
**no `$` cost / no leaked-binary internals** surfaced.

---

## 1. Package layout (npm-workspaces monorepo, exactly 4)

```
packages/
  contract/   # wire types + zod schemas shared by server & web. No runtime deps. Imports nothing internal.
  adapter/    # the ONLY format-aware module. Depends on: contract. Talks to disk via FileSystemPort (injected).
apps/
  server/     # Node v24 TS. Depends on: adapter, contract. Owns chokidar, the node FileSystemPort impl, HTTP+SSE, security.
  web/        # React 19 + Vite 7 + @xyflow/react. Depends on: contract (types only). Never imports adapter or node:*.
```

Dependency direction is strict and acyclic: `web → contract`; `server → adapter →
contract`. The **web app never sees the adapter or any raw format** — only `contract`
types over the wire. Captured fixtures + generated output live under gitignored
`.argus/`.

---

## 2. Adapter contract (`packages/adapter`)

### 2.1 FileSystemPort (the injected seam)

```ts
interface FileSystemPort {
  readFile(path: string): Promise<string>;
  readJson(path: string): Promise<unknown>;
  listDir(path: string): Promise<Array<{ name: string; isDir: boolean }>>;
  stat(path: string): Promise<{ size: number; mtimeMs: number } | null>; // null if absent
  exists(path: string): Promise<boolean>;
  watch(path: string, onEvent: (e: WatchEvent) => void): () => void;      // returns unwatch; node impl = chokidar
}
```

The node implementation lives in `apps/server`. M1 ships the port + node impl + a
port contract test (it is **not** smuggled into M2). The adapter is otherwise pure
and unit-tested against `.argus/fixtures/` through a fake in-memory port.

### 2.2 Surface

```ts
recoverProjectPath(scriptPath: string): string;          // dirname twice: .../proj/.claude/workflows/x.js → .../proj
discoverProjects(port, claudeHome): Promise<ProjectRef[]>;
discoverRuns(port, project): Promise<RunSummary[]>;       // HEADER fields only — zero transcript I/O, no workflowProgress walk where avoidable
loadRun(port, ref): Promise<RunModel>;                    // finalized wf_*.json → parseFinalizedRun; running → buildLiveModel
parseFinalizedRun(raw: unknown, ctx): RunModel;           // PURE
buildLiveModel(journal: JournalEvent[], agentMeta, prev?): RunModel; // partial, incomplete=true
loadResult(port, ref): Promise<unknown>;                  // LAZY full result (capped preview is inline; this is the handle)
loadTranscript(port, ref, agentId, page): Promise<TranscriptPage>;   // LAZY, paginated agent-*.jsonl
loadWorkflowSource(port, ref): Promise<string>;           // LAZY "view source" (script not in default model)
parseWorkflowMeta(src: string): WorkflowMeta | null;      // static .claude/workflows/*.js export const meta
resolveClientVersion(port, ref): Promise<string | undefined>; // LAZY, best-effort: first line of one agent-*.jsonl, cached
```

### 2.3 Defensive-parsing rules (binding)

- **zod** with `.passthrough()`/`.catch()`; unknown node `type` → dropped with a
  counted `warnings[]` entry; unknown agent `state` → `unknown` (neutral).
- **Emit-allowlisted:** unknown fields are kept internally for tolerance, but the
  emitted `RunModel` is built by **explicit field projection — never by spreading
  parsed JSON**. A future secret-bearing field cannot ride to the client.
- **`script` + `scriptPath` are NOT in the default model.** "View source" is a
  separate lazy fetch; any displayed `scriptPath` is reduced to a basename.
- **Heavy fields capped at the boundary** (~4–8 KB; `truncated:true`); full `result`
  only via the lazy handle. Preview `truncated` heuristic = raw length `=== 401`;
  **empty (len 0) ≠ truncated** (empty result is a real failure signal). A perf test
  asserts emitted `RunModel` JSON stays under a fixed budget on the 198 KB run.
- **Phase join:** merge `workflow_phase` (1-based `index`) with `phases[]` (0-indexed)
  via `index − 1` for `detail`; length mismatch → `warnings[]`. `phaseIndex`/`index`
  zod default is `.catch(undefined)` (**not** `0`); a node with an unresolvable
  `phaseIndex` is **dropped-with-warning**, never dumped into a phantom phase 0
  (which would also fabricate a bogus `0→1` edge).
- **Torn / missing `wf_*.json`** → reconstruct a partial model from `journal.jsonl` +
  agent labels with `incomplete=true`. A single bad JSONL line is skipped
  (line-independent parsing).
- **`error` sanitized:** split into `{ message, internalDetail? }`; the
  `/$bunfs/.../cli.js` stack goes into a collapsed `internalDetail`, never rendered
  raw.
- **`args`** JSON-parsed defensively with a raw-string fallback. `tokens` `0` vs
  `null` preserved.
- **Format pin:** the adapter stamps `ADAPTER_FORMAT = 'cc-workflow/observed-2026-06-04'`
  onto every model and reports it on `/health`. The pin records which on-disk format the
  adapter was verified against; it never gates the snapshot.

---

## 3. Run-model contract (`packages/contract`)

```ts
type RunStatus  = 'completed' | 'failed' | 'killed' | 'running';
type AgentState = 'queued' | 'running' | 'done' | 'error' | 'interrupted' | 'unknown';

interface RunRef {                  // authoritative key = projectPath, NOT slug (slug is lossy/collides)
  projectPath: string;              // recovered absolute cwd via recoverProjectPath(scriptPath)
  slug: string;                     // on-disk dir name (kept for path-building only)
  sessionId: string;
  runId: string;                    // "wf_<id>"
}

interface Preview { text: string; truncated: boolean }       // truncated = raw len === 401; len 0 ≠ truncated
interface Phase   { index: number; title: string; detail: string | null }  // index is 1-based
interface RunError { message: string; internalDetail?: string }             // bunfs stack hidden in internalDetail
interface AdapterWarning { code: string; detail?: string }                  // codes, never raw text/paths

interface AgentNode {
  agentId: string;
  index: number;
  label: string;
  phaseIndex: number;               // 1-based, resolved (else node dropped)
  model: string | null;
  state: AgentState;                // derived; reconciled vs run.status
  cached: boolean;                  // resume-cache reuse → "cached" badge
  agentType: string | null;
  attempt: number | null;
  failedInLogs: boolean;            // true ONLY on exact label/agentId match in a logs[] /failed/ line
  // metrics — present on finalize; may be null while live (they live in wf_*.json)
  tokens: number | null;            // 0 preserved (0-with-tools = activity, not "nothing")
  toolCalls: number | null;
  durationMs: number | null;
  queuedAt: number | null;
  startedAt: number | null;
  lastProgressAt: number | null;
  lastToolName: string | null;
  lastToolSummary: string | null;
  promptPreview: Preview | null;
  resultPreview: Preview | null;
}

interface RunModel {
  ref: RunRef;
  workflowName: string;
  status: RunStatus;
  incomplete: boolean;              // built from journal w/o finalized wf_*.json, or torn file
  startTime: number | null;
  durationMs: number | null;
  defaultModel: string | null;
  summary: string;
  phases: Phase[];
  agents: AgentNode[];              // grouped by phaseIndex, ordered by index
  edges: Array<{ from: number; to: number }>;  // SYNTHESIZED phase_i → phase_i+1 ONLY. No agent edges.
  logs: string[];                   // narrator log() lines
  partialFailure: { present: boolean; lines: string[] };  // run-level; verbatim failing line(s)
  error: RunError | null;
  args: unknown;
  warnings: AdapterWarning[];
  format: string;                   // ADAPTER_FORMAT
  // script/scriptPath intentionally absent — lazy "view source" only
}

interface RunSummary {              // run list; header fields only
  ref: RunRef; workflowName: string; status: RunStatus;
  agentCount: number; durationMs: number | null; startTime: number | null;
  summary: string; partialFailure: boolean;
}
```

**State derivation (binding):** map raw `done|progress` + `run.status` + reconciliation
→ the enum. **A `progress` agent in a `killed`/`failed` run renders `interrupted`
(static), never a perpetual live pulse.**

**Failure attribution (binding):** a `logs[]` line matching `/failed/` raises the
**run-level `partialFailure`** badge with the line **verbatim**; it sets
`failedInLogs` on an agent **only on an exact `label`/`agentId` match** — otherwise
agents stay neutral (no slander). The journal `started`-vs-`result` count is **not** a
failure heuristic (it flags `interrupted` agents on killed runs). The adapter reads
**both** `error` (failed runs have it) **and** `logs[]` (completed-with-hidden-failure
runs only have the log line — e.g. our 14-agent fixture's `parallel[…] failed`).

---

## 4. Server↔client API (`apps/server`, types in `packages/contract`)

REST snapshot + SSE live deltas. Endpoints:

```
GET  /api/projects                                   -> ProjectRef[]
GET  /api/projects/:slug/runs                        -> RunSummary[]    (grouped by recovered projectPath)
GET  /api/runs/:slug/:session/:runId                 -> RunModel        (snapshot)
GET  /api/runs/:slug/:session/:runId/stream          -> text/event-stream (SSE deltas)
GET  /api/runs/:slug/:session/:runId/agents/:id/transcript?cursor=  -> TranscriptPage (lazy)
GET  /api/runs/:slug/:session/:runId/result          -> full result    (lazy handle)
GET  /api/runs/:slug/:session/:runId/source          -> workflow script (lazy "view source")
GET  /health
```

- **`RunRef` is keyed/cached by the recovered absolute `projectPath`** (from
  `scriptPath`), not the slug. When several cwds collapse to one slug dir, the UI shows
  **multiple switcher entries** grouped by recovered cwd.
- **Security (mandatory, because this is localhost + filesystem):**
  - **Bind `127.0.0.1` only**; reject any request whose `Host`/`Origin` is not exactly
    `127.0.0.1:PORT` / `localhost:PORT` (defeats DNS rebinding independent of CORS).
  - **Per-launch bearer token on ALL routes incl. SSE** (EventSource can't set headers
    → token in URL or `SameSite=Strict` cookie + preflighted companion fetch); return
    `401` before any FS access.
  - **Strict CSP** (no inline script; `connect-src 'self'`).
  - **All preview/transcript/log/error/result text rendered as text nodes only** in the
    web app (never `dangerouslySetInnerHTML`); an XSS-injection fixture test asserts no
    execution.
  - **Path-escape guard:** validate `slug`/`session`/`runId`/`agentId` against a strict
    charset and `resolve()`-verify the final path stays inside `claudeHome`.
  - **Logging/redaction:** never log file contents (counts/codes only); never log full
    paths (basename/hash); scrub `/Users/` + `$bunfs` from any logged error;
    `warnings[].detail` carries codes, not raw text. A test greps logs for `/Users/`,
    `$bunfs`, and known-secret fixtures and asserts absence.

---

## 5. Live path (`live` phase; contract set now so it's not retrofitted)

1. **Detect running** = `subagents/workflows/wf_<id>/` present **without**
   `workflows/wf_<id>.json` (corroborated by an empty `tmp/.../tasks/w<id>.output`).
2. **Authoritative live source = `journal.jsonl` (cursor-based tail) + per-agent
   `agent-*.jsonl`**, correlated by `agentId`. Journal events are only `started` and
   `result` (`{type,key,agentId[,result]}`). Live UI is honestly scoped to the
   lifecycle the journal guarantees (`queued→running→done`); per-card
   **metrics/tokens/tools/duration appear only on finalize** (they live in `wf_*.json`).
   Richer live tool output, if shown, reads the **hardlinked `tool-results/<id>.txt`** —
   no `/tmp` dependency.
3. **On finalize**, `wf_*.json` lands → reconcile the live-built graph to it. The
   journal is authoritative until it stops appending; only then does `wf_*.json`
   structure take over (resolves the finalize-vs-tail race). Re-read-and-diff
   `wf_*.json` per fs event is valid **post-finalize only**.
4. **SSE deltas:** on an fs event, re-normalize the affected run via the adapter and
   emit a versioned delta keyed `runId`+`eventId`; the client **patches `node.data` in
   place** (CSS-animate) and **re-layouts only on structural add/remove** (batched),
   never on a metric tick. Reconnect via `Last-Event-ID` + snapshot. Per-run reads are
   **single-flight**; stale-mtime diffs discarded; a torn read keeps last-good rather
   than flipping `incomplete`.

---

## 6. Render / layout pipeline (`apps/web`)

- **Library: `@xyflow/react` v12.** Rendering stays behind the framework-agnostic run
  model so the viz layer is replaceable.
- **Layout: a deterministic hand-rolled vertical phase-lane layout is the DEFAULT**,
  behind a thin swappable `layout` module. At strictly-layered ≤14 nodes the geometry
  is pure arithmetic — jitter-free, no nested-box mush, no heavy bundle. **elkjs is the
  lazy/deferred fallback** reserved for a future real cross-phase DAG (agent-spawns-
  agent). M3 acceptance is **engine-agnostic**: "reads as crisp vertical phase lanes."
- **Edges:** the single synthesized `phase_i → phase_i+1` spine only; **no agent-level
  edges**.
- **[live] Batch structural relayout + `fitView` in a ~150–250 ms window** (≈7
  phase-start agents arrive near-simultaneously); during live, animate new nodes into
  position and **`fitView` only on first render or explicit user action**, never per
  node-add (avoids thrash).

---

## 7. Shell / IA (`apps/web`)

- **Fullscreen canvas** is the app. **Collapsible left icon rail** (keeps >90% viewport
  when collapsed): project switcher (showing the **decoded absolute path**, multi-entry
  on slug collision), run list (status icon / agentCount / duration / timestamp),
  settings.
- **Right detail panel** (LangSmith pattern), filled **instantly from card data** (zero
  transcript I/O); "open transcript" lazy-loads `agent-*.jsonl`.
- **AgentCard** (~260 px): state dot + mono label + model badge; `lastToolSummary`
  (2-line clamp); metric pills (duration / tokens / tools); 3 px state-colored left
  rail. `tokens=0` → dimmed `—`, never "0". Killed-run `progress` agents → **interrupted**
  badge, not a live pulse.
- **Run header:** narrator `logs[]` as phase-boundary chips; **partial-failure badge
  even when `status=completed`**; `error` shown sanitized with `internalDetail`
  collapsed.
- **Design system:** dark-first (light deferred); mono for machine identifiers;
  saturation reserved for state semantics; 4 px grid; 150–200 ms ease for UI,
  looping motion **only** for live states; **no `$` cost framing** in v1. **Deep-linkable
  `project + session + run + agent` in the URL.**

---

## 8. Failure modes (the adapter/UI must survive each — fixtures in `.argus/fixtures/`)

| Mode | Behavior |
| --- | --- |
| Unknown node `type` / agent `state` | drop-with-warning / `unknown` (neutral); never crash |
| Unknown / extra fields | tolerated (passthrough), never emitted (allowlist) |
| Missing `phaseIndex` | node dropped-with-warning; **no** phantom phase 0 / `0→1` edge |
| Torn or missing `wf_*.json` | partial model from journal; `incomplete=true` |
| Bad JSONL line | skipped; rest parsed |
| `killed`/`failed` mid-run | `progress` agents → `interrupted`; read `error` + `logs[]` |
| Completed-with-hidden-failure | run-level `partialFailure` from `logs[]`; **zero** mis-attributed agent chips |
| Huge `result` / previews | capped at boundary; full result lazy; perf budget asserted |
| `bunfs` stack in `error` | hidden in collapsed `internalDetail`, never raw |
| Slug collision (cwds share a slug dir) | multiple switcher entries by recovered `projectPath` |
| Project with zero runs / bogus path | empty-with-reason, no crash |
| Secret-bearing content (prompts/results) | text-node render; never logged; never off-machine |

---

## 9. Format-version policy

The on-disk format is undocumented and unversioned (the `$bunfs` paths confirm an
internal build). Mitigations: the single adapter seam, zod `.passthrough()`/`.catch()`,
the `ADAPTER_FORMAT` pin (stamped on every model and reported on `/health`), and the
captured torn/killed/zero-token fixtures. Format compatibility is managed by the
adapter's defensive parsing, not by client-version signaling — a format change is
intended to be a one-file fix in `packages/adapter` (re-pin `ADAPTER_FORMAT`, adjust the
raw schemas). No "untested format" drift badge is shipped: it would require a per-client
version signal the on-disk format does not reliably expose, so it would be an absent
guarantee rather than a real one.
