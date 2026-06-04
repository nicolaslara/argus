export const meta = {
  name: 'argus-implement',
  description: 'Implement the next pending milestone task in the active workpad with the smallest correct change, then adversarially verify it (incl. a UI smoke for visual work) before marking complete',
  whenToUse: 'To execute the next task in a workpad end-to-end: pass the workpad name (and optionally a task id) as args',
  phases: [
    { title: 'Select', detail: 'resolve active workpad + pick the next pending task' },
    { title: 'Implement', detail: 'smallest correct change satisfying acceptance criteria' },
    { title: 'Verify', detail: 'run verification + adversarial check that the capability is truly proven' },
    { title: 'Record', detail: 'update knowledge/references/tasks and report' },
  ],
}

// args: "prototype"  OR  { workpad: "prototype", task: "M3" }
const WORKPAD = typeof args === 'string' ? args : (args && args.workpad) || null
const TASK_HINT = (args && args.task) || null

const SELECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['workpad', 'task_id', 'task_title', 'capability', 'acceptance', 'evidence', 'plan'],
  properties: {
    workpad: { type: 'string' },
    task_id: { type: 'string' },
    task_title: { type: 'string' },
    capability: { type: 'string', description: 'the single capability this task validates' },
    acceptance: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'array', items: { type: 'string' } },
    plan: { type: 'array', items: { type: 'string' }, description: 'ordered implementation steps' },
    blocked_reason: { type: 'string' },
  },
}

const IMPL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['files_changed', 'commands_run', 'acceptance_status', 'notes'],
  properties: {
    files_changed: { type: 'array', items: { type: 'string' } },
    commands_run: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['command', 'ok'],
        properties: { command: { type: 'string' }, ok: { type: 'boolean' }, output: { type: 'string' } },
      },
    },
    acceptance_status: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['criterion', 'met'],
        properties: { criterion: { type: 'string' }, met: { type: 'boolean' }, note: { type: 'string' } },
      },
    },
    notes: { type: 'string' },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['capability_proven', 'findings', 'verdict'],
  properties: {
    capability_proven: { type: 'boolean' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['finding', 'severity'],
        properties: { finding: { type: 'string' }, severity: { type: 'string', enum: ['high', 'medium', 'low'] } },
      },
    },
    verdict: { type: 'string', enum: ['complete', 'needs-rework'] },
  },
}

const CONTEXT = `Project: argus, a local-first, read-only WEB APP that visualizes Claude Code workflows. Honor project.md, AGENTS.md, WORKING.md, workpads/research/synthesis.md, and workpads/architecture/boundaries.md (if present). The four DESIGN STANCES: (1) file-first / read-only early — the on-disk journals are the interface; no client API for v1; do not write into or drive another project's .claude tree; (2) working end-to-end from the first milestone — one capability per step, demonstrable on REAL data (dogfood ~/.claude/projects/-Users-nicolas-devel-modal-rust); (3) UI/design quality is a first-class invariant — visual work is not done until it reads well fullscreen on a real run; (4) the on-disk schema is observed/versioned/untrusted — ALL format knowledge stays behind the single adapter; never invent edges/states the journal does not support; tolerate unknown/missing fields. PRIVACY: run/transcript content can contain secrets — never copy it off-machine or into logs. Make the SMALLEST correct change that proves the one capability. VERIFICATION once a TS app exists: tsc --noEmit; the lint/format check; the relevant unit tests (adapter tests run against captured real journals); build. For VISUAL milestones, also produce a UI SMOKE: run the app and capture a screenshot / Playwright snapshot of the target real run, and judge whether it reads well (at 1 agent and at the 14-agent run).`

phase('Select')
const selection = await agent(
  `${CONTEXT}\n\nResolve the active workpad${WORKPAD ? ` (use "${WORKPAD}")` : ' from TASKS.md (first unchecked, honoring Notes overrides)'} and read its tasks.md. ` +
    `${TASK_HINT ? `Select task "${TASK_HINT}".` : 'Select the next pending/unblocked task that proves the next un-proven capability.'} ` +
    `Return the task, the single capability it validates, its acceptance criteria, its evidence requirements, and an ordered implementation plan. If it is blocked, set blocked_reason.`,
  { label: 'select', phase: 'Select', schema: SELECT_SCHEMA },
)

if (selection.blocked_reason) {
  log(`Blocked: ${selection.blocked_reason}`)
  return { blocked: true, selection }
}
log(`Implementing ${selection.task_id}: ${selection.task_title} — proves: ${selection.capability}`)

phase('Implement')
const impl = await agent(
  `${CONTEXT}\n\nImplement ${selection.workpad} task ${selection.task_id} (${selection.task_title}). Capability: ${selection.capability}. ` +
    `Acceptance:\n${selection.acceptance.map((a) => `- ${a}`).join('\n')}\nRequired evidence:\n${selection.evidence.map((e) => `- ${e}`).join('\n')}\n` +
    `Plan:\n${selection.plan.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n\n` +
    `Write the code/files and run the local verification you can (tsc --noEmit, lint, unit tests, build). For a visual milestone, run the app and capture a UI smoke (screenshot/Playwright) of the target real run. Report files changed, commands run (with ok/output), per-criterion acceptance status, and notes. If a step needs a running browser you cannot drive headlessly, implement everything up to it and clearly note the exact command/check left for the user.`,
  { label: `implement:${selection.task_id}`, phase: 'Implement', schema: IMPL_SCHEMA },
)
log(`Implemented ${selection.task_id}: ${impl.files_changed.length} file(s) changed`)

phase('Verify')
const verify = await agent(
  `${CONTEXT}\n\nAdversarially VERIFY that ${selection.workpad} task ${selection.task_id} actually proves its capability: "${selection.capability}". ` +
    `Do NOT trust the implementer's self-report — re-read the changed files (${impl.files_changed.join(', ')}) and re-run/inspect the evidence yourself where possible. ` +
    `Check: the capability is truly isolated and demonstrable on REAL data; all on-disk-format knowledge stayed behind the adapter (stance 4) and the parsing tolerates unknown/missing fields; nothing writes into or drives another project's .claude tree and no run/transcript content leaks off-machine (privacy); and — for a visual milestone — the UI genuinely READS WELL fullscreen (at 1 agent and at the 14-agent run), not merely "renders". Implementer notes:\n${impl.notes}\nAcceptance self-report:\n${JSON.stringify(impl.acceptance_status, null, 2)}\n` +
    `Return whether the capability is proven, any findings (with severity), and a verdict.`,
  { label: `verify:${selection.task_id}`, phase: 'Verify', schema: VERIFY_SCHEMA },
)

phase('Record')
const record = await agent(
  `${CONTEXT}\n\nUpdate the workpad records for ${selection.workpad} task ${selection.task_id} using Edit/Write: set the task Status in workpads/${selection.workpad}/tasks.md (completed only if the verifier verdict is "complete"; otherwise leave in_progress with a follow-up note), append decisions/findings/open-questions to workpads/${selection.workpad}/knowledge.md (and the UI-smoke evidence path for visual work), and add any new sources+dates to workpads/${selection.workpad}/references.md. ` +
    `Verifier verdict: ${verify.verdict}; capability_proven: ${verify.capability_proven}. Findings:\n${JSON.stringify(verify.findings, null, 2)}\n` +
    `Return a one-paragraph status summary and an explicit commit recommendation (commit / hold + why).`,
  { label: 'record', phase: 'Record' },
)

return { selection, impl, verify, record }
