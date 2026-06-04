# prototype — knowledge

Findings, decisions, and evidence (screenshots, rendered runs, test output) for the
prototype phase. Blocked until the architecture gate passes.

## Findings

- **M0 (2026-06-04):** the 4-package monorepo from `boundaries.md` §1 builds and runs
  on Node 24 / npm 11. Workspace packages resolve via npm symlinks + `exports:
  "./src/index.ts"` + `moduleResolution: bundler` (no build step for the TS libs;
  Vite transpiles the web, tsx runs the server, tsc type-checks the whole tree from
  one root `tsconfig.json`). `@vitejs/plugin-react` v5 + Vite 7 + React 19 install
  clean (no peer conflicts).
- The empty shell renders fullscreen via `@xyflow/react` (dark canvas, dot-grid,
  Controls + MiniMap) with a centered wordmark overlay (`pointer-events:none` so the
  canvas stays pannable). The dev-only console noise was a `favicon.ico` 404 → fixed
  with an inline SVG data-URI favicon (no network request).

## Decisions (locked)

- **eslint ignores `.claude/**`** — the saved workflow scripts use Workflow-tool
  runtime globals (`agent`/`phase`/`log`/`parallel`); they are not app source.
- **vitest pinned to v4** — v3 carried a critical advisory (GHSA-5xrq-8626-4rwp, the
  Vitest UI server) we never trigger, but v4 clears `npm audit` (0 vulns) and our
  test surface is trivial.
- Server **`/health` is token-free** (liveness, no FS access) but still Host-checked;
  `/api` + `/stream` require the per-launch bearer token, enforced before any FS read.

## Evidence

- `.argus/screenshots/argus-m0-empty-shell.png` — empty fullscreen shell at 1440×900.
- Gate (2026-06-04): `tsc --noEmit` clean; `eslint .` clean; `vitest run` 4/4;
  `vite build` ok (190 modules, ~373 KB JS); `npm audit` 0 vulns. Server smoke:
  `/health`→200 (no token), `/api/ping`→401 (no token)/200 (token), bad `Host`→403,
  listener bound to `127.0.0.1` only.

### M1 (2026-06-04) — adapter + node FS port

- **Built:** `packages/adapter/src/raw.ts` (the only raw-format-aware module: zod
  `.passthrough()/.catch()` schemas + projection/sanitize/derive helpers) →
  `parseFinalizedRun(raw, ctx)` (`index.ts`, pure, emit-allowlisted) → `loadRun(port,
  wfJsonPath, ctx)` reads through the injected port. `apps/server/src/fs-port.ts` is
  the **read-only** `NodeFileSystemPort` (no write method; `watch` is a minimal
  `fs.watch` stub — chokidar lands at M6). 38 tests over all 5 fixtures + a port
  contract test.
- **Decision — emitted content is shown verbatim; redaction is scoped.** `$bunfs`
  (Claude's internal cli.js bundle path) must not appear in any **default-rendered**
  field; it is allowed ONLY in the collapsed `error.internalDetail` (per
  `boundaries.md` §2.3). `/Users/` and other user paths in previews/logs/args are the
  user's OWN content shown back locally → **not scrubbed** (capped + text-node
  rendered). Redaction applies to server **logs** and the collapsed `$bunfs` stack,
  not to emitted user content. (Resolved two contradictory assertions the M1
  implementer wrote; the adapter itself was correct per boundaries.)
- **Process note (see the workflow-authoring-gotchas memory):** `argus-implement`
  failed 3× on the final `StructuredOutput` call even after hardening — but the
  **implement agent did the real work on disk** each time. Pragmatic pattern: let the
  workflow implement, then **verify + fix + commit from the main loop** (run the gate,
  resolve any issues) rather than chasing the flaky finalization. The Record phase
  (workpad updates) is being done by hand here for the same reason.
- **Evidence:** `npm test` → 2 files, 38 passed; `tsc --noEmit`, `eslint`, `vite
  build` all green.

### M2 (2026-06-04) — discovery (projects + runs)

- **Built:** `packages/adapter/src/discovery.ts` (the only module that knows the
  on-disk *tree* layout) → `discoverProjects(port, claudeHome)`,
  `discoverRuns(port, project, claudeHome?)`, `discoverWorkflowMetas(port,
  projectPath)`, `parseWorkflowMeta(src, file?)` (re-exported from `index.ts`,
  replacing the two M1 stubs). Each has a `…WithReason` report variant returning
  `{ items, reasons }`. Added `WorkflowMeta`/`WorkflowMetaPhase` to
  `packages/contract`. All disk access goes through the injected `FileSystemPort`;
  the adapter stays **node:fs-free**. 16 new tests (deriveSlug, discoverRuns over a
  fake in-memory port seeded from the 5 real `finished/*.wf.json`, slug-collision,
  bogus/missing-path, `parseWorkflowMeta` over real `named-workflows/*.js` + null
  cases). Dogfood vs the real `~/.claude` tree: `discoverProjects` → 3 projects;
  `discoverRuns(modal-rust)` → 20 runs with correct header fields + abs-path keys, no
  crash.

- **FINDING — scriptPath has TWO observed shapes; recovery needs a per-slug
  fallback.** (1) `<project>/.claude/workflows/<file>.js` → authoritative
  `recoverProjectPath` (completed-14, killed-9, resumed-13). (2)
  `~/.claude/projects/<slug>/<session>/workflows/scripts/<name>-wf_<id>.js` → NOT
  project-recoverable: its prefix is the slug-dir cache path (it *also* contains
  `.claude/workflows/`, so shape detection rejects any prefix under
  `.claude/projects/`). completed-3 + failed-1 carry shape (2).
  **`decodeSlug` is lossy** — `-Users-nicolas-devel-modal-rust` decodes to
  `/Users/nicolas/devel/modal/rust` (the `-` in `modal-rust` becomes `/`), so naive
  slug-decode would split one project. **Resolution (two-pass in `readAndResolve`):**
  a shape-(2) run is grouped under a **UNIQUE recovered sibling** in the same slug dir
  if one exists (the common case — earlier runs persist the real root); otherwise it
  falls back to `decodeSlug` so the run still **surfaces, never drops**. Verified: all
  4 modal-rust fixtures (2 recoverable + 2 cache-shape) group under one ProjectRef.

- **deriveSlug PINNED + verified against disk.** The M1 regex `/[^a-zA-Z0-9]/g → '-'`
  is correct unchanged: `/Users/nicolas/.config/ghostty → -Users-nicolas--config-ghostty`
  (the leading `/` and the `.` of `.config` each map to `-`, giving the double dash).
  Confirmed against the real on-disk dir name `~/.claude/projects/-Users-nicolas--config-ghostty`.

- **Header-only discovery (zero per-agent/transcript I/O).** `discoverRuns` reads ONLY
  the top-level header scalars `workflowName/status/agentCount/durationMs/startTime/
  summary` (all 5 fixtures DO carry a header `agentCount`) + `partialFailure` from a
  `logs[]` `/failed/` scan via the shared `findFailureLogLines`. It never walks
  `workflowProgress` or any `agent-*.jsonl`. `RunRef`/`ProjectRef` keyed/de-duped by
  the recovered **absolute projectPath** (slug kept only for path-building), so a slug
  collision (two cwds → one slug dir) surfaces as **multiple switcher entries**.

