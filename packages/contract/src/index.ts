// @argus/contract — wire types shared by server & web. No runtime deps.
// These are the ratified shapes from workpads/architecture/boundaries.md §3-§4.
// The adapter (and only the adapter) maps the raw on-disk format onto these.

export type RunStatus = 'completed' | 'failed' | 'killed' | 'running';

export type AgentState =
  | 'queued'
  | 'running'
  | 'done'
  | 'error'
  | 'interrupted'
  | 'unknown';

/** Authoritative key is `projectPath` (recovered abs cwd), NOT `slug` (lossy/collides). */
export interface RunRef {
  projectPath: string;
  slug: string;
  sessionId: string;
  runId: string;
}

export interface ProjectRef {
  /** Recovered absolute project cwd (authoritative). */
  projectPath: string;
  /** On-disk slug dir name (kept for path-building only). */
  slug: string;
  /** Display name (basename of projectPath). */
  name: string;
  sessionCount: number;
}

/** `truncated` = raw length === 401 (the observed preview cap); empty (len 0) is NOT truncated. */
export interface Preview {
  text: string;
  truncated: boolean;
}

/** 1-based phase index. */
export interface Phase {
  index: number;
  title: string;
  detail: string | null;
}

/** The `/$bunfs/.../cli.js` stack is hidden in `internalDetail`, never rendered raw. */
export interface RunError {
  message: string;
  internalDetail?: string;
}

/**
 * The ACCURATE cause of a failed agent, classified from its transcript tail (the run model's
 * `error.message` only ever says "completed without calling StructuredOutput" — which is ~96%
 * misleading, since the real cause is a transient infra drop). `mode` separates INFRA failures
 * (a dropped socket / usage limit / overloaded API — retryable, not the model's fault) from a
 * genuine MODEL failure (a StructuredOutput payload the schema rejected). `kind` is the specific
 * signature; `label` is banner-ready; `detail` carries the extra (a reset time, a schema field).
 */
export interface AgentFailureCause {
  mode: 'infra' | 'model' | 'unknown';
  kind: 'socket' | 'session-limit' | 'overloaded' | 'schema-validation' | 'unknown';
  label: string;
  detail: string | null;
}

/** Codes, never raw text/paths. */
export interface AdapterWarning {
  code: string;
  detail?: string;
}

export interface AgentNode {
  agentId: string;
  index: number;
  label: string;
  /** 1-based, resolved; nodes with an unresolvable phaseIndex are dropped-with-warning. */
  phaseIndex: number;
  model: string | null;
  state: AgentState;
  /** Resume-cache reuse → "cached" badge. */
  cached: boolean;
  agentType: string | null;
  attempt: number | null;
  /** True ONLY on an exact label/agentId match in a logs[] /failed/ line. */
  failedInLogs: boolean;
  // Metrics — present on finalize; may be null while live (they live in wf_*.json).
  tokens: number | null; // 0 preserved (0-with-tools = activity, not "nothing")
  toolCalls: number | null;
  durationMs: number | null;
  queuedAt: number | null;
  startedAt: number | null;
  lastProgressAt: number | null;
  lastToolName: string | null;
  lastToolSummary: string | null;
  promptPreview: Preview | null;
  resultPreview: Preview | null;
}

/** The only synthesized edge: phase_i → phase_i+1. No agent-level edges exist on disk. */
export interface PhaseEdge {
  from: number;
  to: number;
}

export interface RunModel {
  ref: RunRef;
  workflowName: string;
  status: RunStatus;
  /** Built from journal without a finalized wf_*.json, or from a torn file. */
  incomplete: boolean;
  startTime: number | null;
  durationMs: number | null;
  defaultModel: string | null;
  summary: string;
  phases: Phase[];
  /** Grouped by phaseIndex, ordered by index. */
  agents: AgentNode[];
  edges: PhaseEdge[];
  /** Narrator log() lines. */
  logs: string[];
  /** Run-level; verbatim failing line(s). */
  partialFailure: { present: boolean; lines: string[] };
  error: RunError | null;
  args: unknown;
  warnings: AdapterWarning[];
  /** ADAPTER_FORMAT pin. */
  format: string;
  // NOTE: script/scriptPath intentionally absent — lazy "view source" only.
}

/** Run-list row: header fields only (no tree / transcripts). */
export interface RunSummary {
  ref: RunRef;
  workflowName: string;
  status: RunStatus;
  agentCount: number;
  durationMs: number | null;
  startTime: number | null;
  summary: string;
  partialFailure: boolean;
}

