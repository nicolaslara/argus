# research — tasks

**Objective.** Ground the argus build plan in verified facts and lock the
foundational decisions so the architecture workpad can proceed with confidence.

**Gate.** A synthesis (`synthesis.md` here, or a synthesis section in
`knowledge.md`) with locked decisions, a milestone plan, and explicit user
questions. Primary tool: `.claude/workflows/plan-research.js`.

Separate **proven facts** (verified by a primary doc or by inspecting a real
on-disk run) from **assumptions** and **recommendations**. Date observations.

## Dimensions / tasks

> **GATE PASSED 2026-06-04.** Synthesis written to [`synthesis.md`](./synthesis.md)
> via `argus-plan-research` (run `wf_56991fcb-71b`); the 4 user-facing decisions are
> confirmed and recorded in [`knowledge.md`](./knowledge.md). R3 was resolved by
> direct on-disk inspection rather than a research agent (higher confidence).

- [x] **R1 — Claude Code client availability.** Is the workflow-era Claude Code
  client source available, leaked, or only documented? Establish whether argus
  needs *any* client code/API for v1, or whether the on-disk contract is fully
  sufficient (lean: sufficient — bound and confirm). Note licensing/ethics: we will
  not depend on leaked proprietary source; we build on observable artifacts +
  official docs/SDKs.
  - *Acceptance:* a clear yes/no on availability with sources; a stated dependency
    boundary for v1.

- [x] **R2 — Connection strategy per phase.** Compare file-watch (read journals) vs
  ACP (Agent Client Protocol) vs "remote control" vs the headless Claude Agent SDK.
  Map each to the phase that would justify it (live = file-watch; inspect =
  file-watch + maybe Claude API to describe; interact = ACP / SDK / remote).
  Establish why file-first is correct for v1–v5 and what specifically interact
  needs.
  - *Acceptance:* a per-phase recommendation table with the mechanism, what it
    enables, its cost/complexity, and the trigger to adopt it.

- [x] **R3 — Data contract, hardened + versioned.** Confirm and extend the observed
  contract (seeded in `knowledge.md`): the `workflow_agent.state` enum; how nested
  `pipeline()` / `parallel()` / `workflow()` structure surfaces in
  `workflowProgress[]` (phase grouping + timing vs explicit edges); the live
  `journal.jsonl` event schema beyond `started`; how a running run is detected
  before `wf_*.json` exists; token/cost fields; behavior on `failed`/`killed` runs.
  Inspect multiple real runs (incl. the 9–14 agent ones and the `killed`/`failed`
  ones) as evidence.
  - *Acceptance:* a versioned schema doc with field-by-field evidence (file path +
    observed value) and the explicit unknowns.

- [x] **R4 — Graph-visualization library + UI direction.** The decisive comparison
  for a phase-grouped agent graph (1–14+ nodes, live updates, rich node cards,
  fullscreen pan/zoom, beautiful defaults): candidates include React Flow / Svelte
  Flow, Reaflow, Cytoscape.js, Sigma.js, vis-network, G6, and D3 + a layout engine
  (elkjs / dagre / d3-hierarchy). Evaluate against: layout quality for grouped
  DAGs, custom node rendering, performance, live-update ergonomics, aesthetics,
  community/maintenance, and license. Include a UI/UX direction: the
  fullscreen-canvas + collapsible-minimal-toolbar shell, how a phase/agent run
  should *read at a glance*, state/typography/motion. (First-class deliverable.)
  - *Acceptance:* one recommended library + layout engine with the comparison that
    decided it, plus a concrete UI direction (and ideally a sketch/wireframe of the
    run view + node card).

- [x] **R5 — TypeScript stack + shape.** Frontend framework (React vs Svelte vs
  Solid, tied to R4's library), backend/runtime (Node vs Bun) for filesystem access
  + watch + API, bundler/dev server (Vite), test runner, and **web app + local
  backend vs desktop (Tauri)** for v1. Recommend a minimal, coherent stack that
  preserves the desktop/remote swap.
  - *Acceptance:* a recommended stack with rationale and the repo layout it implies
    (apps/packages or src layout).

- [x] **R6 — Prior art.** How do existing tools display agent/DAG runs (LangSmith /
  trace viewers, CI pipeline DAGs e.g. GitHub Actions / Buildkite, node-graph
  editors e.g. n8n / ComfyUI / Blender nodes, observability waterfalls)? Extract
  what reads well and what to avoid for argus's specific shape.
  - *Acceptance:* a short distilled list of borrowed patterns + anti-patterns.

- [x] **R7 — Synthesis (the gate).** Consolidate R1–R6 into locked decisions, a
  milestone plan (M0…), residual risks, and explicit user questions (web-vs-desktop,
  framework, read-only-vs-editing). Write `synthesis.md`.
  - *Acceptance:* a single authoritative doc that the architecture workpad can build
    from; user questions surfaced, not guessed.

## Notes

- The strongest evidence for the undocumented format is **direct inspection of real
  runs** under `~/.claude/projects/-Users-nicolas-devel-modal-rust/` (16 runs,
  incl. `completed`/`failed`/`killed`, 1–14 agents). Use them.
- Small throwaway parsing spikes against real journals are encouraged to confirm
  R3.
