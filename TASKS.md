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

**Next candidates (not yet started — for the morning):** finish the **live** gate (L3 SSE
stream, L4 no-jump re-layout, L5 finalize reconciliation, L6 robustness) and **inspect**
(I2 transcript, I3 run-structure/logs timeline, I4 describe-via-Claude). #9 generative
sub-UIs stays a forward/exploratory item. See the per-workpad `tasks.md` for the detail.

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
  run renders correctly fullscreen in **three views** (Plan AST DAG / Morph overlay /
  Execution) with Claude captions + a project/run rail; 118 tests; 0 console errors.
  Known residual cosmetic: Plan/Morph wide-short DAG leaves vertical empty space.
- [~] **live** — IN PROGRESS (overnight 2026-06-05). **M6 done across the stack:** L1
  running-run detection (`classifyRunLiveness` + `discoverRunningRunsReport`) + L2
  journal→model (`buildLiveModel`, labels recovered from the persisted script by
  start-order binding) in the adapter; a `/live` server endpoint + running runs merged
  into the run list; the web fetches + polls the live snapshot with a pulsing "● running"
  badge. Verified end-to-end (curl + a frozen-fixture UI screenshot). On-disk live
  behavior empirically locked (`workpads/live/knowledge.md` F1–F5: the finalized json is
  written ONCE at finalize; the journal is started/result-only). **Remaining for the gate:**
  L3 SSE/chokidar delta stream (currently a poll), L4 no-jump re-layout, L5 agentId-keyed
  finalize reconciliation, L6 robustness.
- [~] **inspect** — IN PROGRESS (overnight 2026-06-05). **I1 done:** clicking any node
  (execution agent or plan node) opens a right-hand detail panel (state/model/tokens/
  timing/tools, prompt+result previews, and the full PX caption with a baseline/✨llm
  provenance chip + pattern name) in all three views. **Remaining:** I2 transcript (note
  F5 — workflow-agent transcripts are unreliable on disk), I3 run-structure nav + logs[]
  narrator timeline, I4 describe-a-workflow via the Claude API.
- [ ] **interact** *(exploratory)* — Jump into a session; embedded agent (runs in
  the project dir) to review & modify a workflow; evaluate ACP / remote-control /
  headless SDK here. Gate: a decision-ready design matrix + spike plan; does not
  change the proven read path.

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