/** A declared phase inside a static workflow `meta` (no run yet; titles/details only). */
export interface WorkflowMetaPhase {
  title: string;
  detail: string | null;
}

/**
 * The static `export const meta = {...}` of a `<project>/.claude/workflows/*.js`
 * file — used for the "available workflows without a run" view. All fields tolerant;
 * an unparseable file yields `null` (never a crash). `file` is the basename only.
 */
export interface WorkflowMeta {
  /** Basename of the source .js (path-building / display only). */
  file: string;
  name: string;
  description: string;
  whenToUse: string | null;
  phases: WorkflowMetaPhase[];
  model: string | null;
}

// ============================================================================
// PlanModel — the STATIC plan DAG (P1). A SIBLING of RunModel (NOT a superset,
// NOT a parent). Derived run-free from a workflow `.js` source by the adapter's
// `parsePlan` (acorn wrap-parse, recursive default-deny walk). RunModel/AgentNode
// above are byte-unchanged: binding is an overlay-time, web-side concern (P2).
//
// Design: workpads/architecture/plan-view-design.md §4.2. The two join keys onto
// RunModel are the agent() label (== workflow_agent.label) and the 1-based phase
// index (Phase.title via phaseIndex) — used by the P2 overlay, not by this model.
// ============================================================================

export type PlanNodeKind =
  | 'input'
  | 'output'
  | 'process'
  | 'agent'
  | 'decision'
  | 'loop'
  | 'subworkflow'
  | 'pipeline'
  | 'unparsed';

/** Per-node provenance: declared(meta) > static(AST) > heuristic(LLM/inference). */
export type Confidence = 'declared' | 'static' | 'heuristic';

/**
 * Template multiplicity of a node.
 * - `one`: a single instance.
 * - `fixed`: exactly `n` instances — ONLY for an in-scope const array-of-literals.
 * - `unbounded`: runtime-computed count; `min` is the statically-known literal floor
 *   (e.g. the spread-mix `[...ARR.map(...), ()=>agent(...)]` → min = literalCount).
 */
export type Multiplicity =
  | { kind: 'one' }
  | { kind: 'fixed'; n: number }
  | { kind: 'unbounded'; min: number; max: 'N'; sourceExpr?: string };

/**
 * A structured label template (Tier-3) — distinguishes a static prefix from a
 * runtime hole, e.g. `research:${r.key}` → { literalPrefix:'research:', holes:['r.key'] }.
 * This is the overlay join key (P2). `raw` keeps the source label expression.
 */
export interface LabelTemplate {
  literalPrefix: string;
  holes: string[];
  raw: string;
}

export interface PlanAnnotation {
  /** T1/T3 deterministic; a T4 LLM pass (PX) MAY enrich it (then source='heuristic'). */
  subtitle: string | null;
  /** T4-only pattern name (PX). */
  patternName?: string | null;
  /** A StructuredOutput `schema` was present on the opts. */
  typed: boolean;
  /** Provenance of the subtitle. */
  source: Confidence;
  /** Byte offsets into the source (unparsed / view-source). */
  span?: { start: number; end: number };
}

export interface PlanNode {
  /** Stable id: labelTemplate.raw | phaseRef | ordinal. */
  id: string;
  kind: PlanNodeKind;
  title: string;
  /** Overlay join key (structured); null for non-agent nodes. */
  labelTemplate: LabelTemplate | null;
  agentType: string | null;
  /** 1-based, into PlanModel.lanes; null if outside any declared phase. */
  phaseRef: number | null;
  multiplicity: Multiplicity;
  /** Discovered inside a decision branch → rendered dashed. */
  optional: boolean;
  /** Enclosing loop node id, if any. */
  loopRef: string | null;
  /** Enclosing decision node id, if any. */
  parentDecisionId: string | null;
  annotation: PlanAnnotation;
  confidence: Confidence;
}

export interface DecisionNode extends PlanNode {
  kind: 'decision';
  conditionKind: 'regex-verdict' | 'schema-field' | 'expr';
  /** e.g. 'BUILD_GREEN?' | 'blocked_reason?'. */
  conditionLabel: string;
}

export interface LoopNode extends PlanNode {
  kind: 'loop';
  /** e.g. 'until dry · max 3'. */
  stopCondition: string;
  /** Static cap when readable (e.g. the literal 3 in `(args&&args.maxRounds)||3`), else null. */
  maxRounds: number | null;
}

