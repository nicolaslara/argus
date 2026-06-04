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
  /** Lazy, best-effort. */
  clientVersion?: string;
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
