# prototype — tasks

**Objective.** Smallest end-to-end app that renders **one finished run** beautifully
on a fullscreen canvas. **Gate:** a real `modal-rust` run renders correctly,
observed in a browser; reads well at 1 agent and at the 14-agent run.

> Blocked until the architecture gate passes.

## Tasks (draft)

- [x] **M0 — Scaffold the app** — DONE 2026-06-04. 4-package npm-workspaces monorepo
  (`packages/{contract,adapter}`, `apps/{server,web}`); React 19 + Vite 7 +
  `@xyflow/react` v12; Node server binds 127.0.0.1 only + Host/Origin allowlist +
  per-launch token (`/health` open, `/api`+`/stream` token-gated). `tsc --noEmit`,
  eslint, vitest (4 tests), and `vite build` all green; 0 audit vulns; empty app
  loads fullscreen (evidence: `.argus/screenshots/argus-m0-empty-shell.png`).
- [x] **M1 — Adapter v0 + FS port** — DONE 2026-06-04 (38 tests green over all 5 real
  fixtures + a port contract test; tsc/lint/build clean). `packages/adapter/src/raw.ts`
  (zod schemas + projection helpers) + `parseFinalizedRun` (`index.ts`) + `loadRun`
  through the port; `apps/server/src/fs-port.ts` (read-only `NodeFileSystemPort`).
  Implement `parseFinalizedRun(raw, ctx): RunModel`
  in `packages/adapter` per `boundaries.md` §2–§3, plus a `NodeFileSystemPort`
  (`apps/server`) + a port contract test (a `loadRun` that reads one real `wf_*.json`
  through the port). Use zod `.passthrough()/.catch()`; **emit-allowlisted** (project
  fields explicitly, never spread parsed JSON). Concrete facts from `.argus/fixtures/`
  to honor (verified 2026-06-04):
  - `args` is a JSON **string** OR `null` → parse defensively, raw-string fallback.
  - failed/killed runs carry a top-level **`error` STRING** containing a
    `/$bunfs/.../cli.js` stack → split into `{message, internalDetail}` (stack hidden
    in `internalDetail`, never raw). completed runs have no `error`.
  - `killed-9agents` has `state:'progress'` agents → render `interrupted` (static),
    plus `logs[]` lines `parallel[N] failed: …` and error `Workflow aborted`.
  - `completed-14agents` has a HIDDEN `parallel[0] failed` log line → set the
    run-level `partialFailure` badge with the verbatim line, and assert **zero**
    mis-attributed agent chips (no agent matches that label/agentId).
  - previews are capped at raw len **401** (the `truncated` heuristic); a `resultPreview`
    of len 0 is NOT truncated. Hard-cap emitted preview text; full `result` stays lazy
    (not inlined into `RunModel`).
  - phase join: `workflow_phase.index` (1-based) enriched by `phases[]` (0-indexed) via
    `index − 1`; an unresolvable `phaseIndex` → drop-with-warning, **no** phantom phase
    0 and **no** bogus `0→1` edge. Synthesized `phase_i→phase_i+1` edges only.
  - Acceptance: `vitest` over ALL 5 fixtures (completed-14, completed-3, failed-1,
    killed-9, resumed-13) + an unknown-field and a missing-field case; assert the
    14-agent run yields a run-level partial-failure and zero mis-attributed agents;
    add `zod` to `packages/adapter`; `tsc`/`lint`/`test`/`build` all green.
- [x] **M2 — Discovery** — DONE 2026-06-04 (54 tests green: 38 M1 + 16 M2;
  tsc/lint/build clean; dogfood vs real `~/.claude` → 3 projects, modal-rust 20 runs).
  `packages/adapter/src/discovery.ts` (`discoverProjects`/`discoverRuns`/
  `discoverWorkflowMetas`/`parseWorkflowMeta`, all node:fs-free via the injected
  port) replaces the two M1 stubs; `WorkflowMeta` added to `packages/contract`. Key
  findings (scriptPath two-shape split + per-slug recovered-sibling fallback;
  deriveSlug pinned/verified; header-only discovery) recorded in `knowledge.md`.
  Implement `discoverProjects(port, claudeHome)` +
  `discoverRuns(port, project)` (replace the M1 stubs), per `boundaries.md` §4 — all
  disk access THROUGH the `FileSystemPort` (the adapter stays node:fs-free). Walk
  `~/.claude/projects/<slug>/<session>/workflows/wf_*.json`; **recover the
  authoritative `projectPath` from each run's `scriptPath`** (strip the trailing
  `.claude/workflows/<file>`) and key/dedup `RunRef`/`ProjectRef` by abs path (when
  multiple cwds share one slug dir → multiple switcher entries). `discoverRuns` reads
  **header fields only** (workflowName/status/agentCount/durationMs/startTime/summary
  + `partialFailure` from `logs[]`) — do NOT walk `workflowProgress`/transcripts.
  A bogus/missing path → empty-with-reason, never a crash. Also parse
  `<project>/.claude/workflows/*.js` `meta` for the static workflow listing.
  Acceptance: deterministic `deriveSlug` tests incl. `/Users/nicolas/.config/ghostty`
  → `-Users-nicolas--config-ghostty`; `discoverRuns` over a **fake-port synthetic
  tree** (built from the `.argus/fixtures` files) returns the right status mix and
  abs-path keys; a bogus-path test returns empty-with-reason; `tsc`/`lint`/`test`/
  `build` green.