export type PlanEdgeKind = 'flow' | 'fanout' | 'merge' | 'optional' | 'loop-back';

export interface PlanEdge {
  id: string;
  from: string;
  to: string;
  kind: PlanEdgeKind;
  label?: string;
}

export type ContainerKind = 'lane' | 'loop' | 'trust-boundary';

export interface PlanContainer {
  id: string;
  kind: ContainerKind;
  title: string;
  detail: string | null;
  /** Stub-only styling (no layout wiring in P1). */
  trust?: 'trusted' | 'untrusted';
  childIds: string[];
}

/** A primary phase-axis lane (seeded from meta.phases; the trustworthy spine). */
export interface PlanLane {
  index: number;
  title: string;
  detail: string | null;
  confidence: Confidence;
}

export interface PlanModel {
  /** Basename only. */
  workflowFile: string;
  workflowName: string;
  /** Primary phase axis (meta.phases seed). */
  lanes: PlanLane[];
  nodes: PlanNode[];
  edges: PlanEdge[];
  containers: PlanContainer[];
  /** Coded: 'unparsed-statement' | 'import-detected-fallback' | 'meta-only' | … */
  warnings: AdapterWarning[];
  derivedFrom: 'static-source' | 'meta-only';
  /** recognized statements / total — an honest coverage signal (best-effort). */
  coverageRatio: number;
  /** ADAPTER_FORMAT pin. */
  format: string;
}

// ============================================================================
// Overlay (P2) — the WEB-SIDE Plan⟷Execution morph binding. ADDITIVE & web-side:
// `AgentNode`/`RunModel`/`PlanModel` above are byte-UNCHANGED. Binding lives ONLY in
// these types, produced by the PURE web-side `buildOverlay(plan, run)` join — never by
// the adapter, never on the wire as a new run/agent field (Stance 4: no invented edges/
// states; execution inherits Plan edges via the binding, not from timing).
//
// Design: workpads/architecture/plan-view-design.md §4.3 + §6 (3-way classification).
// The join keys are the agent label-prefix (PlanNode.labelTemplate.literalPrefix vs the
// run AgentNode.label) and the 1-based phase index (resolved to a title via Phase.title,
// NOT a phaseTitle field — AgentNode has none).
// ============================================================================

/**
 * The binding confidence of a single plan node's painted instances (§6 tie-break):
 * - `high`   : an EXACT labelTemplate literal match (the static label === the run label).
 * - `medium` : a prefix + phaseIndex match that is UNIQUE (one plan node owns it).
 * - `low`    : a prefix+index that is AMBIGUOUS, or a phase-only group — rendered as a
 *   coarse group with NO winner picked (see `ambiguous`).
 */
export type BindingConfidence = 'high' | 'medium' | 'low';

/**
 * One plan node painted with the run instances bound to it. `status` aggregates the
 * bound agents' states; for a fan-out, `succeeded`/`total` drive the aggregate chip
 * ('6/7 done · 1 failed'). `total` is `'N'` when the plan multiplicity is unbounded and
 * no concrete instance count is known. `ambiguous` is a FIRST-CLASS visible state: when
 * a single run agent matches >1 plan node it is flagged here and NEVER silently resolved.
 */
export interface PlanBinding {
  /** The PlanNode.id this binding paints onto. */
  planNodeId: string;
  /** The run AgentNode.agentId values bound to this plan node (may be empty = not-run). */
  agentIds: string[];
  /** Aggregate run status painted onto the template node. */
  status: 'not-run' | 'partial' | 'complete';
  /** Bound agents that reached a terminal success (done AND produced a result). */
  succeeded: number;
  /**
   * Bound members that ran but FAILED to produce a result — the observed
   * `parallel[N] failed: subagent completed without calling StructuredOutput` signature
   * (state not done, OR done-with-0-tokens-after-tool-use). Drives the fan-out aggregate
   * chip's `· K failed` segment. Never inferred from timing.
   */
  failed: number;
  /** Bound agent count, or `'N'` when the template multiplicity is unbounded/unknown. */
  total: number | 'N';
  /** The §6 classification of this binding. */
  confidence: BindingConfidence;
  /** True iff a bound run agent ALSO matched another plan node (never auto-resolved). */
  ambiguous: boolean;
}

