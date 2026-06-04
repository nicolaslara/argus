export const meta = {
  name: 'argus-plan-research',
  description: 'Ground the argus plan in verified facts (Claude Code client availability, connection strategy, the on-disk workflow data contract, graph-viz library + UI direction, the TS stack), design the approach, adversarially review it, and synthesize a sound, sequenced plan',
  whenToUse: 'Run once at project start (or when the plan needs re-grounding) to validate the riskiest assumptions before writing workpad tasks',
  phases: [
    { title: 'Research', detail: 'parallel research: client availability, connection strategy, on-disk data contract (inspect real runs), graph-viz libraries, TS stack, prior art' },
    { title: 'Design', detail: 'architecture + UI direction + milestone-plan proposals informed by research' },
    { title: 'Review', detail: 'adversarial lenses: red-team, feasibility/sequencing, contract-fidelity, UI/UX' },
    { title: 'Synthesize', detail: 'consolidate into one authoritative synthesis with locked decisions + user questions' },
  ],
}

// args: { date: "YYYY-MM-DD" }  (Date.now() is unavailable in workflow scripts)
const DATE = (args && args.date) || 'unknown-date'

const RESEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['dimension', 'verified_facts', 'open_questions', 'implications_for_design', 'risks'],
  properties: {
    dimension: { type: 'string' },
    verified_facts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'source', 'confidence'],
        properties: {
          claim: { type: 'string' },
          source: { type: 'string', description: 'URL, doc reference, or exact on-disk path inspected; "training-knowledge" if not otherwise verified' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
    open_questions: { type: 'array', items: { type: 'string' } },
    implications_for_design: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
  },
}

const DESIGN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['component', 'decisions', 'sketches', 'open_questions_for_user', 'risks'],
  properties: {
    component: { type: 'string' },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['decision', 'rationale'],
        properties: {
          decision: { type: 'string' },
          rationale: { type: 'string' },
          alternatives_rejected: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    sketches: { type: 'array', items: { type: 'string' }, description: 'code sketches, type definitions, or ASCII wireframes' },
    open_questions_for_user: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
  },
}

const MILESTONE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['milestones', 'sequencing_rationale', 'open_questions'],
  properties: {
    milestones: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'validates', 'acceptance', 'evidence', 'depends_on'],
        properties: {
          id: { type: 'string', description: 'e.g. M0..M12' },
          name: { type: 'string' },
          validates: { type: 'string', description: 'the single capability this milestone proves' },
          acceptance: { type: 'array', items: { type: 'string' } },
          evidence: { type: 'array', items: { type: 'string' } },
          spike_commands: { type: 'array', items: { type: 'string' } },
          depends_on: { type: 'array', items: { type: 'string' } },
          risk: { type: 'string' },
        },
      },
    },
    sequencing_rationale: { type: 'string' },
    open_questions: { type: 'array', items: { type: 'string' } },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lens', 'verdict', 'must_fix', 'nice_to_have'],
  properties: {
    lens: { type: 'string' },
    verdict: { type: 'string', enum: ['sound', 'sound-with-changes', 'unsound'] },
    must_fix: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['issue', 'why', 'suggested_change', 'severity'],
        properties: {
          issue: { type: 'string' },
          why: { type: 'string' },
          suggested_change: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
    nice_to_have: { type: 'array', items: { type: 'string' } },
    praise: { type: 'array', items: { type: 'string' } },
  },
}

const SYNTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['synthesis_path', 'locked_decisions', 'user_questions', 'residual_risks', 'verdict'],
  properties: {
    synthesis_path: { type: 'string' },
    locked_decisions: { type: 'array', items: { type: 'string' } },
    user_questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'recommendation'],
        properties: {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          recommendation: { type: 'string' },
        },
      },
    },
    residual_risks: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string', enum: ['plan-is-sound', 'plan-needs-user-input'] },
  },
}