- [x] **M3 — Render one finished run** — DONE 2026-06-04. The real 14-agent
  `modal-rust-plan-research` run renders as crisp vertical phase-lanes (7/2/4/1) with
  the run-level `partial failure` chip (hidden `parallel[0] failed`) and zero agent
  mis-attribution; `tok —` for the 0-token agent. Server snapshot API + secure dev
  token-proxy + TanStack Query data layer + `@xyflow/react` lanes/AgentCard. tsc/lint/
  test(54)/build green; **0 console errors**. Evidence:
  `.argus/screenshots/argus-m3-14agent-run.png`. (Workflow built the pieces; the main
  loop assembled `App.tsx`/`main.tsx`/CSS + fixed the `scripts/dev.mjs` lint.)
  Per `boundaries.md`
  §4–§7. Three parts:
  1. **Server API** (`apps/server`): add token-gated, path-escape-guarded routes using
     `NodeFileSystemPort` + the M2 discovery + M1 `loadRun`: `GET /api/projects`,
     `GET /api/projects/:slug/runs` (RunSummary[]), `GET /api/runs/:slug/:session/:runId`
     (the RunModel snapshot). Keep the M0 security (127.0.0.1 bind, Host/Origin
     allowlist, per-launch token, path-escape `resolve()`-inside-claudeHome guard).
  2. **Dev token wiring** (no insecure shortcuts): use a shared `ARGUS_TOKEN` env for
     both apps in dev and have the **Vite proxy inject `Authorization: Bearer
     $ARGUS_TOKEN`** (via `proxy.configure`/`headers`) so the browser stays token-free
     and the server's token check still passes server-side. Do NOT disable the token
     or expose it to client JS. (Production same-origin token handoff is a later note.)
  3. **Web render** (`apps/web`): a TanStack Query data layer fetches the run list and
     auto-selects the 14-agent `modal-rust-plan-research` run (fallback: first run);
     map `RunModel` → `@xyflow/react` as **fullscreen vertical phase-lanes** (phases
     stacked top→down by `index`; agents wrapped in a grid inside their lane) behind a
     **swappable `layout` module** (deterministic hand-rolled lane layout default,
     elk lazy fallback — M3 acceptance is engine-agnostic); custom **AgentCard** node
     (state dot + mono label + model badge + metric pills duration/tokens/tools;
     `tokens=0`→`—`); the single synthesized `phase_i→phase_i+1` spine edge only (no
     agent edges); `MiniMap`/`Controls`/dotted `Background`; `colorMode="dark"`;
     pan/zoom/fitView. Render text as text nodes only (no `dangerouslySetInnerHTML`).
  - **Acceptance:** with `dev:server` + `dev:web` running, the web renders the real
    14-agent run as crisp vertical phase-lanes (4 lanes, 7/2/4/1) AND a 1-agent run
    renders clean; `tsc`/`lint`/`build` green; a Playwright fullscreen screenshot is
    captured. (Deep visual polish + the gate sign-off are M5 — M3 just renders correctly.)
- [ ] **M4 — Shell.** Collapsible minimal left toolbar (switch project / pick run);
  canvas is the focus.
- [ ] **M5 — UI smoke + polish.** Render the 14-agent `modal-rust-plan-research`
  run; screenshot/Playwright; pass the UI/UX review lens (reads at a glance,
  legible, beautiful defaults). Update README "Try it".

## knowledge

Evidence (screenshots, the rendered run, test output) and decisions land in
`knowledge.md`.