- **parseWorkflowMeta runs the meta LITERAL, not the script BODY (precise scope).** It
  extracts the balanced `{…}` literal after `export const meta =` (string-aware brace
  matching) and evaluates ONLY that literal in a no-arg `Function`. The workflow script
  **body never executes** (verified 2026-06-04: a `globalThis` side-effect in the body
  did not fire and `agent()` was never called), and the Workflow-tool globals
  (`agent`/`phase`/`log`/`parallel`) are not provided. **CAVEAT (corrects an earlier
  "execution-free / no access to globals" overstatement):** the `new Function` eval of
  the extracted literal *does* execute any arbitrary JS expression embedded inside that
  literal — verified an IIFE placed in the meta object ran and set a global. This is
  **not** an RCE concern under the local-first / read-only stance (the input is the
  user's own `.claude/workflows/*.js` on their own machine, not untrusted), but the
  guarantee is "the script body is sandboxed away", **not** "no code runs". Unparseable
  / no-`meta` / unbalanced / empty → `null`, never a crash. (Open follow-up: if we ever
  want a hard guarantee, swap the `Function` eval for a JSON5/AST-literal parse so even
  embedded expressions cannot run.)

- **CONTRACT DRIFT (accepted, documented) — `discoverRuns` gained an optional 3rd
  param.** boundaries.md §2.2 specifies `discoverRuns(port, project)`; the
  implementation is `discoverRuns(port, project, claudeHome?)`. **Why it is justified:**
  a `ProjectRef` alone cannot recover `claudeHome`, and Stance 4 forbids the adapter
  from reading `env`/`process` — so the home must be injected. The 3rd param **defaults
  to the production home**, making it backward-compatible with the ratified 2-arg
  signature (every existing call site and the boundaries surface still type-check). This
  is minor, defensible drift, recorded here so the contract and the code do not silently
  diverge; fold the optional param into a future boundaries.md §2.2 revision if/when
  that doc is next touched.

- **Robustness:** every dir/file access is try/guarded → a coded `reason`
  (`projects-dir-unreadable`, `slug-dir-unreadable`, `run-header-unreadable`,
  `workflows-dir-unreadable`, `workflow-meta-unparseable`, …) and the item is omitted.
  Nothing throws; a bogus/missing `claudeHome` returns `[]` + a reason.

- **Evidence:** `npm test` → 3 files, **54 passed** (38 M1 + 16 M2); `tsc --noEmit`
  clean; `eslint .` clean; `vite build` ok (190 modules, 372.88 KB JS). Dogfood smoke
  vs real `~/.claude`: 3 projects, modal-rust 20 runs, no crash.
- **Verifier (2026-06-04) — verdict COMPLETE, capability_proven.** Independent re-run
  of the gate reproduced green (tsc clean, eslint clean, vitest 54 passed, build 190
  modules). Confirmed on REAL data via the production `NodeFileSystemPort`:
  `discoverProjects` → 3 projects (unique abs-path keys, no reason codes);
  `discoverRuns(modal-rust)` → **20 runs** (completed 16 / killed 3 / failed 1), all
  abs-path-keyed; each `RunSummary` carries exactly the 8 ratified header fields and
  none of `agents`/`phases`/`logs`/`workflowProgress`. Stance 4 + privacy verified
  honored: zero `node:fs` imports in adapter *source* (the two matches are
  `*.test.ts` harnesses seeding the fake port from real fixtures — allowed); discovery
  touches disk only via `port.readJson` (headers) / `port.readFile`
  (`.claude/workflows/*.js`) / `port.listDir`, never `agent-*.jsonl` or
  `workflowProgress`; no write op anywhere (port has no write method); every access is
  try-guarded to a coded reason and never throws (cache-only fallback still surfaces
  the run). The M1 `'not implemented until prototype M2'` stubs are genuinely
  removed/replaced (verified in `git diff` + a repo-wide grep finds none). Two
  low-severity precision notes from the verifier are folded into the findings above
  (parseWorkflowMeta literal-eval caveat; `discoverRuns` 3rd-param contract drift) —
  neither blocks completion.

### M3 (2026-06-04) — render one finished run (server API + web canvas)

- **Built:** server `apps/server/src/routes.ts` (GET /api/projects, /projects/:slug/
  runs, /runs/:slug/:session/:runId — token-gated, strict segment charset +
  `resolve()`-inside-claudeHome path-escape guard, coded errors) wired into
  `index.ts`; secure dev token path — `scripts/dev.mjs` generates a per-launch
  `ARGUS_TOKEN`, shares it via env to both children, and `vite.config.ts` injects
  `Authorization: Bearer $ARGUS_TOKEN` **server-side via proxy.configure** (browser
  stays token-free; server token check never disabled); web `api.ts` (token-free
  same-origin fetch) + `mapping.ts` (RunModel -> xyflow nodes/edges) + a swappable
  `layout/` (deterministic `vertical-lanes` default) + `nodes/AgentCard.tsx` +
  `nodes/PhaseLane.tsx`; `@tanstack/react-query` data layer.
- **Verified on REAL data (Playwright):** the 14-agent run renders as vertical phase
  lanes in the **7/2/4/1** shape; run header shows `completed` + `partial failure`
  (the hidden `parallel[0] failed` log) with **zero** mis-attributed agents; the
  0-token `review:red-team` agent shows `tok —`. **0 console errors.** End-to-end
  token-proxy confirmed: `GET /api/projects` via the Vite proxy -> 200, 3 real projects.
  Screenshot: `.argus/screenshots/argus-m3-14agent-run.png`.
- **Process:** the implement workflow flaked on the final `StructuredOutput` call
  (heavy task) but built all the pieces on disk; it **did not wire `App.tsx`** (the
  build stayed byte-identical -> empty shell). The main loop assembled `App.tsx` +
  `main.tsx` (QueryClientProvider) + the node CSS, and fixed a `scripts/dev.mjs`
  ESLint `no-undef` (Node globals for `scripts/**`). Pattern reaffirmed: workflow
  implements -> main loop verifies + completes + commits.
- **Deferred to M4/M5:** run picker / project switcher (M4); 1-agent-run visual check
  via the picker, deliberate visual polish (spine visibility, single-agent lane
  centering, label tooltips), and the gate sign-off (M5). M3 proves the render works.
- **Evidence:** `tsc --noEmit` clean; `eslint` clean; `vitest` 54 passed; `vite build`
  ok (now ~413 KB JS — TanStack Query + render code); 0 console errors on the live run.

### P0 (2026-06-04) — Plan view, meta-only (run-free; review-the-workflow mode)

- **Built (smallest correct change, no new parser / no AST / no acorn):**
  - **Server:** `handleProjectWorkflows(deps, slug)` in `apps/server/src/routes.ts`,
    mirroring `handleProjectRuns` — `isValidSegment(slug)` (400 on fail) → resolve the
    slug to its `ProjectRef(s)` via `discoverProjects` → `discoverWorkflowMetas(port,
    project.projectPath)` for each → union + dedup by **file basename** → sort by name →
    `WorkflowMeta[]`. Unknown slug / no workflows dir → `[]` (never 500). Wired in
    `apps/server/src/index.ts` behind the same token gate as the M3 routes, via the
    regex `^/api/projects/([^/]+)/workflows$` (decode-guarded, identical pattern to
    `/runs`). Reuses the shipped `discoverWorkflowMetas` + `parseWorkflowMeta` — **no new
    format knowledge added.**
  - **Server test:** `apps/server/src/routes.test.ts` (3 tests, fake in-memory port
    seeded to reproduce the real tree — a finalized `wf_*.json` whose shape-(1)
    `scriptPath` recovers `/Users/nicolas/devel/modal-rust` + that root's
    `.claude/workflows/plan-research.js` + `implement.js`): bad slug `../etc` → **400**;
    valid slug → `WorkflowMeta[]` incl. `modal-rust-plan-research` with its **4 declared
    phases** `[Research, Design, Review, Synthesize]`, sorted + deduped; unknown slug →
    **[]**. Test count: 54 → **57**, all green.
  - **Web:** `fetchProjectWorkflows(slug)` in `api.ts` (same token-free same-origin
    `getJson`); a pure `planMetaToGraph(meta)` in **new module** `plan-mapping.ts` that
    maps `meta.phases` → 1-based vertical `phaseLane` nodes (reusing the **M3
    vertical-lanes layout** with EMPTY agentIds) + the single synthesized
    `phase_i→phase_i+1` spine edge (**no agentCard nodes, no edges beyond the spine**);
    `PhaseLane.tsx` gained an **optional** `subtitle` (from `meta.phases[].detail`,
    2-line clamp) + `hideAgentCount` slot — both gated so the M3 run render (which
    passes neither) is **byte-unaffected**; `App.tsx` got a minimal local-state
    **Plan ⟷ Execution toggle** (Execution = the unchanged M3 14-agent path; Plan =
    `fetchProjectWorkflows` → auto-select `plan-research`, fallback first →
    `planMetaToGraph` + the subtitle `PhaseLane`). Text rendered as **text nodes only**
    (no `dangerouslySetInnerHTML`).
- **UNCHANGED (verified via `git diff --name-only`):** `packages/adapter`,
  `packages/contract`, `apps/web/src/mapping.ts` — zero changes. `RunModel` and the
  M1/M2/M3 adapter+render code paths are untouched. The Execution view renders the M3
  run byte-identically (re-observed live after a Plan→Execution toggle: 4 lanes 7/2/4/1,
  `completed` + `partial failure`, `review:red-team` `tok —`).
- **Backend evidence (manual, real `~/.claude`, server on :4317 token-gated):**
  `GET /api/projects/-Users-nicolas-devel-modal-rust/workflows` (token) → **10
  workflows** incl. `modal-rust-plan-research` with phases `[Research, Design, Review,
  Synthesize]` (others: build-modal-rust-sdk, deploy-path, facade-local-orchestration,
  harden-image-upload, modal-rust-implement, modal-rust-materialize-workpads,
  modal-rust-refine-plan, remote-live-resilience, source-upload-remote). **No token →
  401**; **bad slug `..%2Fetc` → 400 `bad_request`**. Proxied (browser-equivalent)
  `GET /api/projects/.../workflows` via the Vite proxy → 200.
- **UI smoke (Playwright, 1440×900 fullscreen, real run):** default Execution view =
  the M3 14-agent run unchanged; click **Plan** → the run-free declared plan: **4
  ordered vertical lanes (1 Research / 2 Design / 3 Review / 4 Synthesize)** connected by
  the phase spine, each with its `meta.phases[].detail` **subtitle** (2-line clamp),
  header `modal-rust-plan-research · plan · 4 phases · declared`. Reads well at-a-glance.
  **0 console errors** across the full Plan↔Execution↔Plan cycle. Click **Execution** →
  the M3 run renders again unchanged. Screenshots:
  `.argus/screenshots/argus-p0-plan-research-plan.png` (the Plan view) +
  `.argus/screenshots/argus-p0-execution-toggle-back.png` (the toggle returning to M3).
- **Privacy check (honored):** the new endpoint reads ONLY `<project>/.claude/
  workflows/*.js` meta (via `discoverWorkflowMetas` → `port.listDir` + `port.readFile`
  on `*.js`, then the existing literal-eval `parseWorkflowMeta`) plus the run **headers**
  `discoverProjects` already reads to recover `projectPath` — **never** transcripts,
  `workflowProgress`, or `agent-*.jsonl`. Read-only (the port has no write method).
  No run/transcript content copied off-machine or into logs (coded errors only).
- **Visual note (deferred to M5 polish, not a P0 blocker; verifier-confirmed):** the
  agent-free Plan lanes inherit the M3 lane height (one card-row reserved even with 0
  agents), so each lane has generous empty space below its subtitle (visible in the live
  Playwright smoke + screenshots). It reads cleanly fullscreen; a future plan-specific
  lane-height (header + subtitle only) is a nice-to-have, correctly deferred to M5.
- **OPEN QUESTION / artifact-hygiene convention violation (low severity, do before
  merge).** Commit `eb11e07` committed **`verify-p0-plan.png` (67 KB) into the REPO ROOT
  (tracked)** instead of the gitignored `.argus/screenshots/` that project policy mandates
  for generated/captured artifacts (`.gitignore`: `.argus/` may contain run content). The
  image depicts ONLY the Plan view (declared workflow meta + the user's own static phase
  subtitles) with NO run/transcript/agent content or secrets, so the leak severity is low;
  the intended P0 screenshots are correctly under gitignored `.argus/screenshots/`.
  **Action:** `git rm` the root `verify-p0-plan.png` and keep captured screenshots under
  `.argus/screenshots/` only.
- **Evidence (toolchain green):** `tsc --noEmit` clean; `eslint .` clean; `vitest run`
  **57 passed** (4 files: 54 prior + 3 P0 route tests); `vite build` ok (415.05 KB JS).
- **Workflow picker (commit `eb11e07`, was undisclosed in the first self-report):** the
  Plan view ships a workflow `<select>` picker (`apps/web/src/App.tsx` `selectedWorkflow`
  state + `index.css` `.wf-picker`) that lists ALL named workflows and renders the
  selected one — not just the auto-select-`plan-research` path the report described. This
  is **in-scope** per the P0 text ("lists a project's named workflows and renders the
  selected one") and remains run-free / meta-only / no-AST; it passes the full gate
  (tsc / eslint / vitest 57 / build all green on current HEAD).
- **Verifier (2026-06-04) — verdict COMPLETE, capability_proven: true.** Independent
  re-run on REAL data (not trusting the report): live server on the real `~/.claude` →
  **10 workflows** incl. `modal-rust-plan-research` with 4 phases
  `[Research, Design, Review, Synthesize]`; token gate holds (no/bad token → 401), bad
  slug `..%2Fetc` → 400, bad Host → 403, POST → 405, unknown slug → 200 `[]`. Emitted
  keys are exactly the allowlisted `WorkflowMeta` set — **no `scriptPath` leak**. Stance 4
  honored: `packages/adapter`, `packages/contract`, `apps/web/src/mapping.ts` byte-identical
  (empty diff vs HEAD); no new parser / AST / acorn; `parseWorkflowMeta` tolerates
  missing/non-string fields and try/catches to `null`; the route reads ONLY
  `.claude/workflows/*.js` + run headers, **never** transcripts/`workflowProgress`/
  `agent-*.jsonl`; no `node:fs` in `routes.ts`; web imports no adapter/`node:*`; read-only
  port. Server log free of `/Users/` and `$bunfs`. Live Playwright: Execution = unchanged
  M3 (7/2/4/1, completed + partial-failure with the verbatim hidden `parallel[0] failed`,
  `review:red-team tok —`); Plan = 4 ordered lanes + subtitles + 3 spine edges only, no
  agent cards; reads well fullscreen; **0 console errors from our app** (the 2 console
  errors observed were 401s from an unrelated stray node process on :5173, not the app
  under test on :5174).
- **VCS-state correction (the first self-report was stale/inaccurate).** The report
  claimed P0 was "NOT committed... 11 tracked + 2 new files staged on disk." In reality
  the working tree is **CLEAN** and all P0 work is **COMMITTED** across two commits on
  branch **`phase1-scaffold-and-research`** (not `main`): `baf8769` ("run-free Plan view +
  Plan/Execution toggle") and HEAD `eb11e07` ("workflow picker in the Plan view"). The
  capability is unaffected; the record now matches the repo.

### PX (2026-06-04) — Explanation layer (default-on, `claude -p`, cached, background)

- **Built (smallest correct change; annotation-only on topology):**
  - **Contract (`packages/contract/src/index.ts`, ADDITIVE only):** `NodeExplanation
    { id, caption, pattern?, status:'baseline'|'pending'|'ready'|'error',
    source:'baseline'|'llm' }` + `ExplanationBatch { target, pending, engineAvailable,
    explanations }`. `RunModel`/`PlanModel`/`WorkflowMeta` shapes are **byte-unchanged**
    (M3/P0/P1 renders unaffected).
  - **Server engine (`apps/server/src/explain.ts`, NEW):** pure `hashArtifact` +
    `diskCacheIO(read/write)` + `defaultClaudeRunner(spawn)` + `cleanCaption` +
    `buildPrompt` + the `ExplanationEngine` (bounded background pool, default
    concurrency 3) + `planArtifacts`/`runArtifacts` extraction. `child_process` lives
    HERE (the adapter stays node:fs/child_process-free). Engine `warm()` seeds every
    node's baseline IMMEDIATELY then enqueues cache-check + generation in a microtask —
    `warm()` and the REST handlers never await generation.
  - **Routes (`apps/server/src/routes.ts`):** plan/run handlers `warm()` the engine in
    the background (never awaited → snapshot/plan responses unchanged). New poll
    endpoints `handleProjectPlanExplanations` + `handleRunExplanations` re-warm + return
    the current `ExplanationBatch`. Wired in `index.ts` `dispatchApi` BEFORE the
    `/plan` + snapshot routes (more specific), behind the SAME token gate + segment
    charset + `safeWorkflowJsPath`/`safeRunJsonPath` resolve()-guard.
  - **Web (`apps/web`):** `fetchPlanExplanations`/`fetchRunExplanations` in `api.ts`;
    `explanations.ts` = a TanStack Query poll (`refetchInterval` while `batch.pending`,
    then stops) + a PURE `overlayExplanations(graph, map)` that patches ONLY
    `node.data.subtitle`/`caption` text (topology untouched; returns the SAME ref when
    nothing to enrich). `App.tsx` overlays per active view. AgentCard gained a `caption`
    slot; PlanProcessNode a `subtitle` slot (PlanAgentNode already had one). Rendered as
    text nodes only (no `dangerouslySetInnerHTML`).
- **Cache key recipe (locked):** `hash = sha256(JSON.stringify(stableArtifact) + ' ' +
  PROMPT_VERSION)` where `stableArtifact = { kind, label, phase, role, evidence }`
  (the node id is EXCLUDED so two structurally-identical nodes collide → a reload is a
  hit). Stored at gitignored `.argus/cache/explanations/<hash>.json` =
  `{ caption, pattern, promptVersion }`. `PROMPT_VERSION = 'px-v1'` — bump it to bust ALL
  caches; a stale `promptVersion` on read is treated as a miss. v1 invalidation =
  bust+regenerate when the hash changes (verified: editing artifact evidence → new hash
  → new spawn, old + new entries both cached).
- **`claude -p` invocation (locked):** `claude -p --model haiku --output-format json`
  via `node:child_process.spawn` (`stdio:['pipe','pipe','ignore']`), the prompt written
  to stdin, parse the JSON, read the `.result` string. 30s timeout (SIGKILL on expiry);
  on ENOENT (`claude` absent) / non-zero exit / parse fail / timeout the runner resolves
  **null** → the caller keeps the baseline caption and the engine flips
  `engineAvailable=false`. NEVER throws, never leaves a hung child. `claude` is on PATH
  here = v2.1.162; the JSON envelope carries `result`/`usage`/`total_cost_usd` (we read
  only `result`).
- **Poll wiring (no SSE — the smaller correct choice; no SSE channel exists yet):**
  `GET /api/projects/:slug/workflows/:file/explanations` (plan) and
  `GET /api/runs/:slug/:session/:runId/explanations` (run) return baseline immediately and
  llm-enriched entries as the bounded pool finishes; the web polls every 1.5s while
  `pending`, then stops. The poll is the only thing that touches generation state — the
  snapshot/plan REST responses are byte-unchanged and do NOT await it.
- **Annotation-only proof:** the overlay patches only `data.subtitle`/`data.caption`;
  ids/types/positions/parents/edges/×N chips are identical between the enriched and the
  baseline screenshots. The execution overlay join key is `AgentNode.agentId` (carried as
  `data.agentId`); plan nodes join on `PlanNode.id` directly.
- **Verification (all green):** `tsc --noEmit` clean; `eslint .` clean; `vitest run`
  **95 passed** (83 prior + 12 new in `explain.test.ts`: hash stable/ignores-id,
  hash-change, cleanCaption, buildPrompt, cache MISS=1 spawn, HIT=0 spawn on reload,
  HASH-CHANGE=2 spawns, graceful-null + throwing-runner = baseline, planArtifacts +
  runArtifacts extraction). `vite build` ok (425.65 KB JS; elk chunk warning pre-existing
  from P1b). The cache test STUBS the runner — **no real spawn in tests**.
- **Live evidence (real `~/.claude`, modal-rust `plan-research`):**
  - **Enrichment + cache HIT:** a headless prewarm via real `claude -p` produced LLM
    captions for all 11 plan-research nodes in ~45s (concurrency 4) and wrote them under
    `.argus/cache/explanations/`. Run 1 (miss) = real spawn ~16.8s for one node; run 2
    (fresh engine, same cache) = **0 spawns, 201ms** (cache hit). Live server poll #1 =
    `pending` (warming) → poll #2 = `pending:false`, all 11 `ready/llm` served from the
    cache without re-spawning.
  - **Playwright UI smoke (1440×900, 0 console errors):** Plan view of the real
    `modal-rust-plan-research` AST plan shows enriched captions on fan-out/agent/merge
    nodes — e.g. `fan-out ×7` → "Spawns seven concurrent research agents",
    `agent research:${r.key}` → "Research Modal Rust surface: images, functions,
    volumes, GPU, modal-rs", `fan-out ×4` → "Spawn four concurrent reviewers across
    distinct lenses". Screenshot: `.argus/screenshots/argus-px-enriched-caption.png`.
  - **Graceful degradation:** restarting the server with `claude` stripped from PATH +
    a fresh empty cache → every node `status:error, source:baseline`,
    `engineAvailable:false`, the deterministic baseline caption retained (declared meta
    detail / agent subtitle), `/health` 200 (server stays up), 0 console errors.
    Screenshot: `.argus/screenshots/argus-px-degraded-baseline.png` (byte-identical
    topology to the enriched view, captions reverted to the declared baselines).
- **Privacy/security honored:** artifact text (the user's OWN local prompts/code) is
  passed to their OWN local `claude` auth — never off-machine, never logged. The cache
  lives under gitignored `.argus/` (verified `git check-ignore`). Cache paths are
  resolve()-guarded with a hex-only hash charset. Poll endpoints share the M3 token gate
  + path guards. Captions render as text nodes only.
- **Drift note (accepted, documented):** `RouteDeps` gained an OPTIONAL `explain?:
  ExplanationEngine` (absent in M3/P0/P1 route tests → those handlers behave exactly as
  before). The engine reads `import.meta.dirname` to locate the repo-root `.argus/cache`
  (overridable via `ARGUS_REPO_ROOT`); the whole layer is disablable via `ARGUS_EXPLAIN=0`.

- **Verifier (2026-06-04) — verdict COMPLETE, capability_proven: true (independent,
  not trusting self-report).**
  - **Capability fully proven on REAL data.** Re-ran the gate green (tsc clean, lint
    clean, build ok) + vitest **95/95**. Live against real modal-rust: `plan-research`
    enriched **all 11 nodes** and the 14-agent run enriched **all 14 execution agents**
    via real `claude -p`, with distinct, grounded, readable captions (e.g. "Spawns seven
    concurrent research agents", "Red-team modal-rust design for hidden assumptions and
    failure modes"). **Cache MISS vs HIT decisively demonstrated:** cold miss took **50s**
    (real spawns, **11 cache files written**); warm reload on a **fresh server process**
    served all 11 `ready/llm` in **~1s with 0 new cache writes** — a true disk cache hit,
    no re-spawn. (Supersedes the self-reported ~45s/201ms single-node figures with a
    whole-graph cold-vs-warm measurement.)
  - **Graceful degradation verified at the process level:** relaunched the server with
    `claude` stripped from PATH + an empty cache → `engineAvailable=false`, **all 14
    nodes `status=error / source=baseline`** with baseline captions retained, `/health`
    200, **no errors logged, no cache files written, server never crashed**. Confirms
    ENOENT/spawn-fail → null → baseline.
  - **Annotation-only + non-blocking confirmed at the WIRE level:** the `/plan` response
    and the run snapshot contain **NO** caption/captionSource/LLM-sentence fields (grepped
    the JSON); explanations are served ONLY via the separate poll endpoints, which return
    baseline immediately on first poll. `overlayExplanations` is pure and patches only
    subtitle/caption text. Enriched vs degraded screenshots show **byte-identical
    topology**.
  - **Stance-4 / isolation / privacy hold:** `child_process` lives ONLY in
    `apps/server/src/explain.ts` (verified at `explain.ts:19` + the adapter's own guard
    test that `index.ts`/`raw.ts` never import `node:fs`). Cache root resolves to the
    **argus repo's own gitignored `.argus/cache/explanations/`, NOT the target project's
    `.claude` tree** — nothing was written into `modal-rust/.claude`. Cache files contain
    only short captions (no transcript/secret leakage). Parsing tolerates missing fields
    (typeof guards, `.catch` on read). PX endpoints inherit the full security surface:
    **401** (no/bad token), **400** (path traversal on both the workflow file and runId),
    **403** (bad Host) all confirmed.
  - **Visual milestone READS WELL fullscreen:** fresh Playwright screenshot of the
    14-agent modal-rust execution view at 1440×900, **0 console errors**. The four phase
    lanes (7/2/4/1) render crisply; each AgentCard shows the LLM caption **clamped to 2
    lines with a subtle green left-tick**, integrated cleanly between the meta row and the
    metric pills. The single-agent **Synthesize** lane reads perfectly (covers the 1-agent
    case). Plan view live state matches the committed enriched screenshot, with captions
    on both **agent AND process** (fan-out/merge) nodes.
- **OPEN QUESTION / follow-up (pre-existing, NOT a PX regression):** the horizontal
  **Plan-AST elk layout** leaves roughly the bottom ~**60%** of the fullscreen canvas
  empty — the graph is wide-but-short and `fitView` centers it vertically. PX only adds
  caption text and does not change layout. Worth a follow-up for **Plan-view polish**, but
  out of scope for this capability. (Lives alongside the P0 agent-free-lane-height visual
  note as Plan-view layout debt.) **→ Largely resolved in U1** (below): the root cause
  was a *missing fitView refit* (the prop fits only on mount; the async AST graph never
  refit), plus over-wide elk inter-layer spacing; both fixed. The plan DAG is still
  intrinsically wide/short so some vertical band remains, but lanes no longer clip and the
  content is centered + readable.

### U1 (2026-06-04) — Unify the Plan & Execution visual language

**Capability:** a Plan agent (template) and an Execution agent (instance) are recognizably
the SAME component — one shared card shell + phase-lane grouping in BOTH views + a
consistent state/kind palette, chip family, and edge language.

#### The divergence we removed (baseline 5d7fa51)

| axis | Execution `AgentCard` (before) | Plan `PlanAgentNode` (before) |
|---|---|---|
| size | 260×132 | 220×76 |
| shape source | `.agent-card` (own CSS) | `.plan-agent` (own CSS, different border `#3a4250`) |
| left rail | state color (`STATE_COLOR`) | always `--argus-accent` |
| label | `.agent-label` mono ellipsis | `.plan-agent-label` mono ellipsis (dup) |
| caption | `.agent-caption` 2-line + green tick | `.plan-agent-sub` 2-line (dup, no tick) |
| footer | state + model + cached/failed flags + dur/tok/tools pills | `typed` chip (`.plan-chip`) + corner `×N` glyph |
| chips | `.agent-flag` family | `.plan-chip` family + `.plan-mult-chip` (separate) |
| layout | hand-rolled `horizontal-lanes` (lanes + parented cards) | `elk` (NO lane containers — flat DAG) |

Two cards, two CSS class families, two chip systems, and — the big one — the plan view
had **no phase-lane containers** at all (just a flat elk DAG), so the two views did not
read as the same graph.

#### The unified visual-language spec (recorded; what U1 standardizes)

1. **One shell component** — `apps/web/src/nodes/AgentCardShell.tsx`. Presentational only;
   takes already-structured props (no raw content, all text = React text nodes). Provides:
   shared **width `CARD_SHELL_WIDTH=248`**, radius 10, dark bg `#11161c`, border `#232a31`,
   a **kind-or-state-colored left rail** (3px), a **mono label with ellipsis**, a **2-line
   caption slot**, and a **view-specific FOOTER slot**. Height differs only by the footer
   row: **exec `124`**, **plan `92`** (`CARD_SHELL_HEIGHT_EXEC`/`_PLAN`). `AgentCard` and
   `PlanAgentNode` are now **thin wrappers** over the shell.
   - **Execution footer** = `state` label (state-colored) + model + cached/failed chips +
     `dur/tok/tools` metric pills. (tokens=0 → dimmed em-dash, unchanged.)
   - **Plan footer** = `×N` multiplicity chip + `typed` + `optional` chips — rendered in the
     SAME `.agent-chip` family as execution's cached/failed, so the footers share
     typography & color even though their slots differ by view.
2. **Phase lanes in BOTH views** — the Plan-AST view now reuses the **same `PhaseLane.tsx`
   container** the execution view uses. `plan-model-mapping.ts` groups **top-level** plan
   nodes by `PlanNode.phaseRef` into `phaseLane` group nodes (subtitle = `PlanLane.detail`,
   `hideAgentCount=true`), derives each lane's bounding box from elk's placements, and
   reparents the lane members (`parentId`/`extent:'parent'`, lane-relative coords). elk
   still does the intra-DAG layout of the structural connectors; we only wrap the result in
   lanes. **Loop bodies stay parented to their loop container**; a loop container is itself
   parented to its `phaseRef` lane when it has one (nesting: lane > loop > bodies). Nodes
   with `phaseRef==null` stay top-level/absolute (defensive — we never invent a lane the
   model doesn't carry). So both views now read as **"phase lanes of agent cards"**; the
   plan ALSO draws fan-out / merge / decision / loop connectors + multiplicity inside them.
3. **One palette / chip / edge language:**
   - **State/kind palette** is the single `STATE_COLOR` map (exported from `AgentCard.tsx`).
   - **One chip family** `.agent-chip` with color-by-`currentColor` variants:
     `-cached #8b949e`, `-failed #f85149`, `-typed #a371f7`, `-optional #d29922`,
     `-mult` (mono, accent). Saturation is **not** used to distinguish chips.
   - **One neutral edge color** `#475160`; **kind is carried by DASH + CURVATURE only**
     (fanout/merge solid straight, optional dashed off a decision, loop-back dashed+curved).
     **Saturation is reserved for run state.** **Confidence is the single border-STYLE axis**
     (`.plan-conf-heuristic` / `.is-optional` → dashed) — never color/opacity.

#### Cosmetic nits folded

- **fitView never refit the async Plan-AST graph** (the root of the "~60% empty + clipped
  lanes" issue). The `fitView` PROP fits on mount only; the AST graph replaces the meta
  graph after elk resolves, so it kept the meta-graph fit (off-center, rightmost lane
  clipped past x=1729 on a 1440 canvas). **Fix:** capture the React Flow instance via
  `onInit` and `inst.fitView({padding:0.12, duration:240})` in an effect keyed on a cheap
  node-id **signature** (so PX caption overlays — which never change ids — do NOT yank the
  viewport). After the fix all 4 lanes fit (x≈77→1363) and center.
- **Over-wide elk spacing.** `nodeNodeBetweenLayers 64→44` (narrower lanes) and
  `spacing.nodeNode 40→52` (spread parallel fan-out arms vertically → taller lanes), plus
  `nodePlacement.strategy NETWORK_SIMPLEX`. Pulls the wide/flat DAG toward the canvas aspect.
- **Card density.** Shared width 248 (was 260 exec / 220 plan); both views fill better.

#### Evidence

- **Toolchain (all green):** `npm run typecheck` clean; `npm run lint` clean; `vitest run`
  **95 passed** (unchanged count — no test touched a changed surface); `vite build` ok.
- **Scope / regression guard (git diff):** ONLY `apps/web/src/` changed
  (`AgentCardShell.tsx` new; `AgentCard.tsx`, `PlanNodes.tsx`, `MultiplicityChip.tsx`,
  `plan-model-mapping.ts`, `layout/elk.ts`, `index.css`, `App.tsx`). **`packages/adapter`,
  `packages/contract`, `apps/server`, and `apps/web/src/mapping.ts` are BYTE-UNCHANGED** →
  RunModel/PlanModel/WorkflowMeta contracts intact, the M3 execution **topology** (lanes +
  the synthesized `phase_i→phase_i+1` spine, produced by the untouched `mapping.ts`) is
  byte-unchanged, and the **PX annotation-only** guarantee holds (`explanations.ts` /
  `explain.ts` untouched; overlay still patches only caption/subtitle text).
- **UI smoke (Playwright, 1440×900, real modal-rust, server :4399 token-gated, 0 console
  errors across a full Plan↔Execution cycle):**
  - **Execution** = the M3 14-agent run unchanged: 4 lanes 7/2/4/1, `completed` +
    `partial failure`, green state rails, `review:red-team tok —` (em-dash), PX captions
    2-line clamped. **1-agent case:** the `synthesize` lane reads cleanly.
  - **Plan** = the SAME 4 phase lanes (Research/Design/Review/Synthesize) with
    `PlanLane.detail` subtitles, each containing `fan-out (×N) → research:${r.key} (×N,
    typed) → merge` and the `return` output terminal; the agent cards use the SAME shell.
  - Screenshots under `.argus/screenshots/`: `argus-u1-plan-14agent.png`,
    `argus-u1-execution-14agent.png`, and the side-by-side `argus-u1-plan-vs-execution.png`.
- **Residual (honest):** the plan DAG is intrinsically wide/short (4 sequential phases, ≤2
  stacked items per lane), so a vertical band of empty canvas remains above/below the
  centered lanes — much improved (no clipping, centered, readable) but not eliminated. A
  taller-lane / vertical-phase plan layout could fill more; tracked as Plan-view polish
  (M5), not a U1 blocker. Confidence: **medium-high** — capability proven on the 14-agent
  and 1-agent cases on real data; the residual band is the only soft spot.

#### Verifier (2026-06-04) — verdict COMPLETE, capability_proven: true (independent)

- **Capability proven on REAL modal-rust data.** `AgentCardShell.tsx` is a genuine single
  shell; `AgentCard` (exec) + `PlanAgentNode` (plan) are thin wrappers with view-specific
  footers (exec = state + dur/tok/tools pills; plan = `×N` + `typed`/`optional` chips)
  sharing one `.agent-shell` geometry (248px, radius 10, 3px left rail, mono ellipsis label,
  2-line caption) and one `.agent-chip` family. `plan-model-mapping.ts` groups top-level plan
  nodes by `phaseRef` into the SAME `PhaseLane.tsx` containers execution uses. Verified in
  screenshots: plan-research draws 4 lanes (Research/Design/Review/Synthesize) with
  fan-out/merge/multiplicity inside; refine-plan nests lane > loop > bodies + a decision
  diamond. A plan agent and an execution agent read as the same component.
- **Stance 4 + privacy hold.** `git diff` confirms `packages/adapter`, `packages/contract`,
  `apps/server`, `apps/web/src/mapping.ts`, `explanations.ts`, `plan-mapping.ts`, and
  `PhaseLane.tsx` are BYTE-UNCHANGED; only `apps/web/src/` render-layer files changed
  (`AgentCardShell.tsx` new). No `node:fs`/`child_process`/`writeFile`/`.claude` usage in web
  source (all grep hits are comments); all text rendered as React text nodes;
  `plan-model-mapping` tolerates `phaseRef==null`/missing placements (never invents lanes).
  Nothing writes into another `.claude` tree; screenshots gitignored under `.argus/`.
- **Toolchain gate independently re-run green:** tsc clean, eslint clean, vitest **95/95**,
  vite build ok. Screenshots (21:56:54+) post-date the last source edit (`elk.ts` 21:56:36),
  so the captured evidence reflects current code; working tree unchanged since.
- **Visual milestone reads well fullscreen at BOTH scales.** Execution: 4 crisp lanes
  (7/2/4/1), green state rails, PX captions, dur/tok/tools pills, `tok` em-dash; the
  Synthesize 1-agent lane reads cleanly. Plan: same 4 lanes + connectors + multiplicity,
  shared shell. The honest residual (wide/short plan DAG leaves a vertical empty band
  above/below the centered lanes) is real and visible in `argus-u1-plan-14agent.png` but does
  not impair legibility; correctly deferred as M5 polish, not a U1 blocker. The fitView refit
  bug is genuinely fixed (no clipping, content centered).

- **CORRECTION (low) — minor doc overstatement, not a defect.** The U1 spec above claims
  `STATE_COLOR` is "the single `STATE_COLOR` map (exported from `AgentCard.tsx`)" as a shared
  palette; the verifier notes the **plan rail uses `var(--argus-accent)`**, and `STATE_COLOR`
  is only consumed by `AgentCard.tsx` today (the plan view has no run state to paint until the
  P2 overlay). The palette IS a single source of truth, but the *shared consumption* by the
  plan view is **aspirational** (lands with P2's status-painted shared layout), not current.

- **OPEN QUESTION / artifact-hygiene (low, pre-existing, NOT introduced by U1).** The P0
  leak is **still unresolved**: `verify-p0-plan.png` remains tracked at the **REPO ROOT**
  instead of the gitignored `.argus/screenshots/`. It was committed in `eb11e07` (P0) and the
  P0 verifier explicitly flagged a `git rm` action that was never performed. Content is benign
  Plan-view meta (no run/transcript/secret per the P0 assessment), so privacy severity is low,
  but the tracked-artifact policy is violated. **Recommend `git rm verify-p0-plan.png` before
  any U1 commit.** (Out of U1 scope — does not block the U1 verdict.)

### M4 (2026-06-04) — Shell: collapsible left icon-rail (project switcher + run picker + settings)

**Capability:** a user can navigate ANY discovered project and ANY of its runs from a
collapsed-by-default left icon-rail — not just the hardcoded modal-rust default / the
auto-selected richest run — with selection lifted into shared app state so the
Plan⟷Execution toggle preserves the same project/workflow context, while the canvas keeps
>90% of the viewport when collapsed.

- **Built (smallest correct change; ONLY `apps/web/src/` touched — no adapter/contract/server
  change):**
  - **`apps/web/src/shell/Rail.tsx` (new):** a CONTROLLED, presentational rail. Three
    sections — Project switcher, Run picker, Settings stub — plus a collapse/expand toggle.
    It never fetches a run model or mutates the canvas; it only reports the user's
    project/run/workflow choice up via callbacks. All labels/values are React text nodes
    (no `dangerouslySetInnerHTML`); imports ONLY `@argus/contract` types + the local format
    helpers (no `node:*` / adapter).
  - **`apps/web/src/shell/format.ts` (new):** pure presentation helpers — `formatDuration`
    (`1.4s`/`48s`/`3m 12s`/`1h 04m`, `null`→em-dash), `formatRelativeTime` (`5m ago`/`3h
    ago`/`2d ago`→absolute `Mon D`; `now` injectable), `statusGlyph` (●completed / ◐
    completed-with-partialFailure / ✕ failed / ◼ killed / ◌ running — carries state by SHAPE,
    color via a `status-<status>` class so saturation stays reserved for state). Pure +
    deterministic; no on-disk format knowledge.
  - **`apps/web/src/App.tsx`:** selection LIFTED into shared state. Replaced the implicit
    `pickProject`/`pickRun`/`pickWorkflow` auto-selection with explicit
    `selectedProjectPath` / `selectedRunId` / `selectedWorkflowName` state (each `null` until
    the user picks; while null it falls back to the renamed `defaultProject`/`defaultRun`/
    `defaultWorkflow` dogfood picks). So the app opens on the SAME modal-rust → richest-run →
    plan-research picks as before, but ANY discovered project/run/workflow overrides them and
    the choice survives the Plan⟷Execution toggle. Plus the rail collapse state
    (`railCollapsed`, default **true**) + the active section (`railSection`).

- **Decision — rail IA (collapsed-by-default icon strip → expandable panel).** The rail is an
  **overlay** absolutely positioned over the fullscreen canvas; the canvas never reflows. The
  container is `pointer-events:none` so it never steals a pan from the canvas; only its
  interactive children (the strip + the expanded panel) opt back into pointer events.
  Collapsed = a **52px icon strip** (toggle `»`/`«`, projects `▤`, runs `≣`, settings `⚙`
  pinned to the strip bottom). **Measured collapsed footprint = 52px = 3.61% of a 1440
  viewport → canvas keeps 96.39%** (well over the >90% acceptance). The expanded panel is a
  264px column beside the strip (still an overlay). Clicking a section icon while collapsed
  opens that section AND expands (`openSection`); the panel is only mounted when expanded
  (collapsed = zero panel width, verified `panelMounted:false`).

- **Decision — shared-state lift (default-but-overridable, query-keyed re-scope).** The
  TanStack Query keys already key on `project?.slug` (runs, workflows) and the run ref (run
  model), so selecting a new project **re-scopes its runs + workflows automatically** — no
  manual invalidation. Picking a project clears the dependent run + workflow choice
  (`setSelectedRunId(null)` / `setSelectedWorkflowName(null)`) so the new project's defaults
  take over via the re-keyed queries (verified live: modal-rust 26 runs → capo **30 runs**,
  execution re-defaults to capo's richest `capo-workpad-execute`). Picking a run sets
  `selectedRunId` + switches the view to `'execution'` (today's view auto-picks the richest
  run; M4 lets you pick ANY). Picking a workflow sets `selectedWorkflowName` + switches to
  `'plan'`. The in-canvas `.wf-picker` `<select>` is **kept reachable** (still in the Plan
  run-header) AND the Plan-workflow list is **also** surfaced in the rail's Settings section,
  so the workflow context is reachable from both views.

- **Decision — collapse mechanic + chrome positioning.** Single `railCollapsed` boolean
  toggled by the `»`/`«` button (`aria-expanded`); 150–200ms eases on hover/active per the
  design system; mono identifiers; 4px-grid spacing; saturation reserved for state
  (status glyphs). The run-header was moved from `left:16px` → **`left:68px`** so it clears
  the 52px icon-rail even when collapsed (previously the workflow name was clipped by the
  rail), and given **`z-index:4`** (below the rail's `z-index:10`) so the opaque expanded
  panel cleanly covers it rather than colliding with it. The centered view-toggle (`z-index:5`)
  is unaffected. An earlier "nudge the header right when the panel is open" approach was
  REMOVED — it collided the long header into the centered toggle; letting the opaque panel
  overlay the header is the cleaner behavior users expect.

- **No new on-disk reads.** Uses ONLY the existing `GET /api/projects`,
  `GET /api/projects/:slug/runs`, `GET /api/projects/:slug/workflows` (+ the run snapshot
  `/api/runs/...` already used by Execution). No new endpoint, no adapter/contract/server
  change (verified `git diff --name-only` shows only `apps/web/src/App.tsx`,
  `apps/web/src/index.css`, and the new `apps/web/src/shell/`).

- **Privacy / Stance-4 (honored).** Grep over the M4-touched web source: no `node:fs` /
  `child_process` / `spawn` / `writeFile` / `require(`; the only `.claude` matches are
  user-facing copy strings (`no runs found in ~/.claude`); the only `dangerouslySetInnerHTML`
  match is a comment stating it is NOT used. All rail text is rendered as React text nodes.
  Read-only; nothing written into any `.claude` tree.

- **Test-count note (deliberate).** Per the M4 acceptance ("baseline 95 tests … no
  contract/adapter/server change expected, so the count should hold"), no new test file was
  added — the count stays **95/95**. The new `format.ts` helpers are pure and trivially
  testable; a focused `format.test.ts` is a reasonable low-risk follow-up if we want the count
  to grow, but it is intentionally omitted here to honor the stated invariant.

- **Evidence (toolchain green):** `tsc --noEmit` clean; `eslint .` clean; `vitest run`
  **95 passed** (6 files, unchanged); `vite build` ok (434 KB app JS + the pre-existing elk
  chunk-size warning from P1b).

- **UI smoke (Playwright, 1440×900, real `~/.claude`, dev servers on server:4321/web:5173,
  `ARGUS_EXPLAIN=0` to keep the shell smoke `claude`-free; 0 console errors across the full
  session):**
  - **(a) rail EXPANDED** — Projects panel lists all **3 discovered projects** (argus / capo /
    modal-rust) with the **decoded absolute path** as the label
    (`/Users/nicolas/devel/modal-rust`, etc.); modal-rust marked active. Runs panel lists all
    of modal-rust's runs **newest-first** with a status glyph + agentCount + human duration +
    relative time (●/◐/✕/◼ correctly differentiated; the 14-agent `modal-rust-plan-research`
    marked active). Settings panel shows the stub + the reachable Plan-workflow list.
    Screenshots: `.argus/screenshots/argus-m4-expanded-projects.png`,
    `argus-m4-expanded-runs.png`.
  - **(b) rail COLLAPSED (canvas >90%)** — the 14-agent run renders full-canvas behind the
    thin 52px icon strip; measured **canvas = 96.39%**. Screenshot:
    `.argus/screenshots/argus-m4-collapsed-14agent.png`.
  - **(c) a PICKED NON-DEFAULT run in Execution** — picked `modal-rust-app-cache` (a **1-agent
    killed** run, NOT the auto-selected richest run) from the rail → it renders in the
    Execution view (header `killed · 1 agent · 4 phases`; the single `AC-build` agent shows
    `interrupted` (killed-run progress agent), `tok 166k`, `tools 79`, `dur —`). Screenshot:
    `.argus/screenshots/argus-m4-picked-1agent-run.png`. **Also covers the 1-agent
    reads-well case.**
  - **Context-preservation verified at the wire/DOM level:** after picking the 1-agent run →
    toggle Plan (same project, `modal-rust-plan-research`) → toggle back to Execution → the
    view still shows the PICKED `modal-rust-app-cache` (NOT reset to the default 14-agent run).
    Project/run/workflow selection genuinely lives above the view.

- **Confidence: high.** Acceptance met and demonstrated on real modal-rust data at both the
  14-agent and 1-agent scales; the gate is green at the held 95 tests; the change is scoped to
  the web render layer with the file-first/read-only/Stance-4 invariants intact.

#### Verifier (2026-06-04) — verdict COMPLETE, capability_proven: true (independent)

- **Capability fully proven on REAL `~/.claude` data via live Playwright (1440×900, 0 console
  errors).** Collapsed rail = **52px → canvas 96.39%** (>90%; the panel is **unmounted / 0-width
  when collapsed**, not merely hidden). The **project switcher lists all 3 real projects**
  (argus / capo / modal-rust) with decoded absolute-path labels; switching to **capo** re-scoped
  live (cleared the picked run, reloaded capo's runs, re-defaulted to `capo-workpad-execute` /
  **129 agents**) — genuinely replaces the hardcoded `pickProject`. The **run picker lists 27
  modal-rust runs newest-first** (monotonic times verified) with status glyph / agentCount /
  duration / relative-time; **all 4 glyphs differentiated on real data**. Picking a non-default
  **1-agent killed** `modal-rust-app-cache` landed it in Execution. **Context preserved across
  Execution → pick → Plan → Execution** (still showed the picked run, NOT the default richest).
  Settings stub + a reachable workflow-picker present. (Verifier saw **27** modal-rust runs and
  **capo 129 agents** on the richest run — the implementer's self-report cited 26/30, a benign
  live-data delta as runs accrue.)
- **Toolchain gate independently re-run green:** `tsc` clean, `eslint` clean, `vitest` **95/95**
  (count held as claimed), `vite build` ok (the elk chunk-size warning is **pre-existing from
  P1b**, not introduced by M4).
- **Stance-4 / privacy / isolation verified:** `git diff` scope is ONLY `apps/web/src/`
  (`App.tsx`, `index.css`, new `shell/Rail.tsx` + `shell/format.ts`) + `README` + workpads — **no
  adapter / contract / server change, no new endpoints.** No `node:fs` / `child_process` / `spawn`
  / `writeFile` / `dangerouslySetInnerHTML` in M4 source. The rail consumes only `@argus/contract`
  wire types; `statusGlyph` covers all 4 `RunStatus` + a default; the format helpers tolerate
  `null` `durationMs` / `startTime`. Screenshots gitignored under `.argus/`. **Reads well
  fullscreen at BOTH the 14-agent** (4 lanes 7/2/4/1, partial-failure chip, `tok` em-dash) **and
  the 1-agent killed** (`AC-build` interrupted) scales; the run-header clears the rail at
  `left:68px`.
- **OPEN QUESTION / artifact-hygiene (low, pre-existing, NOT introduced by M4).** The P0 leak
  **persists**: `verify-p0-plan.png` is still tracked at the **REPO ROOT** (from the P0 commit
  `eb11e07`) instead of the gitignored `.argus/screenshots/`. Correctly **NOT touched by M4**
  (out of scope); content is benign Plan-view meta (no transcript/secret). **Recommend
  `git rm verify-p0-plan.png` before the next commit.**
- **VCS state (do NOT commit to main).** M4 work is **uncommitted and sits on the `main` branch**
  (not a feature branch) — confirmed: ` M App.tsx`, ` M index.css`, ` M README.md`, `?? shell/`.
  The implementer correctly left it uncommitted per the project git rule (no commit without
  explicit user confirmation). **Action for the user: branch off `main`, then commit** (the
  earlier phases live on `phase1-scaffold-and-research`); do NOT commit directly to `main`.
- **Test-coverage follow-up (low).** `format.ts` (`formatDuration` / `formatRelativeTime` /
  `statusGlyph`) are pure and currently **untested by a focused unit test** — `format.test.ts`
  was deliberately omitted to honor the stated 95-test-count invariant. Low-risk follow-up: add
  the coverage when the count is allowed to grow.
