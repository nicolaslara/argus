# argus — Architecture Review

_Reviewed against the live tree on 2026-06-05. Gates green: `npm run typecheck` (0), `npm test` (162 passed / 10 files), `npm run lint` (0), `npm run build` (0). All material claims verified against the code; file:line citations throughout._

---

## 1. Executive Summary

argus is a read-only viewer for Claude Code workflow runs, structured as a 4-package npm-workspaces monorepo (`contract` / `adapter` / `server` / `web`) with a strict acyclic dependency direction (`web → contract`; `server → adapter → contract`). The central architectural bet — **all knowledge of the undocumented, unversioned on-disk format is isolated behind `packages/adapter` and a single injected `FileSystemPort` seam** — holds up under direct inspection. The four load-bearing invariants are real and enforced: format isolation (adapter is `node:fs`-free), defensive parsing (zod `.passthrough()`/`.catch()` + emit-allowlisted projection), security ordering (Host/Origin → token → charset → `resolve()`-in-home → FS), and text-node-only rendering (zero `dangerouslySetInnerHTML`). The codebase is materially more advanced than a paper review would assume: live SSE, plan-AST parsing, overlay binding, a `RunLiveness` state machine, and the explain/subui/describe engines all exist and ship.

The risk profile is correspondingly mature: there are **no architectural blockers**, but a handful of concrete gaps undercut stated guarantees. The sharpest is that **the server prints the bearer token to stdout unconditionally** (`index.ts:378-381`), defeating the deliberate `ARGUS_PRINT_TOKEN` redaction gate in the launcher and contradicting its own comment. Two "degradation is detected best-effort" claims are overstated end-to-end: `clientVersion` is dead-plumbed (no route populates it, the drift badge does not exist), and `coverageRatio` / `warnings[]` are honestly computed by the adapter but never surfaced in the UI — so a half-resolved plan or a dropped-phase run renders with no degradation signal. The `node:fs`-free contract test guards only 2 of 5 format-aware adapter files, and the SSE streaming path (`handleStream`) has zero test coverage. None of these threaten the design; all are addressable this week.

**Overall grade: A− (B+ on security hygiene).** Architecture is sound and the invariants are genuine; the deductions are for stated-but-unwired capabilities and a real (if localhost-scoped) credential-redaction gap.

---

## 2. Strengths

- **Format isolation is real, not aspirational.** No `node:fs` import in any non-test `packages/adapter/src/*.ts`; disk access flows exclusively through the injected `FileSystemPort` (`boundaries.md §2.1`). A future Tauri sidecar / remote host needs only a new port impl.
- **Defensive parsing + emit-allowlist.** zod schemas tolerate unknown/missing fields; the emitted `RunModel` is built by explicit field projection, never by spreading parsed JSON — a future secret-bearing field cannot ride to the client (`boundaries.md §2.3`).
- **Security ordering is correct and test-backed.** Host/Origin → per-launch bearer token → charset → `resolve()`-inside-home → FS (`index.ts:320-356`, `routes.ts:56-192`). `/health` is open but Host-checked. Path-escape guards (`safeRunScriptPath`, `perRunScriptBasename`) reject separators/`..`/non-`.js` before any read (`routes.ts:100-117`, `index.ts:336-351`).
- **XSS surface is clean.** Zero `dangerouslySetInnerHTML`/`innerHTML` in `apps/web/src`; `subui.ts:27-28` coerces every leaf to a string and `:78` switch-drops off-grammar `kind`s.
- **A formal liveness state machine exists.** `RunLiveness = 'running' | 'stale' | 'finalized'` with `classifyRunLiveness()` (`live.ts:153,174`) — not the implicit file-exists checks a paper review assumed.
- **Honest live scoping.** SSE journal-watch → `changed` → full refetch is a deliberate, documented choice for the 1–14-agent corpus (`App.tsx:144-146`), not an oversight.
- **`.argus/` is gitignored and untracked** (`.gitignore:15`; `git ls-files .argus` empty). Real fixtures (`finished/`, `named-workflows/`, `live/probe-2phase`) exist locally.

---

## 3. Prioritized Risk Table

