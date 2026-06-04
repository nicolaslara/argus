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
} from '@argus/contract';
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

/** Observed-format pin. The "tested on" client version (best-effort) is resolved lazily. */
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
  clientVersion?: string;
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
  if (ctx.clientVersion !== undefined) model.clientVersion = ctx.clientVersion;
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

/** Discover projects under a claude home. (M2) */
export function discoverProjects(_port: FileSystemPort, _claudeHome: string): Promise<ProjectRef[]> {
  throw new Error('discoverProjects: not implemented until prototype M2');
}

/** List a project's runs (header fields only; zero transcript I/O). (M2) */
export function discoverRuns(_port: FileSystemPort, _project: ProjectRef): Promise<RunSummary[]> {
  throw new Error('discoverRuns: not implemented until prototype M2');
}
