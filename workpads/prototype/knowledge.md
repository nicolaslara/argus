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
- **Visual note (deferred to M5 polish, not a P0 blocker):** the agent-free Plan lanes
  inherit the M3 lane height (one card-row reserved even with 0 agents), so each lane has
  generous empty space below its subtitle. It reads cleanly fullscreen; a future
  plan-specific lane-height (header + subtitle only) is a nice-to-have.
- **Evidence (toolchain green):** `tsc --noEmit` clean; `eslint .` clean; `vitest run`
  **57 passed** (4 files: 54 prior + 3 P0 route tests); `vite build` ok (415.05 KB JS).
