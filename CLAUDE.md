# CLAUDE.md

Claude should use `AGENTS.md` as the main entrypoint for this repository.

## Required Startup

1. Read `AGENTS.md`.
2. Resolve the active workpad from `TASKS.md`.
3. Load the required files listed in `AGENTS.md` and `workpads/WORKPADS.md`.
4. Follow the mandatory workflow, the four design stances, the data-contract /
   adapter-boundary rule, the git / privacy rules, and the verification rules from
   `AGENTS.md`.

## Source Of Truth

- `AGENTS.md` is the orchestration brain and primary instruction surface.
- `project.md` is the product source of truth (vision, stances, the on-disk data
  contract, phases).
- `TASKS.md` determines the active workpad.
- `WORKING.md` defines the execution loop, gates, verification, and review.
- `workpads/WORKPADS.md` defines per-workpad context.
- `workpads/architecture/boundaries.md` (once it exists) defines the adapter, run
  model, API, and render contracts.
- Active workpad files define the task acceptance criteria and evidence.

Do not invent a separate Claude-specific workflow. If this file conflicts with
`AGENTS.md`, follow `AGENTS.md` and update this file later only if needed.

## Multi-Agent Workflows

Three saved workflows live in `.claude/workflows/` (run with the `Workflow` tool;
they require explicit user opt-in because they spawn many agents):

- `plan-research.js` — ground the plan in verified facts (client availability,
  connection strategy, the data contract, graph-viz/UI direction, the TS stack),
  design the approach, adversarially review it, and synthesize locked decisions +
  a milestone plan + user questions.
- `refine-plan.js` — adversarially stress-test and refine a workpad's `tasks.md`
  across several lenses until the plan is sound.
- `implement.js` — pick the next milestone task, implement the smallest correct
  change, and adversarially verify it (incl. a UI smoke for visual work) before
  marking complete.

## Note On Dogfooding

argus visualizes exactly the kind of run these workflows produce. The journals
this project's own workflow runs write under
`~/.claude/projects/-Users-nicolas-devel-argus/<session>/workflows/` are argus's
first real dataset — use them as fixtures.
