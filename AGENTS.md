# AGENTS.md

Repository for **argus**, a web app for visualizing and exploring Claude Code
workflows (the multi-agent runs produced by the `Workflow` tool). Progress
persists in files and git, not conversation context.

The shipped app renders runs on a fullscreen `@xyflow/react` canvas in **two views**
(Plan and Run); the Run view merges the old Progress + Execution tabs via an in-place
expand (the aggregate↔instance join is a click, not a tab-switch). Beyond that it ships a
sortable/filterable agent **table** (with an execution-order DAG view + graph
cross-highlight), **pinned** workflows + a **filter** / staleness-fold / **group-by** rail,
**loop-drill** modes (round-axis / lane-drawer), partial-parse **coverage / warnings**
degradation chips, and a live **SSE connection-state** indicator.

## Source Of Truth

| File | Role |
| --- | --- |
| `TASKS.md` | User-edited workpad queue: which phase to work in |
| `project.md` | Product goal, design stances, the on-disk data contract, phases, backlog |
| `WORKING.md` | Agent loop, gates, verification, review thresholds |
| `workpads/WORKPADS.md` | Per-workpad load lists and objectives |
| `workpads/{workpad}/tasks.md` | Executable tasks with acceptance criteria + evidence |
| `workpads/{workpad}/knowledge.md` | Decisions, findings, open questions, confidence |
| `workpads/{workpad}/references.md` | External/local research with dates |
| `workpads/architecture/boundaries.md` | (Produced in phase 2) the ingestion/run-model/API/render contracts |
| `.claude/commands/next.md` (+ `.cursor`/`.opencode`) | `/next` task-execution command |
| `.claude/workflows/plan-research.js` | Multi-agent workflow: ground the plan in verified facts, design, adversarially review, synthesize |
| `.claude/workflows/refine-plan.js` | Multi-agent workflow: adversarially harden a workpad's `tasks.md` until sound |
| `.claude/workflows/implement.js` | Multi-agent workflow: implement + verify the next milestone task |

## Resolve Active Workpad

1. Read `TASKS.md`; the first unchecked workpad is active unless Notes override it.
2. Confirm status, objective, and load list in `workpads/WORKPADS.md`.
3. Gate check (see `WORKING.md` for the full gates):
   - `architecture` requires the research gate passed (or `TASKS.md` authorizes
     parallel discovery).
   - `prototype` requires the architecture gate passed (or `TASKS.md` authorizes a
     spike).
   - `live` requires the prototype gate: one finished run renders correctly.
   - `inspect` requires the prototype gate.
   - `interact` is exploratory and produces a design + spike, not a committed build.

## Current Phase

**research** is active as of 2026-06-04. The product vision and the observed
on-disk data contract are recorded in `project.md`; the data contract is **seeded
as verified evidence** in `workpads/research/knowledge.md` (inspected from real
`modal-rust` runs). The research phase runs `.claude/workflows/plan-research.js` to:
(a) determine Claude Code client availability for workflow-era versions; (b) choose
the connection strategy (file-watch vs ACP vs remote control vs headless SDK) per
phase; (c) harden + version the data contract; (d) choose the graph-visualization
library and UI design direction (this is a first-class deliverable — UI quality is
a stance); (e) choose the TypeScript stack and web-vs-desktop shape. The phase
gate is a synthesis with locked decisions + a milestone plan + explicit user
questions.

