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
- [ ] **M2 — Discovery.** Given a local project path, derive the slug, list its
  sessions + runs (name, status, agentCount, duration, time).
- [ ] **M3 — Render one run.** Run model → fullscreen phase/agent graph (the chosen
  graph lib + layout). Phases group agents; nodes show label/state/model; the graph
  pans/zooms.
- [ ] **M4 — Shell.** Collapsible minimal left toolbar (switch project / pick run);
  canvas is the focus.
- [ ] **M5 — UI smoke + polish.** Render the 14-agent `modal-rust-plan-research`
  run; screenshot/Playwright; pass the UI/UX review lens (reads at a glance,
  legible, beautiful defaults). Update README "Try it".

## knowledge

Evidence (screenshots, the rendered run, test output) and decisions land in
`knowledge.md`.
