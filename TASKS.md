# Project Task Queue

**You edit this file.** It tells agents which workpad to load for `/next` and
similar commands.

Read top to bottom. The **first unchecked** item is the active workpad unless Notes
override it. Check items off when a phase is finished, not when pausing mid-phase.

## Active Now

**architecture** is active (2026-06-04). The **research gate passed**: the synthesis
is in `workpads/research/synthesis.md` (Verified Facts → Locked Decisions → Milestone
Plan M0–M11 → User Questions → Residual Risks), produced by `argus-plan-research` and
hardened by adversarial review. The four user-facing decisions are **confirmed**:

1. **Web app + local Node/TS backend** for v1 (Tauri deferred as a cheap sidecar swap).
2. **React 19 + `@xyflow/react`** (React Flow), hand-rolled phase-lane layout default
   (elkjs lazy fallback).
3. **Read-only v1, reserve the interact seam** (no write/drive built now; architect
   `FileSystemPort` + a future control channel so it's cheap to add).
4. **Prototype-first (M0–M5), then live (M6–M8) gated on a real captured run.** Binding
   caveat: **use REAL captured data from the start** (this project + `../modal-rust`)
   so rendering is proven on real, messy runs — fixtures live under `.argus/fixtures/`.

Next: the architecture workpad ratifies `boundaries.md` (adapter / run model / API /
render / shell / failure modes) from the synthesis, then prototype M0 scaffolds the
4-package monorepo. Consider `argus-refine-plan architecture` to harden the plan and
`argus-implement` to execute milestones.

## Workpad Queue

- [x] **research** — DONE 2026-06-04. Synthesis in `workpads/research/synthesis.md`;
  decisions confirmed (web+local Node/TS backend; React 19 + React Flow; read-only v1
  w/ reserved interact seam; prototype-first then live, on real captured data). Client
  availability, connection strategy, the hardened data contract, the graph-viz library
  + UI direction, and the TS stack are all locked.
- [ ] **architecture** — Ratify the adapter contract, the normalized run model, the
  server↔client API (snapshot + incremental), the render/layout pipeline, the
  shell/IA, and the failure modes, in `workpads/architecture/boundaries.md`. Gate:
  boundaries doc ratified.
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