// Shared grounding: what argus is, the four stances, and the VERIFIED data contract
// (seeded in workpads/research/knowledge.md by direct inspection on 2026-06-04).
const CONTRACT = `VERIFIED ON-DISK DATA CONTRACT (inspect the real runs to confirm/extend; do NOT take it on faith):
- Runs live under ~/.claude/projects/<project-slug>/<session-id>/. The slug is the project's absolute cwd with every non-alphanumeric char replaced by "-" (e.g. /Users/nicolas/devel/modal-rust -> -Users-nicolas-devel-modal-rust).
- workflows/wf_<id>.json = finalized run journal: runId, timestamp, taskId, script (inline source), scriptPath, args (JSON string), result (returned object), agentCount, logs[] (log() narrator lines), durationMs, summary, workflowName, status (completed|failed|killed; running while live), startTime (epoch ms), phases[] {title,detail}, defaultModel, and workflowProgress[] (the render tree).
- workflowProgress[] has two node types: {type:"workflow_phase", index, title, detail?} and {type:"workflow_agent", index, label, phaseIndex, phaseTitle, agentId, model, state, startedAt, queuedAt, lastProgressAt, attempt, lastToolName, lastToolSummary, promptPreview, resultPreview, tokens, toolCalls, durationMs}.
- workflows/scripts/<name>-wf_<id>.js = persisted script source per run.
- subagents/workflows/wf_<id>/journal.jsonl = live append-only event stream ({type:"started", key, agentId}, ...); agent-<agentId>.jsonl = per-subagent transcript; agent-<agentId>.meta.json = {"agentType":"workflow-subagent"}.
- Named workflows: <project>/.claude/workflows/*.js with export const meta = {name, description, whenToUse?, phases[], model?} — statically parseable. No global/built-in saved workflows on disk; built-ins ship in the client.
REFERENCE DATASET (16 real runs, statuses completed/failed/killed, 1-14 agents): ~/.claude/projects/-Users-nicolas-devel-modal-rust/27b1a6f8-92a6-42eb-a6f1-5f34d8db36b4/ (richest: workflows/wf_9f32796b-c0b.json, the 14-agent modal-rust-plan-research run).`

const GROUND = `You are researching to ground the design of "argus", a local-first, read-only WEB APP that visualizes and explores Claude Code WORKFLOWS — the multi-agent runs produced by the Workflow tool. Quality of the visualization and UI is a first-class product goal.
DESIGN STANCES (constrain everything): (1) FILE-FIRST / READ-ONLY EARLY — the on-disk journals are the interface; v1 needs NO Claude client API, NO leaked binary, NO remote control, NO ACP; heavier connectivity is additive and deferred. (2) WORKING END-TO-END FROM THE FIRST MILESTONE — clean, simple, demonstrable on real data; one capability per step. (3) UI/DESIGN QUALITY IS A FIRST-CLASS INVARIANT — the visualization is the product. (4) THE ON-DISK SCHEMA IS OBSERVED, VERSIONED, AND UNTRUSTED — tolerate unknown/missing fields, isolate format knowledge behind one adapter.
Tools: prefer primary sources. For Claude-Code/SDK/API questions use official docs (WebFetch/WebSearch). For library docs use the context7 MCP (resolve-library-id then query-docs) and official docs. For the UNDOCUMENTED on-disk format, the primary source is DIRECT INSPECTION of the real artifacts with Read/Bash/Grep — cite the exact file path + observed field. If web access fails, answer from training knowledge but mark source "training-knowledge" and lower confidence. Record observation date ${DATE}.
${CONTRACT}
Return verified facts (each with a source + confidence), open questions, concrete implications for argus's design, and risks. Be specific and skeptical; flag anything you cannot confirm.`

