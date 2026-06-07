// @argus/adapter — the ONLY module that knows the raw on-disk Claude Code workflow
// format. Everything downstream consumes @argus/contract types. Disk access goes
// through an injected FileSystemPort (no direct node:fs import) so this package can
// later run in a Tauri sidecar / browser / remote host. See boundaries.md §2.

import type {
  RunModel,
  RunSummary,
  ProjectRef,
  RunRef,
  Phase,
  PhaseEdge,
  AgentNode,
  AdapterWarning,
  WorkflowMeta,
  PlanModel,
} from '@argus/contract';
import { parsePlan } from './plan.ts';
export { parsePlan };
import { buildLiveModel } from './live.ts';
import {
  discoverProjectsReport,
  discoverRunsReport,
  discoverWorkflowMetasReport,
  type DiscoveryReport,
} from './discovery.ts';
import {
  RawAgentNodeSchema,
  RawPhaseNodeSchema,
  RawPhaseDetailSchema,
  parseRawRun,
  parseArgs,
  sanitizeError,
  makePreview,
  deriveRunStatus,
  deriveAgentState,
  findFailureLogLines,
  agentFailedInLogs,
} from './raw.ts';

/** Re-export the observed preview-cap constants for callers/tests. */
export { PREVIEW_TRUNCATED_RAW_LEN, PREVIEW_EMIT_CAP } from './raw.ts';
/** Re-export the internal-path redactor so the server can guard the lazy full-result emit too. */
export { redactInternalPaths } from './raw.ts';

/**
 * Narrative redaction SEAM: the single text→text chokepoint every emitted narrative path
 * routes through (noop identity today; a one-line strategy swap installs a real redactor later
 * with zero call-site changes). See `./redact.ts`.
 */
export { redact, setRedactionStrategy, resetRedactionStrategy, noopRedactionStrategy } from './redact.ts';
export type { RedactionStrategy } from './redact.ts';

/**
 * Session Narrative ("Story" view) engine: defensive transcript scan + real-prompt
 * segmentation (single-pass O(n)) + head/tail-bounded, redact()-routed previews. The ONLY
 * module that knows the raw `<sessionId>.jsonl` transcript shape. See `./transcript.ts`.
 */
export {
  scanTranscript,
  projectText,
  isRealUserPrompt,
  extractWorkflowSpawns,
  boundedPreview,
  segmentTranscript,
  buildSessionNarrative,
  loadSessionNarrative,
  summarizeScannedSession,
  discoverSessions,
  loadBlockTurns,
  blockTurns,
  NARRATIVE_FORMAT_ENGINE,
  MAX_LINE_BYTES,
  RESPONSE_HEADTAIL,
  PROMPT_HEADTAIL,
  TURN_TEXT_HEADTAIL,
} from './transcript.ts';
export type { ScannedTranscript, ProjectedText, SegmentOptions } from './transcript.ts';

/** Live path (L1/L2): journal parsing, running-run detection, partial live RunModel. */
export {
  parseJournal,
  reduceJournal,
  classifyRunLiveness,
  planExpectedSlots,
  buildLiveModel,
  agentResultFromJournal,
} from './live.ts';
export type { JournalEvent, ParsedJournal, RunLiveness, LivenessInput, LiveModelOptions } from './live.ts';
export { discoverRunningRunsReport } from './discovery.ts';
/** Failure-cause classification (infra socket/limit/overload vs a genuine schema-validation fault). */
export { classifyFailureText, transcriptTail } from './failure-classify.ts';

/** Transcript path: per-agent activity (tokens/tools/timing/last-activity) from agent-<id>.jsonl. */
export { agentActivityFromTranscript, agentActivityFromDir, ACTIVITY_TIMELINE_CAP } from './activity.ts';

/** Observed-format pin. Stamped onto every model + reported on /health (boundaries §9). */
export const ADAPTER_FORMAT = 'cc-workflow/observed-2026-06-04' as const;

/** Injected filesystem seam. The node implementation lives in apps/server. */
export interface FileSystemPort {
  readFile(path: string): Promise<string>;
  readJson(path: string): Promise<unknown>;
  listDir(path: string): Promise<Array<{ name: string; isDir: boolean }>>;
  stat(path: string): Promise<{ size: number; mtimeMs: number } | null>;
  exists(path: string): Promise<boolean>;
  /** Returns an unwatch function. The node impl is chokidar-backed. */
  watch(path: string, onEvent: (event: { path: string; type: string }) => void): () => void;
}

