# Project Task Queue

**You edit this file.** It tells agents which workpad to load for `/next` and
similar commands.

Read top to bottom. The **first unchecked** item is the active workpad unless Notes
override it. Check items off when a phase is finished, not when pausing mid-phase.

## Active Now

**prototype** is active (2026-06-04). The **research and architecture gates have
passed**: the research synthesis is in `workpads/research/synthesis.md` and the
ratified contracts are in `workpads/architecture/boundaries.md` (adapter / run model
/ API / live path / render-layout / shell / failure modes / format-version). The four
user-facing decisions are confirmed and recorded in `project.md`.

Next: prototype milestones **M0–M5** (gate at M5 — one finished run renders beautifully
fullscreen on real data). M0 scaffolds the 4-package monorepo (`packages/adapter`,
`packages/contract`, `apps/server`, `apps/web`) per `boundaries.md` §1 + synthesis
§2.8. Build against the real fixtures in `.argus/fixtures/` from M1 on. Use
`argus-implement prototype` to execute milestones with adversarial verification.

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