const RESEARCH = [
  {
    key: 'client-availability',
    agentType: 'claude-code-guide',
    prompt: `${GROUND}\n\nDIMENSION: Claude Code client availability for the WORKFLOW era.\nDetermine: is the workflow-enabled Claude Code client's source code available, leaked, or only documented? Is there any official, supported surface (docs, SDK, settings, file layout) that documents the workflow data we rely on? CRITICAL conclusion to reach: does argus need ANY client code/API to read & render workflow runs for v1, or is the observed on-disk contract fully sufficient (lean: sufficient — bound this precisely: what could the files NOT give us)? Note the ethics/licensing boundary: argus will NOT depend on leaked proprietary source; it builds on observable on-disk artifacts + official docs/SDKs only. Give a clear yes/no on availability with sources, and a stated v1 dependency boundary.`,
  },
  {
    key: 'connection-strategy',
    agentType: 'claude-code-guide',
    prompt: `${GROUND}\n\nDIMENSION: connection strategy per phase.\nCompare the realistic mechanisms argus could use to obtain workflow data and (later) interact: (a) FILE-WATCH — read/tail the on-disk journals; (b) the Claude Agent SDK (headless) — what it exposes about workflow runs, if anything; (c) ACP (Agent Client Protocol) — what it is, what it standardizes, whether it surfaces sub-agent/workflow structure; (d) "remote control" / driving a live Claude Code session. For EACH: what it enables, its cost/complexity, maturity, and the EARLIEST argus phase that would justify it. Establish why file-first is correct for v1 (render finished + live runs) through inspect (drill-in), and pin exactly what the INTERACT phase (jump into a session, embedded agent that edits/runs a workflow) would actually require beyond files. Output a per-phase recommendation: research/prototype/live/inspect = file-first; interact = ?`,
  },
  // NOTE: the 'data-contract' dimension was intentionally REMOVED as a research
  // agent. It was resolved to higher confidence by DIRECT primary-source inspection
  // of the real runs (recorded in workpads/research/knowledge.md: state enum,
  // journal event schema, no-explicit-edges -> infer from timing, running-run
  // detection, the /private/tmp live-output + tool-results hardlink). The synthesize
  // step folds that authoritative contract in by reading knowledge.md + project.md.
  // (Removing it keeps researchDigest byte-identical to the prior run so the other
  // research/design/review agents stay cached on resume — only synthesize re-runs.)
  {
    key: 'graph-viz-libraries',
    prompt: `${GROUND}\n\nDIMENSION: the graph-visualization library + layout engine for the run view (FIRST-CLASS — UI quality is a stance).\nargus's needs: a PHASE-GROUPED agent graph (phases as lanes/containers; agents as rich node cards inside), 1 to 14+ nodes, beautiful defaults, fullscreen pan/zoom/minimap, custom node rendering (state color, model, label, tokens/tools/duration, progress), smooth LIVE updates (nodes appear and change state queued->running->done), and clear pipeline/parallel structure. Compare candidates with current versions + license + maintenance via context7/official docs: React Flow (@xyflow/react) & Svelte Flow, Reaflow, Cytoscape.js, Sigma.js, vis-network, AntV G6, and D3 + a layout engine (elkjs vs dagre vs d3-hierarchy). Evaluate: layout quality for grouped DAGs, custom-node ergonomics, performance, live-update story, aesthetics out of the box, and how each handles GROUPING (subflows/compound nodes/lanes). Recommend ONE library + ONE layout approach, with the comparison that decided it. Tie the recommendation to a frontend framework only as needed.`,
  },
  {
    key: 'ts-stack',
    prompt: `${GROUND}\n\nDIMENSION: the TypeScript stack + app shape.\nRecommend a minimal, coherent stack: (1) FRONTEND FRAMEWORK (React vs Svelte vs Solid) — decide jointly with the graph-viz recommendation; (2) BACKEND/RUNTIME for filesystem access + file-watching + a typed API + a live channel (Node vs Bun; chokidar or native fs.watch; SSE vs WebSocket for live); (3) bundler/dev server (Vite) + test runner (Vitest) + Playwright for UI smokes; (4) WEB-APP-PLUS-LOCAL-BACKEND vs DESKTOP (Tauri) for v1 — argus must read the local ~/.claude tree from a browser, so weigh a thin local TS server vs a Tauri shell, and keep the desktop/remote swap cheap. Give the repo layout it implies (monorepo apps/packages vs a single src). Justify each choice; note where it preserves stance 1 (read-only) and stance 4 (one adapter).`,
  },
  {
    key: 'prior-art',
    prompt: `${GROUND}\n\nDIMENSION: prior art for displaying agent/DAG runs.\nSurvey how existing tools visualize multi-step/agent/pipeline runs and what reads well vs poorly: LLM/agent trace viewers (LangSmith, LangGraph Studio, OpenAI traces, Phoenix/Arize), CI pipeline DAG views (GitHub Actions, Buildkite, Dagger), node-graph editors (n8n, ComfyUI, Blender/Unreal node graphs), and observability waterfalls/flame graphs. Extract concrete, BORROWABLE patterns (how they show state, time, hierarchy, live progress, drill-in) and ANTI-PATTERNS to avoid, mapped to argus's phase-grouped-agent shape. Keep it actionable for the UI direction.`,
  },
]

