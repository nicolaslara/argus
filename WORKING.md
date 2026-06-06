# Working Practices

Living project-wide agreement for how agents work on **argus**. Complements
`project.md` and the workpads. Update when the workflow changes.

## Purpose

Build a beautiful, local-first web visualizer for Claude Code workflows by adding
one capability at a time, always working end-to-end on real data. Agents execute
small tasks, prove each capability with evidence (including a UI smoke for
visual work), invite critique when confidence is not high, and ask the user on
product-sensitive decisions (web-vs-desktop, framework, editing/driving workflows,
anything touching another project's `.claude` tree).

## General

When a task is complex, boundary-defining, or design-sensitive (and UI/UX is
always design-sensitive here), spawn the strongest analysis/review agents to
compare options and produce reviewable findings. Use faster agents for
well-defined file creation or mechanical expansion once the target structure is
clear. The saved workflows (`.claude/workflows/plan-research.js`, `refine-plan.js`,
`implement.js`) encode the preferred multi-agent shapes; reach for them on
substantial work.

## Validate One Capability At A Time

This project's method is incremental capability validation. Each milestone proves
exactly one new thing on real data and nothing more:

- Do not build `live` before one finished run renders correctly (`prototype` gate).
- Do not build advanced connectivity (ACP / remote control / embedded agent) before
  the file-first read path is proven and the file-first stance is exhausted for the
  capability in question.
- Do not invest in cross-run / multi-project polish before a single run reads
  beautifully.
- If a milestone's evidence is weak (it renders but doesn't read well, or only on
  synthetic data), record the uncertainty rather than moving on.

## File-First Discipline

The on-disk journals are the interface (stance 1). Before reaching for ACP, remote
control, a headless SDK, or any client integration, confirm the files genuinely
cannot provide the capability and record *why*. The adapter layer is the **only**
module that knows the raw on-disk format; if format knowledge leaks elsewhere, that
is a bug to fix, not a pattern to copy. Treat every field as possibly-absent and
every file as possibly-mid-write (a run can be in progress, killed, or partially
flushed).

## LLM- And Human-Friendly File Boundaries

Prefer files with one conceptual responsibility, understandable in one pass. Aim
for modules around 200-400 LOC; treat 600+ LOC as a refactor-soon warning. Keep the
active workpad `tasks.md` cockpit-like; move accumulated background and canonical
decisions into `knowledge.md` and (for architecture) `boundaries.md`.

## Workarounds

Prefer the right fix. Workarounds are acceptable only to unblock progress, time-box
a spike, or isolate unknowns. When using one:

1. Notify the user in the same turn: what was done, why, and the proper fix.
2. State confidence.
3. Add a follow-up task in the workpad's `tasks.md` (or `project.md` backlog if
   cross-cutting).
4. Explore with review subagents for non-trivial tradeoffs.

Do not silently ship or leave workarounds undocumented.

## Core Loop

Use this loop for `/next` and similar task execution. The command prompt lives in
`.claude/commands/next.md` (mirrored in `.cursor/` and `.opencode/`).

1. Read `TASKS.md` and resolve the active workpad.
2. Load `AGENTS.md`, `project.md`, `WORKING.md`, `workpads/WORKPADS.md`.
3. Load the active workpad's `tasks.md`, `knowledge.md`, `references.md`.
4. Once it exists, also load `workpads/architecture/boundaries.md` for
   architecture, prototype, live, inspect, and interact work.
5. Select a task by dependencies, risk, and testability. Prefer the task that
   proves the next un-proven capability.
6. Mark it `in_progress`.
7. Complete acceptance criteria with the smallest correct change.
8. Verify per the task's evidence standard (incl. a UI smoke for visual work).
9. Record findings, decisions, and open questions in `knowledge.md`; sources +
   dates in `references.md`.
10. Assess confidence; use review subagents / a workflow per thresholds below.
11. Incorporate review feedback, record rejections, or ask the user when
    product-sensitive.
12. Mark `completed` only when acceptance criteria and review requirements are met.
13. Before another `/next` pass: explicit commit decision — commit, or record why
    not.

## Verification

Every task needs evidence before completion. Match depth to scope:

| Change touches | Minimum verification |
| --- | --- |
| Research only | Primary/source links, dated notes, and — for empirical format claims — the exact on-disk artifact inspected + the observed field. Confidence + open questions stated. |
| Architecture docs | Boundary review (adapter / run model / API / render), failure modes (malformed/partial/huge journal, killed run), explicit assumptions, user-sensitive decisions called out |
| Adapter / ingestion code | Unit tests against **captured real journals** (finished, running, failed, killed); tolerates unknown/missing fields without crashing; round-trips a known `modal-rust` run to the expected normalized model |
| Backend / API code | `tsc --noEmit`, lint, unit/integration test of the endpoint or watcher; a manual request/stream observed |
| Frontend / render code | `tsc --noEmit`, lint, build, **and a UI smoke**: argus renders the target real run, observed in a browser (screenshot or Playwright snapshot). Must read well fullscreen and at the largest real run (14-agent `modal-rust-plan-research`). |
| Live updates | A real or replayed running run animates to completion without losing/duplicating nodes; reconnect after a dropped channel recovers state. Note: the `/stream` SSE channel emits a coarse `changed` event (plus `open`/heartbeat) and the client full-refetches the live model on each append — incremental `RunDelta` patching is a deferred contract seam (defined in `packages/contract`, no producers/consumers yet), not shipped. |

