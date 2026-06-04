# architecture — tasks

**Objective.** Turn the research synthesis into ratified contracts in
`boundaries.md`. **Gate:** `boundaries.md` ratified — internally consistent,
derived from research, failure modes covered.

> Blocked until the research gate passes. Tasks below are placeholders to be
> refined (e.g. via `.claude/workflows/refine-plan.js`) once research lands.

## Tasks (draft)

- [ ] **A1 — Adapter contract.** The only module that knows the raw on-disk format.
  Define inputs (project path → slug → session/run discovery), outputs (normalized
  run model), defensive-parsing guarantees, and the observed-format version it
  pins.
- [ ] **A2 — Run model.** The normalized graph the app consumes: run → phases →
  agents; pipeline/parallel structure (inferred vs read — per R3); state enum;
  metrics; prompt/result previews; transcript handles.
- [ ] **A3 — Server↔client API.** Discovery (projects/runs), snapshot (one run),
  and incremental/live updates. Typed contract; transport chosen in research.
- [ ] **A4 — Render/layout pipeline.** Run model → laid-out graph → canvas; layout
  engine config; how phases group; how live updates re-layout without jarring jumps.
- [ ] **A5 — Shell / IA.** Fullscreen canvas + collapsible minimal left toolbar
  (switch project, settings); routing/state.
- [ ] **A6 — Failure modes.** Malformed/partial/huge journal, killed mid-run, a run
  with no finalized file yet, a project with zero runs, secrets in content.
- [ ] **A7 — Repo layout.** Materialize the package/app structure from R5.

## knowledge → boundaries.md

The ratified contracts get written to `workpads/architecture/boundaries.md` (the
stable concept file other phases load).