phase('Research')
const research = (
  await parallel(
    RESEARCH.map((r) => () =>
      agent(r.prompt, {
        label: `research:${r.key}`,
        phase: 'Research',
        schema: RESEARCH_SCHEMA,
        ...(r.agentType ? { agentType: r.agentType } : {}),
      }),
    ),
  )
).filter(Boolean)

const researchDigest = JSON.stringify(research, null, 2)
log(`Research complete: ${research.length}/${RESEARCH.length} dimensions returned`)

phase('Design')
const [architecture, uiDirection, milestonePlan] = await parallel([
  () =>
    agent(
      `Design the argus APP ARCHITECTURE, grounded in this research digest:\n${researchDigest}\n\n` +
        `Produce concrete decisions (with rationale + rejected alternatives) and sketches (TS type definitions / module boundaries) for: (1) the ADAPTER — the ONLY module that knows the raw on-disk format: its inputs (project path -> slug -> session/run discovery), its output (a normalized run model), its defensive-parsing guarantees (unknown/missing fields, partial/killed runs, huge results), and the observed-format version it pins; (2) the RUN MODEL — the normalized graph the rest of the app consumes (run -> phases -> agents; how pipeline/parallel structure is represented given the data-contract finding on whether edges are read or inferred; the state enum; metrics; prompt/result previews; transcript handles); (3) the SERVER<->CLIENT API — discovery (projects/runs), snapshot (one run), and incremental/live updates, typed, with the transport the stack research recommends; (4) the RENDER/LAYOUT pipeline — run model -> laid-out graph -> canvas, using the chosen graph lib + layout engine, including how phases group and how live deltas re-layout without jarring jumps; (5) the SHELL/IA — fullscreen canvas + collapsible minimal left toolbar (switch project, settings). Honor the 4 stances. Surface genuinely product-sensitive open questions for the user.`,
      { label: 'design:architecture', phase: 'Design', schema: DESIGN_SCHEMA },
    ),
  () =>
    agent(
      `Design the argus UI/VISUAL DIRECTION (this is a first-class deliverable — the visualization is the product), grounded in this research digest:\n${researchDigest}\n\n` +
        `Decide and SKETCH (use ASCII wireframes in the sketches field): (1) the RUN VIEW — how a phase-grouped agent graph reads at a glance; phases as lanes/containers vs swimlanes vs nested groups; how the 14-agent run stays legible; pan/zoom/minimap; (2) the AGENT NODE CARD — what each node shows at rest (label, state, model, tokens, toolCalls, duration, last tool) and the visual language for state (queued/running/done/error/killed) using color + motion, plus the running/progress affordance; (3) the SHELL — fullscreen canvas + a collapsible, very minimal left toolbar (project switcher, settings) that gets out of the way; (4) the design system direction — typography, spacing, color/theme (dark-first?), density, and motion principles for live updates. Keep it concrete enough to implement and beautiful. Tie choices to the prior-art findings. List the open UI questions for the user.`,
      { label: 'design:ui-direction', phase: 'Design', schema: DESIGN_SCHEMA },
    ),
  () =>
    agent(
      `Design the argus MILESTONE PLAN (M0..), grounded in this research digest:\n${researchDigest}\n\n` +
        `Method: validate ONE capability per milestone, always working end-to-end on REAL data (dogfood ~/.claude/projects/-Users-nicolas-devel-modal-rust). File-first; defer heavier connectivity. Use this skeleton and sharpen each with precise acceptance criteria, evidence (incl. a UI smoke for visual milestones), depends_on, and any spike commands: ` +
        `M0 scaffold the app per the chosen stack (frontend + local backend, dev server, tsc/lint/test wired; empty app loads fullscreen); ` +
        `M1 adapter v0 — read one wf_*.json -> normalized run model, unit-tested against a captured modal-rust journal incl. unknown-field tolerance; ` +
        `M2 discovery — given a local project path, derive the slug, list sessions + runs (name/status/agentCount/duration/time); ` +
        `M3 render one finished run — run model -> fullscreen phase/agent graph (chosen lib+layout); phases group agents; nodes show label/state/model; pan/zoom; ` +
        `M4 shell — collapsible minimal left toolbar (switch project / pick run); ` +
        `M5 UI smoke + polish — render the 14-agent run; screenshot/Playwright; pass the UI/UX review; update README "Try it" (PROTOTYPE GATE); ` +
        `M6 running-run detection + journal tailing; M7 live push channel + incremental graph updates; M8 live re-layout + finalize reconciliation (LIVE GATE); ` +
        `M9 node detail view (prompt/result/metrics); M10 agent transcript view (agent-*.jsonl); M11 run-structure navigation + describe-a-workflow via the Claude API (INSPECT GATE). ` +
        `For each milestone give the single capability it validates and its depends_on. Call out any sequencing flaw and propose the fix. Map milestones to the workpads research/architecture/prototype/live/inspect.`,
      { label: 'design:milestones', phase: 'Design', schema: MILESTONE_SCHEMA },
    ),
])

