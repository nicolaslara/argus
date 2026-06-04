export const meta = {
  name: 'argus-refine-plan',
  description: 'Adversarially stress-test and refine a workpad tasks.md until the plan is sound, across multiple lenses, looping until reviewers stop finding material issues',
  whenToUse: 'When a workpad plan (tasks.md) needs hardening before implementation: pass the workpad name as args (e.g. "prototype")',
  phases: [
    { title: 'Load', detail: 'read the workpad plan + project context' },
    { title: 'Critique', detail: 'parallel adversarial lenses find material issues' },
    { title: 'Revise', detail: 'apply accepted fixes and re-critique until dry' },
    { title: 'Finalize', detail: 'confirm consistency and write a refinement log' },
  ],
}

// args: "prototype"  OR  { workpad: "prototype", maxRounds: 3 }
const WORKPAD = typeof args === 'string' ? args : (args && args.workpad) || 'prototype'
const MAX_ROUNDS = (args && args.maxRounds) || 3
const TASKS_PATH = `workpads/${WORKPAD}/tasks.md`

const CRITIQUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lens', 'verdict', 'issues'],
  properties: {
    lens: { type: 'string' },
    verdict: { type: 'string', enum: ['sound', 'sound-with-changes', 'unsound'] },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['issue', 'why', 'fix', 'severity'],
        properties: {
          issue: { type: 'string' },
          why: { type: 'string' },
          fix: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
}

const REVISE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['applied', 'rejected', 'summary'],
  properties: {
    applied: { type: 'array', items: { type: 'string' } },
    rejected: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['issue', 'reason'],
        properties: { issue: { type: 'string' }, reason: { type: 'string' } },
      },
    },
    summary: { type: 'string' },
  },
}

const CONTEXT = `Project: argus, a local-first, read-only WEB APP that visualizes Claude Code workflows. Read project.md, AGENTS.md, WORKING.md, and workpads/research/synthesis.md (and workpads/architecture/boundaries.md if present) for the rules. The four DESIGN STANCES: (1) file-first / read-only early — the on-disk journals are the interface; no client API for v1; heavier connectivity (SDK/ACP/remote) is additive and deferred. (2) working end-to-end from the first milestone — one capability per step, on REAL data. (3) UI/design quality is a first-class invariant — the visualization is the product; visual milestones need a UI smoke as evidence. (4) the on-disk schema is observed/versioned/untrusted — all format knowledge lives behind ONE adapter; never invent edges/states the journal does not support. The method is to validate ONE capability per task, always demonstrable on real data (dogfood ~/.claude/projects/-Users-nicolas-devel-modal-rust).`

const LENSES = [
  {
    key: 'capability-isolation',
    prompt: `Read ${TASKS_PATH}. Does each task isolate exactly ONE new capability and ship working end-to-end on real data? Find tasks that fuse two capabilities, skip one, depend on something not yet proven, or could only be demonstrated on synthetic data. Flag any task that reaches for heavier connectivity (SDK/ACP/remote/embedded agent) before the file-first path is exhausted for that capability.`,
  },
  {
    key: 'acceptance-evidence',
    prompt: `Read ${TASKS_PATH}. Is every task's acceptance criteria objectively checkable, and does each have concrete evidence? For VISUAL milestones, is a UI smoke on a REAL run required (screenshot/Playwright; reads well fullscreen incl. the 14-agent run), not just "it renders"? For adapter/parsing work, are unit tests against captured real journals (incl. unknown-field / killed-run tolerance) required? Flag vague acceptance or evidence that wouldn't actually prove the capability.`,
  },
  {
    key: 'red-team',
    prompt: `Read ${TASKS_PATH}. Red-team it: what will fail on real data? Hidden assumptions about the undocumented format (state enum, pipeline/parallel structure, live-event shapes), running-run detection, live-update races, a browser reading the local ~/.claude tree, privacy (secrets in run/transcript content), and rendering performance on large runs. What ordering will cause a late, expensive surprise?`,
  },
  {
    key: 'dependency-order',
    prompt: `Read ${TASKS_PATH}. Check task IDs, dependencies, and ordering. Is anything out of order, missing a dependency, or blocking work that should come first? Is the cheapest/riskiest validation (the adapter against real journals; one finished run rendering) done before the dependent UI/live/inspect work?`,
  },
]

phase('Load')
log(`Refining ${TASKS_PATH} (up to ${MAX_ROUNDS} rounds)`)

let round = 0
let dry = false
const history = []

while (round < MAX_ROUNDS && !dry) {
  round++
  phase(`Critique r${round}`)
  const critiques = (
    await parallel(
      LENSES.map((l) => () =>
        agent(
          `${CONTEXT}\n\n${l.prompt}\n\nReturn your verdict and a list of material issues (with a concrete fix and severity each). Only report issues that genuinely matter; do not invent nits.`,
          { label: `critique:${l.key}:r${round}`, phase: `Critique r${round}`, schema: CRITIQUE_SCHEMA },
        ),
      ),
    )
  ).filter(Boolean)

  const material = critiques.flatMap((c) => c.issues.filter((i) => i.severity !== 'low'))
  log(`Round ${round}: ${material.length} material issue(s) across ${critiques.length} lenses`)
  history.push({ round, critiques })

  if (material.length === 0) {
    dry = true
    break
  }

  phase(`Revise r${round}`)
  const revision = await agent(
    `${CONTEXT}\n\nRevise ${TASKS_PATH} IN PLACE using the Edit/Write tools to address these reviewer issues. Apply the clearly-correct fixes; reject any that conflict with the project's four stances (record why). Preserve the file's existing structure, task-ID scheme, and formatting (Objective / Gate / per-task acceptance + evidence). Issues:\n${JSON.stringify(material, null, 2)}`,
    { label: `revise:r${round}`, phase: `Revise r${round}`, schema: REVISE_SCHEMA },
  )
  log(`Round ${round} revision: ${revision.summary}`)
  history.push({ round, revision })
}

phase('Finalize')
const final = await agent(
  `${CONTEXT}\n\nDo a final read of ${TASKS_PATH} and confirm it is internally consistent (task IDs, dependencies, gate). Then write/append a short "Plan Refinement Log" section at the BOTTOM of ${TASKS_PATH} summarizing this refinement pass (rounds run, key changes applied, anything rejected). Keep it concise. Confirm the plan is now sound or list what remains.`,
  { label: 'finalize', phase: 'Finalize' },
)

return { workpad: WORKPAD, rounds: round, converged: dry, finalNote: final, history }
