# Workpads

Workpads are file-backed units of work. Each holds the tasks, decisions, and
references for one phase, so an agent can resolve the current phase, pick the next
task, record evidence, and continue without relying on chat history.

Which workpad is active is chosen in [`../TASKS.md`](../TASKS.md). Per-workpad load
lists and objectives live in [`WORKPADS.md`](./WORKPADS.md).

## Standard files

| File | Holds |
| --- | --- |
| `tasks.md` | Objective, gate, task list with acceptance criteria + evidence |
| `knowledge.md` | Decisions, findings, open questions, confidence, review notes |
| `references.md` | External/local sources with URLs/paths and observation dates |

Some workpads add stable concept files (e.g. `architecture/boundaries.md`).

## Task states

```text
pending
in_progress
blocked
completed
deferred
```

## How `/next` resolves work

1. Read `../TASKS.md`; the first unchecked workpad is active unless Notes override
   it.
2. Confirm the workpad's objective and load list in `WORKPADS.md`.
3. Check the gate (don't skip ahead just because a later task looks concrete).
4. Load the workpad's `tasks.md`, `knowledge.md`, `references.md` (+ any extra files
   listed for it).
5. Pick a pending/unblocked task, mark it `in_progress`, do the smallest correct
   change, record evidence, then mark `completed`.

## Workpads

| Workpad | Phase | Validates |
| --- | --- | --- |
| `research` | 1 | Client availability; connect strategy; the data contract; graph-viz library + UI direction; TS stack |
| `architecture` | 2 | Adapter contract, run model, server↔client API, render/layout pipeline, shell/IA |
| `prototype` | 3 | One finished run rendered as a fullscreen phase/agent graph (e2e) |
| `live` | 4 | File-watching → live progress as a run executes |
| `inspect` | 5 | Drill into a node (prompt/result/transcript/metrics); describe-a-workflow |
| `interact` | exploratory | Jump-in / embedded-agent editing; ACP / remote-control / headless-SDK evaluation |

## Gates

Gates live in `../WORKING.md` and in each workpad's `knowledge.md`. Do not mark a
gate passed without evidence (for visual milestones, evidence includes a UI smoke
on a real run). If a gate is bypassed for a spike, record the override in
`../TASKS.md`.