const designDigest = JSON.stringify({ architecture, uiDirection, milestonePlan }, null, 2)
log('Design complete: architecture + UI direction + milestone plan drafted')

phase('Review')
const LENSES = [
  {
    key: 'red-team',
    prompt: `RED-TEAM the argus design + milestone plan. What will actually FAIL or bite us? Probe hardest at: format DRIFT and undocumented fields (stance 4) — does the adapter truly survive unknown/missing fields, a killed mid-run journal, a huge result, a 14-agent tree?; RUNNING-run detection and live-update RACES (lost/duplicated/reordered nodes, partial JSON lines, finalize-vs-tail reconciliation); a browser reading the LOCAL ~/.claude tree (why a local backend is needed; CORS/security/path-escape); PRIVACY (run/transcript content can contain secrets — does anything leak off-machine or get logged?); performance of rendering/laying-out large runs. Default to skepticism. List concrete must_fix items with suggested changes.`,
  },
  {
    key: 'feasibility-sequencing',
    prompt: `Review the MILESTONE SEQUENCING and feasibility. Does each milestone isolate exactly ONE new capability and ship working e2e on real data? Is anything mis-ordered, fused, or skippable? Is file-first genuinely exhausted before any heavier mechanism (SDK/ACP/remote) appears? Is the PROTOTYPE gate (one finished run renders beautifully) truly reachable from M0-M5 with the chosen stack, before live/inspect? Are dependencies right? Propose a corrected ordering if needed.`,
  },
  {
    key: 'contract-fidelity',
    prompt: `Check the design against the VERIFIED DATA CONTRACT and the data-contract research finding in this digest:\n${researchDigest}\n\nFlag any place the architecture/run-model/render contradicts or OVER-ASSUMES the on-disk format — especially INVENTING pipeline/parallel EDGES the journal does not actually support, assuming a state enum not observed, or assuming live-event shapes not confirmed. Quote the relevant fact/path. Confirm all format knowledge stays behind the single adapter seam (stance 4). List must_fix where the design is wrong or unverified-but-assumed.`,
  },
  {
    key: 'ui-ux',
    prompt: `Review the UI/VISUAL DIRECTION against argus's stance that UI quality is first-class. Does the run view READ AT A GLANCE? Does it scale from 1 to 14+ agents without becoming spaghetti? Is the phase grouping legible? Are state, time, and hierarchy obvious? Is the live-progress affordance clear and non-jarring? Is the fullscreen-canvas + minimal-toolbar shell truly out of the way? Are typography/color/density/motion choices coherent and beautiful, and grounded in the prior-art findings? Flag where it would look cluttered, generic, or unreadable, and give concrete must_fix improvements.`,
  },
]

