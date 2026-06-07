# Project Task Queue

**You edit this file.** It tells agents which workpad to load for `/next` and
similar commands.

Read top to bottom. The **first unchecked** item is the active workpad unless Notes
override it. Check items off when a phase is finished, not when pausing mid-phase.

## Active Now

**prototype** gate PASSED 2026-06-04; **live** + **inspect** now in progress. Everything
is on GitHub (`github.com/nicolaslara/argus`, branch `main`); 144 tests green.

**Overnight order (2026-06-04 night → 2026-06-05): ALL COMPLETE.** U1 → M4 → P2 → M5 →
inspect I1 → live M6 — all shipped. PLUS PX-fit (#14): the detail panel is the caption
expand surface (baseline/✨llm provenance + pattern chip), and the `claude -p` prompt
(px-v2) now yields role-focused captions + structural pattern names.

**UX-REVIEW PASS (2026-06-05, from the user's review) — DONE.** Grounded in two research
workflows (`workpads/research/viz-best-practices.md` + a code change-map). Shipped:
- **R1** human-readable prompt/result (key→value/prose by default, raw-JSON toggle, lazy
  FULL result from the journal via a new `/result` endpoint).
- **R2** unified workflow↔run↔project selection (Plan/Morph/Execution always the same
  workflow; a live run is one click).
- **R3** fan-out/merge are tiny junction markers (●/◌ + hover), not boxes.
- **R5** decisions: correct true/false labels (de-negation fix) + a visible terminal for
  break/return arms + a labeled continuation; green/red arrowed branch edges.
- **R7** elk PHASE-PARTITIONING (disjoint lane bands → the p4 overlap is gone) + research
  spacing/routing.
- **R8/R9** run-state legibility: a RUNNING run auto-opens in **Morph** showing done /
  running / **upcoming**; a failed/interrupted step POPS (red/amber border); Morph is now
  the primary state view (Execution = instance detail).
- **#9 generative sub-UIs** — DONE: Claude generates a constrained, validated `PanelSpec`
  (fixed section grammar) rendered by trusted components; opt-in `✨ generate` per result.
- R4 (distinct fan-out) + R6 (loop edges) adequately addressed by R3 markers + the elk
  cycle-breaking/arrowheads. ~160 tests green; each fix screenshot-validated.

**Still "what's left" (continuation):** the **live** gate (L3 real SSE/chokidar stream,
L4 no-jump re-layout, L5 finalize reconciliation, L6 robustness) and **inspect** (I2
transcript, I4 describe-via-Claude). See the per-workpad `tasks.md`.

## Workpad Queue

- [x] **research** — DONE 2026-06-04. Synthesis in `workpads/research/synthesis.md`;
  decisions confirmed (web+local Node/TS backend; React 19 + React Flow; read-only v1
  w/ reserved interact seam; prototype-first then live, on real captured data). Client
  availability, connection strategy, the hardened data contract, the graph-viz library
  + UI direction, and the TS stack are all locked.
- [x] **architecture** — DONE 2026-06-04. `workpads/architecture/boundaries.md`
  ratifies the adapter, run model, server↔client API, live path, render/layout
  pipeline, shell/IA, failure modes, and format-version policy — derived from the
  adversarially-reviewed synthesis.
- [x] **prototype** — GATE PASSED 2026-06-04 (M0–M5 + P0/P1/P2/PX/U1). A real modal-rust
  run renders correctly fullscreen in **two views** (Plan AST DAG / Run overlay) with
  Claude captions + a project/run rail; 118 tests; 0 console errors. The old Progress +
  Execution tabs were MERGED into the Run view: the aggregate↔instance join is now an
  in-place expand (a click), not a tab-switch. Known residual cosmetic: Plan/Run wide-short
  DAG leaves vertical empty space.
- [x] **live** — GATE MET 2026-06-05. M6 (L1 detection + L2 journal→model), L3 SSE push
  stream (journal-watch → `changed`, heartbeat, clean reconnect), L4 a running run renders
  on Morph as done/running/**upcoming**, L5 finalize reconciliation (de-dup + agentId/start-
  order), L6 a journal-replay test (no lost/duplicated nodes → reconciles to finalized).
  On-disk live behavior locked (`workpads/live/knowledge.md` F1–F5). Residual future polish:
  incremental SSE deltas + a no-jump finalize swap.
- [x] **inspect** — GATE MET 2026-06-05. I1 node detail panel (both Plan and Run views); I3
  run-overview with the narrator `log()` timeline; I4 "describe this run" via Claude; per-
  node results are full + readable + generatively rendered (R1 + #9). I2 (agent transcript)
  is BLOCKED by data reality — workflow-agent `agent-*.jsonl` transcripts are not reliably
  persisted (F5: 0/14 on the 14-agent run); deferred until they're captured live.
- [x] **interact** *(exploratory)* — GATE MET 2026-06-05. `workpads/interact/design.md` is
  a decision-ready design matrix (6 candidates: headless CLI / Agent SDK / ACP / `claude
  --resume` / IDE deep-link / Remote Control) + a recommendation (jump-in via copy-a-
  `claude --resume <sessionId>` now; embedded edit via the Agent SDK `canUseTool` diff
  gate) + a default-OFF spike (X4) + a 5-layer write-safety model — explicitly NOT changing
  the read path (a separate, flagged server seam). No build authorized; design artifact only.
- [ ] **narrative** *(feature)* — PLAN SYNTHESIZED 2026-06-07 (`explore-session-narrative` /
  `wf_4e4d6d47-f83`: research → design → adversarial review → synthesis, grounded in the real
  ~67 MB session transcript). A third top-level **"Story"** view: one session as a timeline of
  topic blocks you can **watch** or **click into**, with workflow runs / git commits / file
  changes in context. Roadmap in `workpads/narrative/tasks.md`: **M0** (adapter `transcript.ts` +
  real-prompt segmentation, zero LLM) → **M0.5** (secret/home-path redactor, HARD GATE) → **M1**
  (Story toggle + watch + click-in) = the shippable PROOF; then STOP for user judgment. M2 (git) /
  M3 (run-correlation) / M4 (opt-in local-LLM summaries) deferred-additive; M5 cut. **GATE before
  building:** user answers the 5 open questions in the workpad. Read-only; conversation summarized
  only by the user's own local `claude`, never off-machine.

## Notes

- Source-of-truth product vision lives in `project.md`. The four design stances:
  **(1)** file-first / read-only early — the on-disk journals are the interface, no
  client API needed for v1; **(2)** working e2e from the first milestone — one
  capability per step, on real data; **(3)** UI/design quality is a first-class
  invariant; **(4)** the on-disk schema is observed, versioned, and untrusted —
  isolated behind one adapter.
- **Dogfood on `../modal-rust`** — it has 16 real runs (the 14-agent
  `modal-rust-plan-research` is the stress case for layout). Our own research run
  under `-Users-nicolas-devel-argus/` becomes argus's first dataset.
- **Privacy:** argus reads the user's own `~/.claude` tree, which can contain
  secrets a workflow touched. Never copy run/transcript content off-machine; never
  write into another project's `.claude` in early phases.
- Web-vs-desktop, the frontend framework, and whether editing/driving workflows is
  a real goal are **user-sensitive** — the research synthesis surfaces them as
  explicit questions rather than guessing (defaults noted in `project.md`).
- Research and architecture may overlap only when task boundaries are independent
  and findings are recorded before the dependent architecture decision is made.

- **AFK AUTONOMOUS RUN (2026-06-04 night → 2026-06-05 morning).** The user is asleep and
  authorized iterating through the remaining tasks **without waiting for feedback**:
  proceed step by step, **commit + push between tasks**, **validate visual work with
  Playwright screenshots** (saved under gitignored `.argus/screenshots/`), and keep going
  until the user returns in the morning — then **summarize everything overnight for
  review**. This **overrides the default "confirm before commit"** for this run (commit +
  push freely). Still: never log/commit secrets; `.argus/` stays gitignored; read-only
  toward other projects' `.claude` trees.
  - **The loop:** launch the next task via `.claude/workflows/implement.js` (or a design
    pass where analysis is needed) → on completion **verify the gate (tsc/lint/test/build)
    + screenshot visual work + fix any gaps from the main loop** → commit + push → launch
    the next. Workflows often finalize-flake on heavy tasks but **leave the work on disk**
    (esp. they ship components without CSS/wiring) — assemble/fix from the main loop, then
    verify (see the `workflow-authoring-gotchas` memory).
  - **Overnight order:** U1 (unify Plan/Execution visual language) → M4 (left toolbar:
    project + run picker) → P2 (execution overlay) → M5 (polish + prototype gate + README)
    → inspect M9 (node detail) → live M6 (running detection + journal tail).
  - **A fresh context (after compaction) should:** read this note + `git log` (recent
    commits) + `workpads/prototype/{tasks,knowledge}.md` + `workpads/architecture/
    plan-view-design.md`, find the first unchecked task in the order above, and continue.