| # | Risk | Sev | Why it matters | Fix | Effort |
|---|------|-----|----------------|-----|--------|
| 1 | **Server prints bearer token to stdout unconditionally** (`index.ts:378-381`) | **HIGH** | Defeats the `ARGUS_PRINT_TOKEN` redaction gate in `dev.mjs:17-21`; any supervisor / scrollback / log capture now holds a live credential. Contradicts the file's own `index.ts:377` "Never logged…" comment and `boundaries.md §4`. | Gate the server print behind the same `ARGUS_PRINT_TOKEN` env, or write the token only to the launcher's private channel. | S |
| 2 | ~~**`clientVersion` is dead-plumbed; no format-drift badge exists**~~ — RESOLVED 2026-06-06 | ~~MED~~ | Decided: deleted the dead plumbing. The `RunModel.clientVersion` field, the `AdapterContext`/`LiveModelOptions` `clientVersion` options + their `!== undefined` guards, and the "untested format" badge prose in `boundaries.md §9` are all removed. Format compatibility is now documented as managed by the adapter's defensive parsing + the `ADAPTER_FORMAT` pin (reported on `/health`) — no absent guarantee remains. | DONE | M |
| 3 | **`coverageRatio` / `warnings[]` computed but never surfaced in UI** | **MED** | Adapter honestly emits `coverageRatio`, `derivedFrom`, coded `warnings[]`; web reads `derivedFrom` (`App.tsx:205,246`) + `unplanned`/`ambiguous`/`partialFailure` but **no** read of `coverageRatio` or `.warnings` anywhere in `apps/web/src`. A 50%-coverage plan / dropped-phase run renders with no degradation indicator — the concrete "silent degradation" case. | Surface a coverage / warnings affordance (header chip or detail-panel section). | M |
| 4 | **`node:fs`-free contract test covers only `index.ts` + `raw.ts`** (`adapter.test.ts:513`) | **MED** | `live.ts`, `plan.ts`, `discovery.ts` are equally format-aware and fs-free *in fact* but unguarded; a future `node:fs` import into any of them passes the test. The invariant is cited as load-bearing but its scope is narrower than claimed. | Extend the test's file list to all `packages/adapter/src/*.ts` (excluding `*.test.ts`). | S |
| 5 | **SSE path (`handleStream`) has zero test coverage** | **LOW-MED** | `routes.live.test.ts` covers `/live`, `agentResult`, `describe`, the L1 merge — but nothing exercises `handleStream`, watch teardown (`index.ts:305-317`), the 150 ms debounce, or `/stream` token-gating/charset rejection. | Add a `/stream` 401 test + a watch-emit/teardown test (fake port). | M |
| 6 | **Live SSE emits coarse `changed`, not incremental `RunDelta`** (`index.ts:273-286`) | LOW | Client refetches the whole live model on every append (`App.tsx:160-162`); `RunDelta` (`contract:457`) has zero producers/consumers. Fine for ≤14 agents and explicitly chosen — documented debt, not a blocker. | Revisit at scale (see §4); keep `RunDelta` as the seam. | — (defer) |
| 7 | **No timeout on `elk.layout()`** (`elk.ts:151`) | LOW | A pathological plan DAG hangs the main thread indefinitely; the "caller falls back on rejection" comment is hollow because a hung layout never rejects. | Wrap in `Promise.race` with a timeout reject. | S |
| 8 | **Lazy full-result path reads the entire journal into memory before the cap** | LOW | `handleAgentResult` (`routes.ts:584`) + `agentResultFromJournal` call `port.readFile` (`fs-port.ts:16`, whole file as UTF-8, no `stat`/size guard); `RESULT_EMIT_CAP` (512 KB) caps the *response body*, not the *read*. A multi-MB journal is fully buffered server-side. LOW on localhost. | Document the assumption now; `stat`-gate or stream-read when remote-host lands. | S |
| 9 | **EventSource has no `onerror` handler** (`App.tsx:159-167`) | LOW | Relies solely on server `retry: 3000`; no client backoff, no `Last-Event-ID` resume, no surfaced "connection lost" state. | Add `onerror` + a connection-state indicator at the live gate. | S |
| 10 | **web→adapter test import is a layering-purity smell** (`overlay.test.ts:5`) | LOW | NOT a bundle/production-dep risk — `npm run build` emits only `index.js` + lazy `elk.js`, web `package.json` does not list `@argus/adapter`, and the import is in a `*.test.ts` Vite never bundles. Purely an unenforced layering smell. | Add a `no-restricted-imports` ESLint rule + move fixture-loading to a test helper. | S |

_Discarded as stale/incorrect from prior reviews: "acorn not declared" (it is — `adapter/package.json` declares `^8.16.0`); "web test import causes bundle bloat" (it does not); "no liveness state machine" (there is one, 3 states); "elk direction DOWN" (it is `RIGHT`, `elk.ts:114`)._

---

## 4. Evolution Roadmap

The architecture was designed for this trajectory; each stage has a clean seam already in place.

