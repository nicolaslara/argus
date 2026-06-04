# architecture — tasks

**Objective.** Turn the research synthesis into ratified contracts in
`boundaries.md`. **Gate:** `boundaries.md` ratified — internally consistent,
derived from research, failure modes covered.

> **GATE PASSED 2026-06-04.** `boundaries.md` is ratified — the adapter, run-model,
> API, render/layout, shell, failure-mode, and format-version contracts are derived
> from the adversarially-reviewed synthesis (§2). A1–A6 are designed there; A7's
> *design* is `boundaries.md` §1, *materialized* in prototype M0.

## Tasks (draft)

- [x] **A1 — Adapter contract.** The only module that knows the raw on-disk format.
  Define inputs (project path → slug → session/run discovery), outputs (normalized
  run model), defensive-parsing guarantees, and the observed-format version it
  pins.
- [x] **A2 — Run model.** The normalized graph the app consumes: run → phases →
  agents; pipeline/parallel structure (inferred vs read — per R3); state enum;
  metrics; prompt/result previews; transcript handles.
- [x] **A3 — Server↔client API.** Discovery (projects/runs), snapshot (one run),
  and incremental/live updates. Typed contract; transport chosen in research.
- [x] **A4 — Render/layout pipeline.** Run model → laid-out graph → canvas; layout
  engine config; how phases group; how live updates re-layout without jarring jumps.
- [x] **A5 — Shell / IA.** Fullscreen canvas + collapsible minimal left toolbar
  (switch project, settings); routing/state.
- [x] **A6 — Failure modes.** Malformed/partial/huge journal, killed mid-run, a run
  with no finalized file yet, a project with zero runs, secrets in content.
- [x] **A7 — Repo layout.** Designed in `boundaries.md` §1; materialized in prototype M0.

## knowledge → boundaries.md

The ratified contracts get written to `workpads/architecture/boundaries.md` (the
stable concept file other phases load).