const reviews = (
  await parallel(
    LENSES.map((l) => () =>
      agent(`${l.prompt}\n\nDESIGN UNDER REVIEW:\n${designDigest}`, {
        label: `review:${l.key}`,
        phase: 'Review',
        schema: REVIEW_SCHEMA,
      }),
    ),
  )
).filter(Boolean)

const reviewDigest = JSON.stringify(reviews, null, 2)
const verdicts = reviews.map((r) => `${r.lens}: ${r.verdict}`).join('; ')
log(`Review complete: ${verdicts}`)

phase('Synthesize')
const synthesis = await agent(
  `You are the lead synthesizer for the argus plan. Your job has exactly TWO deliverables, IN THIS ORDER, and you MUST complete both before ending your turn:\n` +
    `STEP 1 — WRITE the file workpads/research/synthesis.md (use the Write tool). Do this FIRST.\n` +
    `STEP 2 — IMMEDIATELY AFTER writing the file, CALL the StructuredOutput tool with the required summary. This is mandatory: returning prose or ending your turn WITHOUT calling StructuredOutput discards all your work and fails the workflow. Keep the StructuredOutput payload concise (the long content goes in the file, not the tool call).\n\n` +
    `FIRST, read these two files for the AUTHORITATIVE, primary-source on-disk data contract (it was verified by direct inspection rather than by a research agent, so it is the source of truth for the data-contract facts): workpads/research/knowledge.md and project.md. Fold those verified facts into the Verified Facts table below.\n\n` +
    `INPUTS:\nRESEARCH (5 dimensions; the data-contract dimension is covered by the files above):\n${researchDigest}\n\nDESIGN:\n${designDigest}\n\nREVIEWS:\n${reviewDigest}\n\n` +
    `The synthesis.md document must contain, with clear headings: (1) a Verified Facts table (claim | source | confidence) covering Claude Code client availability, connection strategy, the on-disk data contract (from knowledge.md — incl. state=done/progress, journal events started/result, NO explicit pipeline edges so structure is INFERRED from timing+labels, running-run detection, the /private/tmp live-output hardlinked to tool-results), graph-viz libraries, and the TS stack; (2) Locked Decisions — client dependency boundary, per-phase connection strategy, the adapter + run-model + API + render contracts, the chosen graph-viz library + layout engine, the UI/visual direction, and the TS stack + web-vs-desktop shape — folding in every high-severity must_fix from the reviews and noting what changed; (3) the Milestone Plan M0.. (use the design:milestones output) with per-milestone validates/acceptance/evidence/depends_on, mapped to the workpads research/architecture/prototype/live/inspect; (4) Open Questions For The User with a recommended default for each (at minimum: web-app-plus-local-backend vs desktop/Tauri for v1; frontend framework; whether editing/driving workflows is a real goal); (5) Residual Risks. Resolve review conflicts explicitly.\n\n` +
    `Mark the plan "plan-is-sound" only if no high-severity must_fix remains unaddressed; otherwise "plan-needs-user-input". Then CALL StructuredOutput with: synthesis_path = "workpads/research/synthesis.md", locked_decisions, user_questions, residual_risks, verdict.`,
  { label: 'synthesize', phase: 'Synthesize', schema: SYNTH_SCHEMA },
)

log(`Synthesis verdict: ${synthesis.verdict}; written to ${synthesis.synthesis_path}`)
return { research, architecture, uiDirection, milestonePlan, reviews, synthesis }