Record skipped verification in the task or `knowledge.md` with a reason. "It
compiles / it renders" is necessary, not sufficient — visual deliverables are
judged on how they read.

## README Currency

Keep the README **Try it** section current. Whenever a milestone lands a new
human-facing capability (render a run / live view / inspect a node), update it with
the exact, minimal commands a human would type to see it on their own `~/.claude`
data — verified against what actually works, not aspirational. The README is the
human's entry point; agents work from `AGENTS.md`.

## Workpad Gates

1. **Research gate:** `workpads/research/knowledge.md` records, with evidence:
   Claude Code client availability for workflow-era versions; the chosen connection
   strategy per phase (and why file-first suffices for v1); the hardened, versioned
   data contract; the chosen graph-viz library + UI direction (with the comparison
   that decided it); and the TS stack + web-vs-desktop shape — enough to commit to
   the architecture. Plus a milestone plan and explicit user questions.
2. **Architecture gate:** `workpads/architecture/boundaries.md` records the adapter
   contract, the normalized run model, the server↔client API (snapshot +
   incremental), the render/layout pipeline, the shell/IA, and the failure modes.
3. **Prototype gate:** `workpads/prototype/knowledge.md` records a real finished
   `modal-rust` run rendered as a fullscreen phase/agent graph from `wf_*.json`,
   observed in a browser.
4. **Live gate:** a running workflow (real or replayed from captured journals)
   animates correctly to completion.
5. **Inspect gate:** any agent node opens a readable detail view (prompt, result,
   transcript, tokens/tools/timing).
6. **Interact gate (exploratory):** a decision-ready design matrix + spike plan for
   jump-in / embedded-agent editing; does not change the proven read path.

Unless `TASKS.md` Notes override, do not start a phase before its prerequisite
gate has passed.

## Confidence Assessment

| Level | Meaning | Expected action |
| --- | --- | --- |
| High | Strong evidence; narrow, verified scope; UI reads well on real data | Proceed; periodic review on important deliverables |
| Medium | Likely correct but assumptions, weak tests, or UI only checked on synthetic/small data | Prefer focused review before completion |
| Low | Unclear requirements, fragile parsing, format guesses, or unreviewed UI | Review or user direction before completing |

Consider: acceptance met, tested against real journals, UI smoke on the largest
real run, cohesive boundaries, defensive parsing, and the read-only privacy stance.

## Review Subagents

Spawn when work is substantial, boundary-defining, or confidence is below high.
Useful lenses:

- **Adapter robustness:** does parsing survive unknown/missing fields, a killed
  mid-run journal, a huge `result`, a 14-agent tree? Does format knowledge stay
  behind the one seam?
- **Run-model fidelity:** does the normalized model faithfully represent phases,
  agents, pipeline/parallel structure, and state — without inventing edges the
  journal doesn't support?
- **UI/UX & visual design:** does the graph read at a glance? layout legible at 1
  and at 14 agents? state/typography/motion clear? does the fullscreen-canvas +
  minimal-toolbar shell stay out of the way? (This lens is mandatory for any visual
  milestone — UI quality is a stance.)
- **Live correctness:** no lost/duplicated nodes; clean reconnect; correct
  finished-vs-running detection.
- **Privacy:** no run/transcript content leaves the machine; no writes into another
  project's `.claude`.
- **Prior art:** how existing agent/graph observability UIs (LangSmith, trace
  viewers, CI DAG views, node-graph editors) solve the same display problems.

## Acting On Feedback

- Fix clearly correct issues in scope.
- Record accepted decisions in `knowledge.md`; record rejected feedback when it
  affects future work.
- Ask the user on product tradeoffs: web-vs-desktop, framework, whether
  editing/driving workflows is a goal, or anything that would write to / drive
  another project's session.

## Dependency Policy

Use mature libraries freely (the graph/layout library chosen in research, a web
framework, a file watcher, a bundler, a test runner). Prefer proven libraries over
hand-rolling — except the adapter, which we own. Record intentional version pins in
the relevant workpad. Keep the dependency surface honest: a heavy graph library is
justified only if the visualization stance demands it.

## Research Vs Implementation

- Research: primary docs, library evaluation, and **direct inspection of real
  on-disk artifacts** (the strongest evidence for the undocumented format). Small
  throwaway parsing spikes against real runs are encouraged.
- Architecture: adapter / run-model / API / render contracts before broad
  implementation.
- Prototype: the smallest e2e that renders one real finished run beautifully — not
  a complete product.
- Live / inspect / interact: start only after the prerequisite gate passes.

## CI

Once a TS app exists, CI enforces the deterministic unattended subset: `tsc
--noEmit`, lint/format check, adapter unit tests against captured real journals,
and `build`. UI smokes that need a browser are opt-in locally / a separate
Playwright job; they do not block the fast unattended gate.
