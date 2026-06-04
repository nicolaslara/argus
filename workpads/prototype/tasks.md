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

## Plan view (P-series — design: `../architecture/plan-view-design.md`)

User chose (2026-06-04) to build the **Plan view** next (the "what it's supposed to
do" DAG), starting run-free. Key facts from the design doc: `acorn` (in lockfile)
wrap-parses the body as `async function __wf(agent,parallel,…){…}` (all 9 real scripts
parse); the `agent()` `label:` opt **==** the journal's `workflow_agent.label` (the
overlay join key); `PlanModel` is a **sibling** of `RunModel` (RunModel UNCHANGED); the
parser lives in `packages/adapter` (`plan.ts`); our M3 vertical-lane render is the
degenerate execution case. Defaults adopted (overridable): plan source = both behind
one parser; tournament/quarantine vocab = stub until a real run exhibits them; loops =
folded in plan / unrolled on overlay; unbounded fan-out = `1..N` chip + sourceExpr on
hover.

- [x] **P0 — Plan view, meta-only (run-free).** DONE 2026-06-04 (57 tests green: 54 +
  3 P0 route tests; tsc/eslint/build clean; 0 console errors). Server
  `handleProjectWorkflows` → `GET /api/projects/:slug/workflows` → `WorkflowMeta[]`
  (token-gated + path-guarded, M3 pattern; reuses `discoverWorkflowMetas` — no new
  parser/AST/acorn); web `fetchProjectWorkflows` + pure `plan-mapping.ts`
  (`planMetaToGraph` → vertical lanes + spine only, no agents/no extra edges) +
  `PhaseLane` optional `subtitle`/`hideAgentCount` (gated → M3 render byte-unchanged) +
  `App.tsx` Plan⟷Execution toggle. `packages/adapter`, `packages/contract`,
  `apps/web/src/mapping.ts`, `RunModel` all UNCHANGED. Live: modal-rust → **10
  workflows** incl. `plan-research`; Plan view renders the 4 declared lanes
  (Research/Design/Review/Synthesize) + subtitles fullscreen; toggle returns the M3
  14-agent run unchanged. The Plan view also ships a **workflow `<select>` picker**
  (`App.tsx` `selectedWorkflow` state + `.wf-picker` CSS, commit `eb11e07`) — lists all
  named workflows and renders the chosen one (in-scope per "lists a project's named
  workflows and renders the selected one"; still run-free/meta-only/no-AST). Screenshots
  `.argus/screenshots/argus-p0-plan-research-plan.png`
  + `argus-p0-execution-toggle-back.png`. Details in `knowledge.md` (P0 section).
  COMMITTED (verifier-confirmed 2026-06-04) on branch `phase1-scaffold-and-research`:
  `baf8769` (run-free Plan view + toggle) + `eb11e07` (workflow picker); working tree clean.
  Deliver the **review-the-workflow**
  mode: a run-free plan rendered from a workflow's declared `meta.phases` (already
  parsed via `discoverWorkflowMetas`/`parseWorkflowMeta`, shipped in M2 — no new parser).
  - Server: expose the existing `discoverWorkflowMetas` as `GET /api/projects/:slug/
    workflows` → `WorkflowMeta[]` (token-gated + path-guarded, same pattern as the M3
    routes).
  - Web: a **Plan view** that lists a project's named workflows and renders the selected
    one's declared phases as ordered vertical lanes + a **subtitle** slot (from
    `meta.phases[].detail`); a minimal **Plan ⟷ Execution view toggle** (this view IS
    review-the-workflow mode). Reuse the M3 dark canvas + `PhaseLane`; NO AST, NO agents,
    NO edges beyond the phase spine, NO overlay, NO RunModel change.
  - Acceptance: pick modal-rust → list its workflows → render `plan-research`'s declared
    phases (Research/Design/Review/Synthesize) as a run-free plan with subtitles, reads
    well fullscreen; toggling to Execution still shows the M3 run; `tsc`/`lint`/`test`/
    `build` green; Playwright screenshot.
- [x] **P1a — AST plan parser** — DONE 2026-06-04. `parsePlan(source)` in
  `packages/adapter/src/plan.ts` (1170 LOC) + `plan.test.ts`; `acorn` added; `PlanModel`
  contract (nodes agent/process/decision/loop/output/unparsed; edges flow/fanout/merge/
  optional/loop-back; containers; lanes; multiplicity). `GET /api/projects/:slug/
  workflows/:file/plan` endpoint + web `api` client. 83 tests green. **Verified on real
  scripts:** plan-research → fan-out ×7/×2/×4 + merges (multiplicity read from the static
  `RESEARCH`/`LENSES` arrays); refine-plan → loop node + loop-back edge + decision;
  implement → linear chain + decision + optional early-exit. Parser is excellent.
- [x] **P1b — Plan-DAG web render** — DONE 2026-06-04. The PlanModel renders as the
  article's vocabulary, **horizontal** (elk direction RIGHT): fan-out/merge process
  nodes, agent cards with `${…}` template holes + `typed` chips + subtitles, `×N`
  multiplicity chips + a stacked-card silhouette for fanned templates, **decision
  diamonds**, dashed **loop containers** (`↻ loop · max N`), output pills. Verified on
  real scripts (Playwright, 0 console errors): plan-research → fan-out ×7/×2/×4 + merges;
  refine-plan → loop container + decision + fan-out ×4. Built by the workflow; the main
  loop fixed the render (added all plan-node CSS — components shipped without it; elk
  DOWN→RIGHT; plan handles Top/Bottom→Left/Right). Screenshots in `.argus/screenshots/`
  (argus-p1b-plan-research-ast2.png, argus-p1b-refine-plan-loop.png).
  Consume the `PlanModel` over the `/plan` endpoint
  and render the richer vocabulary on the canvas: node types (agent/process/decision-
  diamond/loop-container/output), edge types (flow/fanout/merge/optional-dashed/
  loop-back), **multiplicity badge** (`×N` / `1..N`), phase/loop containers, via **elkjs**
  layered layout (execution keeps the hand-rolled horizontal lanes). Wire it as the Plan
  view's AST mode (the meta-only P0 plan stays the run-free fallback). Acceptance:
  plan-research renders its fan-out, refine-plan its loop, observed in a browser
  (Playwright); `tsc`/`lint`/`build` green. Design doc §3.
- [ ] **P2 — Execution overlay.** `buildOverlay` (label-prefix + phaseIndex 3-way bind);
  per-run plan from the persisted script; Plan⟷Execution morph; status-painted shared
  layout; folded↔unrolled loop mode switch. Design doc §6.
- [ ] **PX — Explanation layer (default-on, `claude -p`, cached).** Per-node LLM
  captions/simplifications grounded in (node identity + the artifact it represents);
  annotation-only on topology; content-addressed cache (`hash(data)`, bust-and-
  regenerate) under `.argus/cache/`; background + parallel; feeds subtitles across views.
  Depends on P0; runs in parallel. Design doc §10.

## knowledge

Evidence (screenshots, the rendered run, test output) and decisions land in
`knowledge.md`.
