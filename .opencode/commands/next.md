# Next: Do Next Task

Follow the argus workpads methodology to complete the next task.

## Step 1: Read State Files

Read these first:

1. `TASKS.md` — active workpad queue and notes
2. `AGENTS.md`
3. `project.md`
4. `WORKING.md`
5. `workpads/WORKPADS.md`
6. `workpads/{active-workpad}/tasks.md`
7. `workpads/{active-workpad}/knowledge.md`
8. `workpads/{active-workpad}/references.md`
9. `workpads/architecture/boundaries.md` — once it exists, when the active workpad
   is `architecture`, `prototype`, `live`, `inspect`, or `interact`

## Step 2: Resolve Active Workpad

- The active workpad is the first unchecked item in `TASKS.md`, unless Notes
  override it.
- Confirm its objective in `workpads/WORKPADS.md` and its `tasks.md`.
- Do not skip gates just because a later task looks more concrete.

## Step 3: Gate Check

- `architecture` requires the research gate passed (or `TASKS.md` authorizes
  parallel discovery).
- `prototype` requires the architecture gate passed.
- `live`, `inspect` require the prototype gate (one finished run renders correctly).
- `interact` is exploratory: it produces a design matrix + spike plan, not a
  committed build, and never changes the read-only path.

## Step 4: Select A Task

Choose a pending/unblocked task by dependencies, current state, risk, and
testability. **Prefer the task that proves the next un-proven capability.** argus
validates one capability at a time on real data — do not jump ahead.

## Step 5: Execute

1. Mark the task `in_progress`.
2. Complete the acceptance criteria with the smallest correct change.
3. Update `references.md` with sources, local paths, and dates (for an empirical
   format claim, the exact artifact inspected + the observed field).
4. Update `knowledge.md` with decisions, findings, confidence, rejected options,
   and open questions.
5. Update `tasks.md` with follow-ups discovered during the work.
6. Assess confidence per `WORKING.md`.
7. Spawn focused review subagents when the work is substantial, boundary-defining,
   or confidence is below high — and **always** apply the UI/UX lens to visual
   work. (Or run a workflow in `.claude/workflows/`.)
8. Apply review feedback, record rejected feedback, or ask the user when
   product-sensitive (web-vs-desktop, framework, editing/driving, or anything that
   writes to / drives another project's session).
9. Mark `completed` only when acceptance criteria and review requirements are met —
   for visual milestones, that includes a UI smoke on a real run.
10. Make an explicit commit decision before another `/next` pass.

## Rules

- The product vision in `project.md` is the source of truth when docs conflict.
- Honor the four design stances: **file-first / read-only early** (the on-disk
  journals are the interface; no client API for v1); **working e2e from the first
  milestone** (one capability per step, on real data); **UI/design quality is a
  first-class invariant**; **the on-disk schema is observed/versioned/untrusted,
  isolated behind one adapter**.
- Keep all on-disk-format knowledge behind the adapter; do not leak it elsewhere.
- Privacy: never copy run/transcript content off-machine; never write into another
  project's `.claude` in early phases.
- Do not commit without explicit user confirmation.
- If evidence is weak (renders but doesn't read well, or only on synthetic data),
  record uncertainty instead of declaring done.

Start now.