**Now → Live (current gate).**
- Land risks #1–#4 (token redaction, clientVersion/badge decision, coverage/warnings surfacing, contract-test widening) — these close stated-but-unwired guarantees before live ships broadly.
- Add the SSE tests (#5) and `elk` timeout (#7) so the live path is observably correct.
- The coarse `changed` → full-refetch (#6) is correct for ≤14 agents; keep the `RunDelta` type as the documented seam, do not implement it yet.

**Live → Interact (`workpads/interact/design.md`).**
- The read-only invariant (no writes into any `.claude` tree, `boundaries.md §0`) is the wall interact must deliberately breach behind an explicit, opt-in, separately-authorized surface — do **not** relax the existing read API. Add a write port distinct from `FileSystemPort`, and a second capability token so a leaked read token cannot drive a session.
- Wire `Last-Event-ID` resume + client `onerror` (#9) first; interactive sessions cannot tolerate silent SSE drops.

**Interact → Sidecar / Remote host.**
- The injected `FileSystemPort` is exactly the seam for a Tauri sidecar or remote impl — no adapter change required, by design.
- Before remote: convert the whole-file `readFile` reads (#8) to `stat`-gated / streamed reads, and harden the redaction story (the token print #1 becomes a genuine network-credential leak off localhost).
- Re-examine the Host/Origin allowlist (`index.ts:323`) — it assumes `127.0.0.1`/`localhost`; remote needs a real auth model, not the localhost shortcut.

**Remote → Scale (many agents / large runs).**
- This is when `RunDelta` (#6) earns implementation: server-side diff per fs event, client patches `node.data` in place + relayouts only on structural change (`boundaries.md §5.4`).
- Batch structural relayout + `fitView` in a ~150–250 ms window (`boundaries.md §6`).
- The hand-rolled vertical phase-lane layout stays the default; elkjs (lazy, `elk.ts`) is the cross-phase-DAG fallback — keep it deferred.

---

## 5. Stack Verdict

| Dependency | Verdict | Rationale |
|------------|---------|-----------|
| `@argus/contract` (zero runtime deps) | **Keep** | The acyclic-direction anchor. No deps = no leakage path. |
| `zod` (adapter) | **Keep** | Load-bearing for defensive parsing of an untrusted format. Exactly the right tool. |
| `acorn ^8.16.0` (adapter) | **Keep** | Explicitly declared (not root-hoisted, contrary to prior claims); powers wrap-parse → PlanModel. Stable, minimal. |
| Node `http` + SSE (server) | **Keep** | No framework needed for a localhost read API; keeps the security ordering explicit and auditable. |
| `chokidar` / node `FileSystemPort` impl (server) | **Keep** | The injected-port boundary makes this swappable for sidecar/remote. |
| React 19 + Vite 7 (web) | **Keep** | Current, fast, matches the read-only SPA shape. |
| `@xyflow/react ^12.3.5` (web) | **Watch** | Caret-pinned; viz lives behind a framework-agnostic run model so it is replaceable, but pin the minor and watch v12 churn. |
| `elkjs` (web, lazy) | **Watch** | Correctly deferred behind the hand-rolled default; the missing layout timeout (#7) is the only concrete concern. Reassess only if/when cross-phase DAGs become the norm. |
| `@tanstack/react-query` (web) | **Keep** | Clean fit for the snapshot+invalidate refetch model; the full-refetch-on-`changed` strategy leans on it intentionally. |

No replace recommendations. The stack is deliberately small and each piece sits behind a stated boundary.

---

## 6. Quick Wins (this week)

1. **Gate the token print** behind `ARGUS_PRINT_TOKEN` in `index.ts:378-381` (matches `dev.mjs`). [risk #1, HIGH, ~15 min]
2. **Widen the `node:fs`-free contract test** at `adapter.test.ts:513` to glob all `packages/adapter/src/*.ts` minus `*.test.ts`. [risk #4, ~20 min]
3. **Add a `/stream` 401 test** (token-gating) — the cheapest slice of risk #5. [~30 min]
4. **Decide `clientVersion`**: either render the drift badge or delete the dead plumbing + update `boundaries.md §9` — stop shipping a guarantee that does not exist. [risk #2]
5. **Surface `coverageRatio` / `warnings[]`** as a header chip so degradation is never silent. [risk #3]
6. **Add an `elk.layout()` timeout** (`Promise.race`, `elk.ts:151`) and a `no-restricted-imports` rule blocking `@argus/adapter` from `apps/web`. [risks #7, #10]

---

_Key files: `apps/server/src/index.ts` (token print L378-381; SSE L256-318), `packages/adapter/src/index.ts` (clientVersion L259), `packages/adapter/src/adapter.test.ts` (contract-test scope L513), `apps/web/src/App.tsx` (SSE L156-168; derivedFrom L205), `apps/web/src/layout/elk.ts` (no timeout L151; direction RIGHT L114), `apps/server/src/routes.ts` (full-result read L584), `packages/contract/src/index.ts` (RunDelta L457, clientVersion L115)._

---

## 7. Autonomous review backlog (2026-06-06)

A 6-lens read-only audit (boundaries · test gaps · dead-code/dup · robustness · perf · doc drift).
The §6 quick-wins above are ALL now shipped. Boundaries verdict: STRONG (4-package acyclic deps,
adapter format-isolation, web↔contract-only all hold). Prioritized remaining work:

- [x] **ARCH-1 (user-requested) — Table: execution-order view + graph cross-highlight. DONE
  2026-06-06.** A "⇋ order" mode (pure `orderAgentsByExecution`) groups agents by phase (the
  sequential spine) with parallel agents indented under each phase header — a vertical DAG
  (validated: Research·7 → Design·2 → Review·4 → Synthesize·1, 14 agents indented). Graph
  cross-highlight via a pure `resolveHighlight` threaded data-only (mirroring the failure ring)
  into paintOverlay + expandInstances: HOVER a row → transient glow on the matching node
  (validated: 1 node, no panel), SELECT → persistent ring + DetailPanel. Resolves to the instance
  card when expanded OR the aggregate plan node when collapsed. +14 tests (401). (Workflow's
  implement agent socket-died at the tbody-wire + CSS + tests; finished in the main loop.)
- [x] **ARCH-2 — Consolidate duplicated formatters. DONE 2026-06-06.** formatDuration (×3),
  formatTokens/formatTools (×2 each), formatElapsed (×1) now live ONCE in shell/format.ts with a
  consistent null/0 → em-dash rule; AgentCard/AgentChip/AgentTablePanel/App import them (local
  copies deleted). One deliberate consistency fix: `0ms` now renders `—` everywhere (was a mix of
  `0ms`/`—`), matching the tokens/tools "no value" convention. +19 tests (420 total).
- [x] **ARCH-3 — Doc-drift sweep. DONE 2026-06-06.** Reconciled TASKS.md (three→two views),
  boundaries.md (removed the never-built `/transcript` + deleted `resolveClientVersion`; completed
  the real 14-endpoint API list; corrected the SSE `changed` vs deferred-`RunDelta` claim), WORKING.md
  (the `/stream` RunDelta note), and README/project.md/AGENTS.md (now mention the shipped table +
  exec-order DAG + cross-highlight, pinned/filter/group-by rail, loop-drill, coverage/warnings chips,
  SSE connection state). Docs-only; gates stayed green; reviewed for no overstatement. FOLLOW-UP:
  the README `docs/screenshots/*` predate the table/pinned/filter/coverage features — a re-capture
  would freshen them (ARCH-8, S).
- [x] **ARCH-4 — Perf memo-stability. DONE 2026-06-06.** Rail's `referenceNow` is now pinned at
  mount (`useMemo(()=>Date.now(),[])`) instead of a fresh `Date.now()` per render — it was
  re-rendering every memoized RunRow/WorkflowTreeNode on every 2.5s poll. `useLiveAgentFill` now
  keys its result memo on a PRIMITIVE content signature instead of `queries.map(q=>q.data)` (a
  fresh array each render that rebuilt the map every render). Behavior-neutral (420 tests
  unchanged). NOTE: the PX plan-explanations poll was ALREADY gated (`enabled: view==='plan' &&…`)
  — no fix needed there.
- [ ] **ARCH-5 — Test gaps (high/M).** Extract the web SSE connection state machine to a pure
  tested helper (browser-only today); a server log-scrubbing test (no `$bunfs`/`/Users/` leaks);
  widen path-traversal tests; test App.tsx pure helpers (deriveFailureInfo/pickFailurePoint/
  formatArgs) + chromeAwareFitOptions.
- [ ] **ARCH-6 — Robustness signals (med/S).** Discovery op failures are silently swallowed (no
  client signal); the full-journal read is unbounded (no pre-flight size cap); a closed SSE
  connection isn't surfaced server-side. Add honest signals/bounds.
- [ ] **ARCH-7 (deferred) — App.tsx decomposition (M), large-graph 200+ safeguard (L), contract
  type tests (S), remove dead `runModelToGraph` export (S).** Incremental / gate-on-need.