/**
 * A loop container's bound run instances split BY ROUND. `PlanBinding` folds every round
 * of a loop body onto ONE plan node (a whole-loop-body aggregate); this per-round split is
 * the granularity needed to make a loop-body fan reachable via the round axis → DetailPanel
 * (the loop body's agents are NOT lane-drawn — they are drilled through the round axis).
 * The round is re-derived from each agent's `:rN` label suffix / ` rN` phase title (the same
 * signals `observeRounds` reads); an agent matching neither falls to round 1 (the
 * conservative whole-body bucket). Additive & web-side only (Stance 4: no wire/on-disk change).
 */
/** One loop-body run instance in a round (the minimum a clickable drill row needs). */
export interface LoopRoundInstance {
  /** The run AgentNode.agentId — keys the DetailPanel drill (transcript/result/activity). */
  agentId: string;
  /** The concrete run label (`critique:red-team:r1`), shown on the row. */
  label: string;
  /** The instance run state — drives the row's status glyph/color (reuses STATE_COLOR). */
  state: AgentState;
}

export interface LoopRoundBinding {
  /** The observed round (1-based). */
  round: number;
  /** The run AgentNode.agentId values that ran in this round of this loop body. */
  agentIds: string[];
  /** The instances (agentId + label + state) for this round — feeds the clickable drill rows. */
  instances: LoopRoundInstance[];
}

/**
 * The complete Plan⟷Execution overlay for one (plan, run) pair. Web-side only.
 * - `bindings`: one entry per plan node that bound at least one agent OR is a planned
 *   node with no run instance (planned-not-run → `status:'not-run'`, ghosted in the UI).
 * - `unplannedAgentIds`: run agents whose label matched NO plan node (unplanned-agent).
 * - `rounds`: the observed loop-round count when the run unrolled a loop body more than
 *   once (drives the folded↔unrolled mode switch); `null` when no loop unrolling is seen.
 * - `loopRounds`: per loop-container id, the bound instances split by round (drives the
 *   clickable round axis → DetailPanel drill). Omitted when no loop body bound any agent.
 */
export interface Overlay {
  bindings: PlanBinding[];
  unplannedAgentIds: string[];
  rounds: number | null;
  /** loopNodeId → that loop body's bound instances, split by round. */
  loopRounds?: Record<string, LoopRoundBinding[]>;
}

// ============================================================================
// Explanation layer (PX) — ADDITIVE wire types. Per-node LLM captions enriched
// by a background `claude -p` pool, served via a separate poll endpoint, swapped
// into the node subtitle/caption slot when ready. ANNOTATION-ONLY: these types
// never carry topology — nodes/edges/containers (from AST/meta) stay byte-identical.
// Design: workpads/architecture/plan-view-design.md §10.
// ============================================================================

/**
 * The lifecycle of a single node's explanation:
 * - `baseline`: only the deterministic caption is available (meta detail / prompt
 *   first line / label). Always renderable instantly.
 * - `pending`: enqueued/in-flight in the background pool (still shows baseline).
 * - `ready`: an LLM caption is available and should swap into the subtitle.
 * - `error`: generation failed (claude absent/errored/timed out) → keep baseline.
 */
export type ExplanationStatus = 'baseline' | 'pending' | 'ready' | 'error';

/** Provenance of the caption currently carried by a NodeExplanation. */
export type ExplanationSource = 'baseline' | 'llm';

/**
 * One node's caption. `id` matches the visualization node id (PlanNode.id for plan
 * views, the AgentNode.agentId for execution). `caption` is ALWAYS populated (the
 * deterministic baseline at minimum); `source`/`status` say whether it has been
 * LLM-enriched yet. Rendered as a text node only (never dangerouslySetInnerHTML).
 */
export interface NodeExplanation {
  id: string;
  caption: string;
  /** Optional short pattern name (e.g. "fan-out verifier") — LLM-only, may be null. */
  pattern?: string | null;
  status: ExplanationStatus;
  source: ExplanationSource;
}

/** The poll response: the current explanations for every node of a plan/run. */
export interface ExplanationBatch {
  /** Echoes the requested target so the client can drop stale responses. */
  target: string;
  /** True while any node is still `pending` (the client keeps polling). */
  pending: boolean;
  /** Whether the `claude` engine is available at all (false → all baseline). */
  engineAvailable: boolean;
  explanations: NodeExplanation[];
}