The intended sequence is `research → architecture → prototype → live → inspect →
interact`, validating one capability per step. **Dogfood target:** `../modal-rust`
has 16 real runs (and our own research run becomes argus's first dataset).

## Mandatory Workflow

Before task work:

1. `TASKS.md` → active workpad.
2. `project.md`, `WORKING.md`, `workpads/WORKPADS.md`.
3. Active workpad `tasks.md`, `knowledge.md`, `references.md`.
4. `workpads/architecture/boundaries.md` once it exists (for architecture,
   prototype, live, inspect, interact work).
5. Pick a pending/unblocked task; mark it `in_progress`.
6. Complete the acceptance criteria with the smallest correct change.
7. Record findings in `knowledge.md` and source links/paths/dates in `references.md`.
8. Review per `WORKING.md` (spawn review subagents / run a workflow when warranted).
9. Mark complete only after evidence is recorded.

## Design Stances (from `project.md` — they override convenience)

1. **File-first, zero-instrumentation, read-only early.** The on-disk journals are
   the interface. Phase 1 needs no Claude client API, no leaked binary, no remote
   control, no ACP. Advanced connectivity is additive and deferred — never a
   Phase-1 blocker.
2. **Working end-to-end from the first milestone.** Clean, simple, demonstrable on
   real data at every step. One new capability per milestone, proven against a real
   Claude Code project. No big-bang.
3. **UI/design quality is a first-class invariant.** The visualization is the
   product; layout, legibility, motion, and the fullscreen-canvas + minimal-toolbar
   shell are reviewed deliverables, not polish.
4. **The on-disk schema is observed, versioned, and untrusted.** Tolerate
   unknown/missing fields; never crash on a new field; isolate all format knowledge
   behind one adapter so drift is a one-file fix.

## The Data Contract (do not break the adapter boundary)

argus reads runs from `~/.claude/projects/<slug>/<session>/` where `<slug>` is the
project's absolute cwd with every non-alphanumeric char replaced by `-`. The
adapter is the **only** module that may know the raw on-disk format; everything
downstream consumes the normalized run model. A finished run renders from
`workflows/wf_<id>.json` (which carries `workflowProgress[]` — the phase/agent
tree — plus `result`, `logs`, `phases`, `status`, timing). A running run renders by
tailing `subagents/workflows/wf_<id>/journal.jsonl` + `agent-*.jsonl`. Named
workflows are parsed statically from `<project>/.claude/workflows/*.js` `meta`. See
`project.md` → "The on-disk data contract" for the full shape; keep this seam
stable and defensive across every change.

## Git Rules

- Do not commit or push without explicit user confirmation.
- If asked to commit, show files and message first.
- No destructive git commands unless explicitly requested.
- Keep generated artifacts, captured sample data, and scratch under gitignored
  paths (`.argus/`, `node_modules/`, `dist/`, `tmp/`).

## Privacy / Data Rules

- argus reads the user's **own** `~/.claude` tree. Workflow journals and agent
  transcripts can contain prompts, code, file paths, and secrets a workflow
  happened to touch. **Never** copy run/transcript content into git, logs, or any
  external service without explicit user confirmation.
- Captured sample data for tests/dev goes under gitignored `.argus/` and is
  scrubbed of anything sensitive before it could ever be shared.
- Early phases are **read-only** by stance — argus must not write into or mutate
  another project's `.claude` tree. Writing/driving is an `interact`-phase decision
  the user must opt into.

## Research Rules

- Prefer primary sources: official Claude Code / Claude Agent SDK / Claude API docs
  (via the claude-code-guide agent and `claude-code` knowledge), library docs (via
  the context7 MCP and docs sites), and **direct inspection of the real on-disk
  artifacts** (the strongest evidence we have for the undocumented format).
- Separate proven facts (verified by inspecting a real run or a primary doc) from
  assumptions and recommendations. Record observation dates; the format and the
  client's capabilities change.
- When a claim about the format is empirical, cite the exact file path + the
  observed field as evidence.

## Verification

**Research:** cited URLs/local paths, dated notes, the exact artifact inspected for
empirical claims, recommendation confidence, open questions.

**Architecture:** boundary/contract definitions (adapter, run model, API, render),
failure modes (malformed/partial/huge journal; running-then-killed run), acceptance
criteria, user-sensitive decisions called out.

**Implementation (once a TS app exists):** typecheck (`tsc --noEmit`), lint/format,
unit tests for the adapter against captured real journals, build, **and** the
milestone's manual UI smoke — argus renders the target real run, observed in a
browser (screenshot or Playwright). UI work is not done until it reads well
fullscreen. Record skipped verification with a reason.