/**
 * Derive the on-disk project-slug from an absolute cwd: every non-alphanumeric
 * character becomes "-". Verified rule (boundaries.md §0):
 *   /Users/nicolas/devel/modal-rust   -> -Users-nicolas-devel-modal-rust
 *   /Users/nicolas/.config/ghostty    -> -Users-nicolas--config-ghostty
 * NOTE: lossy and collision-prone — use recoverProjectPath() for the authoritative key.
 */
export function deriveSlug(absCwd: string): string {
  return absCwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Recover the authoritative absolute project path from a run's persisted `scriptPath`
 * (e.g. /Users/nicolas/devel/modal-rust/.claude/workflows/plan-research.js ->
 * /Users/nicolas/devel/modal-rust). Strips the trailing `.claude/workflows/<file>`.
 * Returns null if the path doesn't contain that segment. No transcript I/O.
 */
export function recoverProjectPath(scriptPath: string): string | null {
  const m = scriptPath.split(/[/\\]\.claude[/\\]workflows[/\\]/);
  return m.length > 1 ? m[0]! : null;
}

// --- Parsing surface (implemented in prototype M1+; declared here as the contract). ---

export interface AdapterContext {
  ref: RunRef;
}

/**
 * Parse a finalized `wf_*.json` into the normalized, emit-allowlisted `RunModel`.
 * PURE — no I/O, no `node:fs`. All raw-format knowledge stays in `./raw.ts`.
 *
 * The model is built by EXPLICIT field projection (never by spreading parsed JSON),
 * so a future secret-bearing field cannot ride to the client (boundaries §2.3).
 * Defensive throughout: tolerates unknown/missing fields, partial/killed runs, huge
 * results (capped previews + lazy full result). Never throws on malformed input.
 */
export function parseFinalizedRun(raw: unknown, ctx: AdapterContext): RunModel {
  const warnings: AdapterWarning[] = [];
  const r = parseRawRun(raw);

  // --- run-level scalars (explicit projection) ---
  const rawStatus = r.status;
  const status = deriveRunStatus(rawStatus);
  if (
    rawStatus !== 'completed' &&
    rawStatus !== 'failed' &&
    rawStatus !== 'killed' &&
    rawStatus !== 'running' &&
    rawStatus !== undefined
  ) {
    warnings.push({ code: 'unknown-run-status' });
  }

  const logs: string[] = (r.logs ?? []).filter((l): l is string => typeof l === 'string');
  const failureLines = findFailureLogLines(logs);

  // --- phase join: workflow_phase nodes (1-based index) enriched by phases[] (0-indexed) via index-1 ---
  const rawProgress: unknown[] = r.workflowProgress ?? [];
  const rawPhaseDetails = (r.phases ?? []).map((p) => RawPhaseDetailSchema.safeParse(p));

  const phases: Phase[] = [];
  const validPhaseIndices = new Set<number>();
  let unresolvablePhaseNodes = 0;

  for (const node of rawProgress) {
    if (!node || typeof node !== 'object' || (node as { type?: unknown }).type !== 'workflow_phase') {
      continue;
    }
    const parsed = RawPhaseNodeSchema.safeParse(node);
    const p = parsed.success ? parsed.data : undefined;
    const idx = p?.index;
    // Unresolvable phaseIndex => drop-with-warning. No phantom phase 0.
    if (idx === undefined || !Number.isInteger(idx) || idx < 1) {
      unresolvablePhaseNodes += 1;
      continue;
    }
    // Enrich detail from phases[index-1] (0-indexed). Out-of-range => null + a length-mismatch warning later.
    const detailEntry = idx - 1 >= 0 && idx - 1 < rawPhaseDetails.length ? rawPhaseDetails[idx - 1] : undefined;
    const detail =
      detailEntry && detailEntry.success && typeof detailEntry.data.detail === 'string'
        ? detailEntry.data.detail
        : null;
    phases.push({ index: idx, title: p?.title ?? `Phase ${idx}`, detail });
    validPhaseIndices.add(idx);
  }
  phases.sort((a, b) => a.index - b.index);

  if (unresolvablePhaseNodes > 0) {
    warnings.push({ code: 'phase-node-dropped-unresolvable-index', detail: String(unresolvablePhaseNodes) });
  }
  // Length mismatch between workflow_phase nodes and phases[] detail array.
  if (phases.length !== rawPhaseDetails.length) {
    warnings.push({ code: 'phase-detail-length-mismatch' });
  }

  // --- agents (explicit projection; drop unresolvable phaseIndex with a counted warning) ---
  const agents: AgentNode[] = [];
  let unresolvableAgentNodes = 0;
  let unknownAgentStates = 0;

  for (const node of rawProgress) {
    if (!node || typeof node !== 'object') continue;
    const t = (node as { type?: unknown }).type;
    if (t === 'workflow_phase') continue;
    if (t !== 'workflow_agent') {
      warnings.push({ code: 'unknown-progress-node-type' });
      continue;
    }
    const parsed = RawAgentNodeSchema.safeParse(node);
    if (!parsed.success) {
      warnings.push({ code: 'agent-node-unparseable' });
      continue;
    }
    const a = parsed.data;
    const phaseIndex = a.phaseIndex;
    // Drop agents whose phaseIndex is unresolvable OR points at a phase we dropped.
    if (phaseIndex === undefined || !validPhaseIndices.has(phaseIndex)) {
      unresolvableAgentNodes += 1;
      continue;
    }
    const state = deriveAgentState(a.state, status);
    if (state === 'unknown' && a.state !== undefined) unknownAgentStates += 1;

    agents.push({
      agentId: a.agentId ?? '',
      index: typeof a.index === 'number' ? a.index : 0,
      label: a.label ?? '',
      phaseIndex,
      model: a.model ?? null,
      state,
      cached: a.cached === true,
      agentType: a.agentType ?? null,
      attempt: typeof a.attempt === 'number' ? a.attempt : null,
      failedInLogs: agentFailedInLogs(a.label, a.agentId, failureLines),
      tokens: typeof a.tokens === 'number' ? a.tokens : null, // 0 preserved
      toolCalls: typeof a.toolCalls === 'number' ? a.toolCalls : null,
      durationMs: typeof a.durationMs === 'number' ? a.durationMs : null,
      queuedAt: typeof a.queuedAt === 'number' ? a.queuedAt : null,
      startedAt: typeof a.startedAt === 'number' ? a.startedAt : null,
      lastProgressAt: typeof a.lastProgressAt === 'number' ? a.lastProgressAt : null,
      lastToolName: a.lastToolName ?? null,
      lastToolSummary: a.lastToolSummary ?? null,
      promptPreview: makePreview(a.promptPreview),
      resultPreview: makePreview(a.resultPreview),
    });
  }
  // Group by phaseIndex, ordered by index (boundaries §3).
  agents.sort((x, y) => (x.phaseIndex - y.phaseIndex) || (x.index - y.index));

  if (unresolvableAgentNodes > 0) {
    warnings.push({ code: 'agent-node-dropped-unresolvable-phaseindex', detail: String(unresolvableAgentNodes) });
  }
  if (unknownAgentStates > 0) {
    warnings.push({ code: 'unknown-agent-state', detail: String(unknownAgentStates) });
  }

  // --- edges: synthesize phase_i -> phase_i+1 ONLY (no agent-level edges, no 0->1) ---
  const edges: PhaseEdge[] = [];
  for (let i = 0; i < phases.length - 1; i += 1) {
    const from = phases[i]!.index;
    const to = phases[i + 1]!.index;
    edges.push({ from, to });
  }

  // --- error: sanitize (bunfs stack hidden in internalDetail; completed => null) ---
  const error = status === 'completed' && !r.error ? null : sanitizeError(r.error);

  const model: RunModel = {
    ref: ctx.ref,
    workflowName: r.workflowName ?? '',
    status,
    incomplete: false, // finalized wf_*.json
    startTime: typeof r.startTime === 'number' ? r.startTime : null,
    durationMs: typeof r.durationMs === 'number' ? r.durationMs : null,
    defaultModel: r.defaultModel ?? null,
    summary: r.summary ?? '',
    phases,
    agents,
    edges,
    logs,
    partialFailure: { present: failureLines.length > 0, lines: failureLines },
    error,
    args: parseArgs(r.args),
    warnings,
    format: ADAPTER_FORMAT,
    // Full `result`, `script`, `scriptPath` intentionally NOT inlined (lazy only).
  };
  return model;
}

/**
 * Read a finalized `wf_*.json` THROUGH the injected FileSystemPort and normalize it
 * via {@link parseFinalizedRun}. This is the only seam through which the adapter
 * touches disk — it NEVER imports `node:fs` (proven by the port contract test).
 *
 * `wfJsonPath` is the absolute path to the run's finalized `wf_<id>.json`; the
 * caller (server M2) builds it from a `RunRef`. M1 ships this minimal reader so the
 * port can be exercised end-to-end. Live/torn handling lands in the live phase.
 */
export async function loadRun(
  port: FileSystemPort,
  wfJsonPath: string,
  ctx: AdapterContext,
): Promise<RunModel> {
  const raw = await port.readJson(wfJsonPath);
  return parseFinalizedRun(raw, ctx);
}

/**
 * Read a run's LIVE `journal.jsonl` THROUGH the injected FileSystemPort and build a
 * partial live {@link RunModel} (L2). `journalPath` is the absolute path to
 * `<session>/subagents/workflows/<runId>/journal.jsonl`; the caller (server) builds it
 * from a RunRef and path-escape-guards it. `opts.plan` (parsed from the persisted script
 * via {@link loadRunPlan}) recovers labels/phases by start-order binding (F4). A read
 * failure propagates (the route maps it to 404). Disk-only via the port (no node:fs).
 */
export async function loadLiveModel(
  port: FileSystemPort,
  journalPath: string,
  ref: RunRef,
  opts: import('./live.ts').LiveModelOptions = {},
): Promise<RunModel> {
  const text = await port.readFile(journalPath);
  return buildLiveModel(text, ref, opts);
}

/**
 * Read a workflow `.js` SOURCE through the injected FileSystemPort (the lazy
 * "view source" surface — the script is NOT in the default RunModel). `jsPath` is the
 * absolute path to `<project>/.claude/workflows/<file>.js`; the caller (server)
 * path-escape-guards it first. Disk-only via the port (no node:fs). Built BEFORE
 * loadPlan, which depends on it (plan-view-design.md §2.2 review fix). May throw on a
 * hard read error; the route layer maps that to a 404, never a 500/leak.
 */
export async function loadWorkflowSource(port: FileSystemPort, jsPath: string): Promise<string> {
  return port.readFile(jsPath);
}

/**
 * Read a workflow `.js` source THROUGH the port and parse it into a PlanModel (P1,
 * run-free). LAZY: depends on {@link loadWorkflowSource}. `parsePlan` is PURE and never
 * throws; a read failure here propagates (the route maps it to 404). The PlanModel is a
 * SIBLING of RunModel — this path never touches a run journal.
 */
export async function loadPlan(port: FileSystemPort, jsPath: string, file = ''): Promise<PlanModel> {
  const source = await loadWorkflowSource(port, jsPath);
  return parsePlan(source, file || jsPath);
}

/**
 * Recover the PER-RUN persisted workflow script basename for a run (P2). Claude Code
 * persists the EXACT script a run executed at
 *   `<claudeHome>/projects/<slug>/<session>/workflows/scripts/<name>-wf_<id>.js`
 * (the cache-shape (2) path under the session dir — see discovery's recoverFromScriptPath).
 * This is the AUTHORITATIVE per-run plan source: the project `.claude/workflows/*.js` may
 * have drifted since the run, but the persisted script is what actually ran.
 *
 * We derive the basename from the run header's `scriptPath` when it is itself a safe `.js`
 * basename under `.../workflows/scripts/`; else we fall back to the deterministic
 * `<workflowName>-<runId>.js` shape. Returns ONLY the basename (path-building/charset
 * validation is the caller's/route's job — boundaries.md §4). No format knowledge beyond
 * this path recovery; PURE; never throws.
 */
export function perRunScriptBasename(
  header: unknown,
  runId: string,
): string | null {
  const o = header && typeof header === 'object' ? (header as Record<string, unknown>) : {};
  const scriptPath = typeof o.scriptPath === 'string' ? o.scriptPath : undefined;
  // Prefer the persisted scriptPath's basename when it is the per-run cache shape.
  if (scriptPath && /[/\\]workflows[/\\]scripts[/\\][^/\\]+\.js$/.test(scriptPath)) {
    const base = scriptPath.split(/[/\\]/).pop();
    if (base && base.endsWith('.js')) return base;
  }
  // Fall back to the deterministic `<workflowName>-<runId>.js` shape.
  const workflowName = typeof o.workflowName === 'string' ? o.workflowName : undefined;
  if (workflowName) return `${workflowName}-${runId}.js`;
  return null;
}

/**
 * Read a run's PER-RUN persisted script THROUGH the port and parse it into a PlanModel
 * (P2). `scriptsJsPath` is the absolute path to the persisted
 * `<session>/workflows/scripts/<name>-wf_<id>.js`; the caller (server) charset- +
 * resolve()-guards it first. Reuses the PURE {@link parsePlan} — no new format knowledge.
 * A read failure propagates (the route maps it to 404). The PlanModel is a SIBLING of
 * RunModel — this never re-reads the run journal.
 */
export async function loadRunPlan(
  port: FileSystemPort,
  scriptsJsPath: string,
  file = '',
): Promise<PlanModel> {
  return loadPlan(port, scriptsJsPath, file);
}

/** The default claude home in production. The adapter never reads env itself. */
export const DEFAULT_CLAUDE_HOME = '/Users/nicolas/.claude';

/** Re-export discovery helpers (all node:fs-free; disk via the injected port). */
export { parseWorkflowMeta } from './discovery.ts';
export type { DiscoveryReport } from './discovery.ts';

/**
 * Discover a claude home's projects, keyed/de-duped by the AUTHORITATIVE recovered
 * absolute `projectPath` (not the lossy slug). Reads each run's HEADER only (for its
 * `scriptPath`); zero transcript / workflowProgress I/O; all disk via the injected
 * port. NEVER throws — a bogus/missing path yields `[]` (see {@link discoverProjectsWithReason}).
 */
export async function discoverProjects(port: FileSystemPort, claudeHome: string): Promise<ProjectRef[]> {
  return (await discoverProjectsReport(port, claudeHome)).items;
}

/** Report variant: `{ items, reasons }` so a bogus/missing path is observable, not silent. */
export function discoverProjectsWithReason(
  port: FileSystemPort,
  claudeHome: string,
): Promise<DiscoveryReport<ProjectRef>> {
  return discoverProjectsReport(port, claudeHome);
}

/**
 * List a project's runs — HEADER fields ONLY (workflowName/status/agentCount/
 * durationMs/startTime/summary + partialFailure from a logs[] /failed/ scan). Does
 * NOT walk `workflowProgress` or any transcript (zero per-agent I/O). Runs are keyed
 * by the recovered authoritative `projectPath` and filtered to this project, so a
 * slug collision splits runs across the matching ProjectRefs. NEVER throws.
 *
 * `claudeHome` defaults to the production home; the server/tests pass it explicitly.
 */
export async function discoverRuns(
  port: FileSystemPort,
  project: ProjectRef,
  claudeHome: string = DEFAULT_CLAUDE_HOME,
): Promise<RunSummary[]> {
  return (await discoverRunsReport(port, claudeHome, project)).items;
}

/** Report variant of {@link discoverRuns}. */
export function discoverRunsWithReason(
  port: FileSystemPort,
  project: ProjectRef,
  claudeHome: string = DEFAULT_CLAUDE_HOME,
): Promise<DiscoveryReport<RunSummary>> {
  return discoverRunsReport(port, claudeHome, project);
}

/**
 * List the static workflow definitions under `<projectPath>/.claude/workflows/*.js`
 * via {@link parseWorkflowMeta} — the "available workflows without a run" view. An
 * unparseable file is dropped (never a crash); a missing dir returns `[]`. NEVER throws.
 */
export async function discoverWorkflowMetas(port: FileSystemPort, projectPath: string): Promise<WorkflowMeta[]> {
  return (await discoverWorkflowMetasReport(port, projectPath)).items;
}

/** Report variant of {@link discoverWorkflowMetas}. */
export function discoverWorkflowMetasWithReason(
  port: FileSystemPort,
  projectPath: string,
): Promise<DiscoveryReport<WorkflowMeta>> {
  return discoverWorkflowMetasReport(port, projectPath);
}
