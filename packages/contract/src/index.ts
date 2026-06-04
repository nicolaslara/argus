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
