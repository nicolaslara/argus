# Project Task Queue

**You edit this file.** It tells agents which workpad to load for `/next` and
similar commands.

Read top to bottom. The **first unchecked** item is the active workpad unless Notes
override it. Check items off when a phase is finished, not when pausing mid-phase.

## Active Now

**prototype** is active (2026-06-04). Research + architecture gates passed. **Shipped
& on GitHub (`github.com/nicolaslara/argus`, branch `main`):** M0 scaffold, M1 adapter,
M2 discovery, M3 execution render (horizontal lanes), P0 meta-plan, P1a AST parser, P1b
plan-DAG render (article vocabulary, horizontal, elk), PX explanation layer (`claude -p`
captions, cached). Both **Plan** and **Execution** views render real data with a toggle
+ workflow picker; 95 tests green.

**Remaining (this is the overnight order — see the AFK note below):** U1 (unify the
Plan/Execution visual language — user-requested), M4 (left toolbar: project + run
picker), P2 (execution overlay — plan⟷run morph), M5 (UI polish + prototype gate +
README "Try it"), then inspect M9 (node detail) and live M6 (running detection +
journal tail) as budget allows. Plus PX-fit (better/expandable captions) and #9
(generative sub-UIs) tracked in `workpads/prototype/tasks.md`.

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
- [ ] **prototype** — Smallest e2e: pick a local project → list its runs → render
  **one finished run** as a fullscreen phase/agent graph from `wf_*.json`. Gate: a
  real `modal-rust` run renders correctly, observed in a browser.
- [ ] **live** — File-watching → live progress as a workflow runs (`journal.jsonl`
  + `agent-*.jsonl` tail → incremental graph updates). Gate: a live (or replayed)
  run animates correctly to completion.
- [ ] **inspect** — Drill into a node (prompt, result, transcript, tokens/tools/
  timing); navigate phase/pipeline structure; "describe this workflow" via Claude.
  Gate: any agent node opens a readable detail view.
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