// ============================================================================
// Generative sub-UI (#9) — Claude builds a TAILORED rendering for a node's result.
// SAFETY: the LLM emits a CONSTRAINED "panel spec" (sections from a FIXED vocabulary),
// NEVER executable HTML/JS — the web renders each section with a trusted React
// component, all values as text nodes. So it's "generative UI" without an injection
// surface. Content-addressed-cached like PX. Design: a fixed section grammar.
// ============================================================================

/** A `callout` tone → a trusted color treatment (no arbitrary styling from the LLM). */
export type CalloutTone = 'info' | 'success' | 'warn' | 'danger';

/** One section of a generated panel. Every leaf value is a plain string (text-node safe). */
export type PanelSection =
  | { kind: 'callout'; tone: CalloutTone; text: string }
  | { kind: 'keyvalue'; items: Array<{ key: string; value: string }> }
  | { kind: 'list'; ordered?: boolean; items: string[] }
  | { kind: 'table'; columns: string[]; rows: string[][] }
  | { kind: 'metrics'; items: Array<{ label: string; value: string }> }
  | { kind: 'text'; text: string };

/** The tailored panel Claude generated for one node. `title` is a short heading. */
export interface PanelSpec {
  title: string;
  sections: PanelSection[];
}

/** Lifecycle of a node's generative sub-UI (mirrors ExplanationStatus). */
export type SubUiStatus = 'pending' | 'ready' | 'error' | 'unavailable';

/** The sub-UI poll/fetch response for one node's result. */
export interface SubUiResponse {
  /** Echoes the requested node so a stale response can be dropped. */
  target: string;
  status: SubUiStatus;
  /** Present when status==='ready'; null otherwise (the caller falls back to R1's readable view). */
  spec: PanelSpec | null;
}

// ============================================================================
// AgentActivity — the transcript-fed inspector payload (failure-and-live-inspector
// design §4/§5). Derived by the adapter from a per-agent `agent-<id>.jsonl` transcript
// (the ONLY place tokens/tools/timing/last-activity live; the journal is starved). LAZY:
// never bundled into the run list — served by a dedicated per-agent route, parsed on
// select / for live agents. Annotation-only: carries NO topology (no nodes/edges/states);
// the run's AgentNode is byte-unchanged. All transcript knowledge stays in the adapter.
// ============================================================================

/** One distinct tool the agent invoked, with how many times it was called. */
export interface AgentToolUse {
  name: string;
  count: number;
}

/**
 * One entry in an agent's activity timeline (capped). `kind:'tool'` carries the tool
 * `name`; `kind:'text'` is an assistant text turn (name absent). `t` is the source ISO
 * timestamp of the originating transcript event.
 */
export interface AgentTimelineEntry {
  t: string;
  kind: 'tool' | 'text';
  name?: string;
}

/**
 * A transcript-derived activity summary for ONE agent (live or finished). Built by the
 * adapter's `agentActivityFromTranscript` from `agent-<id>.jsonl`:
 * - `label`    : derived from the first user message's first line (a real task, not a hash).
 * - `prompt`   : the FULL text of the first user message — the task handed to the agent
 *   (capped to a sane length). `label` is its first line; `prompt` is the whole thing.
 * - `tools`    : distinct `tool_use` names + counts; `toolCalls` is the total.
 * - `tokens`   : Σ of assistant `message.usage` (input/output/cacheRead); null if none seen.
 * - timing     : `startedAt`/`lastAt` (first→last event ISO timestamps) + `durationMs`.
 * - `timeline` : ordered tool/text events (capped to a sane max).
 * - `lastText` : the last assistant text block — the current/final activity (for a failed
 *   agent often the `API Error: …` line, i.e. the root-cause answer).
 * - `error`    : a detected terminal/API-error line, if any.
 */
export interface AgentActivity {
  agentId: string;
  label?: string;
  prompt?: string;
  tools: AgentToolUse[];
  toolCalls: number;
  tokens: { input: number; output: number; cacheRead: number } | null;
  startedAt?: string;
  lastAt?: string;
  durationMs?: number;
  timeline: AgentTimelineEntry[];
  lastText?: string;
  error?: string;
}

/** A page of an agent's transcript (lazy, paginated). */
export interface TranscriptPage {
  agentId: string;
  lines: unknown[];
  nextCursor: string | null;
}

/** SSE live delta envelope (live phase). Patches node.data in place; structural changes re-layout. */
export interface RunDelta {
  runId: string;
  eventId: number;
  kind: 'agent-upsert' | 'agent-state' | 'log' | 'finalize';
  payload: unknown;
}
