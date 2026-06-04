// @argus/adapter — internal, format-aware zod schemas + projection helpers.
//
// THIS FILE IS THE ONLY PLACE THAT KNOWS THE RAW ON-DISK SHAPE.
//
// Defensive-parsing rules (boundaries.md §2.3) are encoded here:
//   - objects use `.passthrough()` so unknown/extra fields are tolerated (kept
//     internally) but NEVER emitted — the public RunModel is built by explicit
//     field projection in parseFinalizedRun (index.ts), never by spreading.
//   - scalar fields use `.catch(undefined)` so a wrong-typed/missing field never
//     throws. CRUCIALLY `index`/`phaseIndex` default to `undefined` (NOT 0): a
//     node with an unresolvable phaseIndex is dropped-with-warning, never dumped
//     into a phantom phase 0 (which would also fabricate a bogus 0->1 edge).
//   - parsing never throws: the top-level schema itself is `.catch({})`-guarded
//     by the caller, and every field is individually tolerant.

import { z } from 'zod';

/** The observed preview cap: a raw preview string of exactly this length is truncated. */
export const PREVIEW_TRUNCATED_RAW_LEN = 401;

/** Hard cap on emitted preview text (bytes-ish). Full result stays lazy (boundaries §2.3). */
export const PREVIEW_EMIT_CAP = 8 * 1024;

/** The internal-build cli.js bundle path that must never reach the client raw. */
const BUNFS_MARKER = '/$bunfs/';

// --- scalar tolerant helpers ----------------------------------------------

const optString = z.string().catch(undefined as unknown as string).optional();
const optNumber = z.number().catch(undefined as unknown as number).optional();
const optBool = z.boolean().catch(undefined as unknown as boolean).optional();

// `index`/`phaseIndex` MUST default to undefined, NOT 0 — see header. We only
// accept a finite number; anything else (string, NaN, missing) -> undefined.
const phaseIndexLike = z
  .number()
  .refine((n) => Number.isFinite(n))
  .catch(undefined as unknown as number)
  .optional();

// --- raw node schemas ------------------------------------------------------

/** A `workflow_agent` node inside `workflowProgress[]`. `.passthrough()` keeps unknown fields internal-only. */
export const RawAgentNodeSchema = z
  .object({
    type: z.literal('workflow_agent').catch('workflow_agent'),
    agentId: optString,
    index: phaseIndexLike,
    label: optString,
    phaseIndex: phaseIndexLike,
    phaseTitle: optString,
    model: optString,
    state: optString,
    cached: optBool,
    agentType: optString,
    attempt: optNumber,
    tokens: optNumber,
    toolCalls: optNumber,
    durationMs: optNumber,
    queuedAt: optNumber,
    startedAt: optNumber,
    lastProgressAt: optNumber,
    lastToolName: optString,
    lastToolSummary: optString,
    lastAttemptReason: optString,
    // previews are raw strings (or absent); makePreview applies the cap + heuristic.
    promptPreview: optString,
    resultPreview: optString,
  })
  .passthrough();

/** A `workflow_phase` node inside `workflowProgress[]`. */
export const RawPhaseNodeSchema = z
  .object({
    type: z.literal('workflow_phase').catch('workflow_phase'),
    index: phaseIndexLike, // 1-based; undefined if missing/garbled (NOT 0)
    title: optString,
  })
  .passthrough();

/** A `phases[]` entry (0-indexed array; provides `detail` enrichment). */
export const RawPhaseDetailSchema = z
  .object({
    title: optString,
    detail: optString,
  })
  .passthrough();

/**
 * A single `workflowProgress[]` element. We accept ANY object; the type
 * discriminator is read at projection time so an unknown `type` becomes a
 * counted warning rather than a parse failure.
 */
export const RawProgressNodeSchema = z.object({ type: optString }).passthrough();

/** Top-level finalized `wf_*.json`. Everything tolerant; unknown fields kept internal. */
export const RawRunSchema = z
  .object({
    runId: optString,
    workflowName: optString,
    status: optString,
    startTime: optNumber,
    timestamp: optString,
    durationMs: optNumber,
    defaultModel: optString,
    summary: optString,
    agentCount: optNumber,
    totalTokens: optNumber,
    totalToolCalls: optNumber,
    // args may be a JSON string, null, or anything; parsed defensively downstream.
    args: z.unknown().optional(),
    // error may be a string (failed/killed) or null/absent (completed).
    error: z.unknown().optional(),
    logs: z.array(z.unknown()).catch([]).optional(),
    phases: z.array(z.unknown()).catch([]).optional(),
    workflowProgress: z.array(z.unknown()).catch([]).optional(),
    // result / script / scriptPath are intentionally NOT projected into RunModel
    // (heavy / lazy / format-internal). We keep them tolerated, never emitted.
    result: z.unknown().optional(),
    script: z.unknown().optional(),
    scriptPath: z.unknown().optional(),
  })
  .passthrough();

export type RawRun = z.infer<typeof RawRunSchema>;
export type RawAgentNode = z.infer<typeof RawAgentNodeSchema>;
export type RawPhaseNode = z.infer<typeof RawPhaseNodeSchema>;

/** Parse top-level raw JSON to the tolerant internal shape. NEVER throws. */
export function parseRawRun(raw: unknown): RawRun {
  const r = RawRunSchema.safeParse(raw);
  return r.success ? r.data : ({} as RawRun);
}

// --- args -------------------------------------------------------------------

/**
 * Parse the raw `args` defensively (boundaries §2.3): a JSON string -> the parsed
 * value; `null`/absent -> null; an unparseable string -> the raw string (fallback).
 * NEVER throws.
 */
export function parseArgs(rawArgs: unknown): unknown {
  if (rawArgs === undefined || rawArgs === null) return null;
  if (typeof rawArgs === 'string') {
    const s = rawArgs;
    try {
      return JSON.parse(s);
    } catch {
      return s; // raw-string fallback
    }
  }
  // already an object/array/number/etc. — return as-is (still not spread anywhere).
  return rawArgs;
}

// --- error sanitization -----------------------------------------------------

export interface SanitizedError {
  message: string;
  internalDetail?: string;
}

/**
 * Split a raw `error` into `{ message, internalDetail }` (boundaries §2.3):
 *   - the human message is the first line (before the first stack frame).
 *   - the `/$bunfs/.../cli.js` stack frames go into `internalDetail` (collapsed,
 *     never rendered raw).
 * `null`/absent -> null (completed runs). NEVER throws.
 */
export function sanitizeError(rawError: unknown): SanitizedError | null {
  if (rawError === undefined || rawError === null) return null;
  const text = typeof rawError === 'string' ? rawError : String(rawError);
  if (text.length === 0) return null;

  const lines = text.split('\n');
  // The message is the leading run of non-stack-frame lines. A stack frame looks
  // like `    at <fn> (...)`. Everything from the first frame onward is internal.
  const isFrame = (l: string): boolean => /^\s*at\s/.test(l);
  let firstFrame = lines.findIndex(isFrame);
  if (firstFrame === -1) firstFrame = lines.length;

  const message = lines.slice(0, firstFrame).join('\n').trim() || 'Workflow error';
  const internal = lines.slice(firstFrame).join('\n').trim();

  const out: SanitizedError = { message };
  if (internal.length > 0) out.internalDetail = internal;
  return out;
}

/** True if any emitted-candidate text still carries an internal bundle/abs-path leak. */
export function leaksInternalPath(text: string): boolean {
  return text.includes(BUNFS_MARKER);
}

// --- previews ---------------------------------------------------------------

import type { Preview } from '@argus/contract';

/**
 * Build a capped Preview (boundaries §2.3):
 *   - `truncated` is true IFF the RAW length === PREVIEW_TRUNCATED_RAW_LEN (401).
 *   - an empty (len 0) preview is NOT truncated (empty result is a real signal).
 *   - emitted `text` is hard-capped at PREVIEW_EMIT_CAP; the full result stays
 *     lazy and is never inlined into the model.
 * Absent/non-string raw -> null. NEVER throws.
 */
export function makePreview(rawPreview: unknown): Preview | null {
  if (typeof rawPreview !== 'string') return null;
  const rawLen = rawPreview.length;
  const truncated = rawLen === PREVIEW_TRUNCATED_RAW_LEN; // len 0 => false
  const text = rawPreview.length > PREVIEW_EMIT_CAP ? rawPreview.slice(0, PREVIEW_EMIT_CAP) : rawPreview;
  return { text, truncated };
}

// --- state derivation -------------------------------------------------------

import type { AgentState, RunStatus } from '@argus/contract';

/** Map raw run `status` to the RunStatus enum; unknown -> 'completed' is wrong, so default conservatively. */
export function deriveRunStatus(rawStatus: unknown): RunStatus {
  switch (rawStatus) {
    case 'completed':
    case 'failed':
    case 'killed':
    case 'running':
      return rawStatus;
    default:
      // Unknown finalized status: it's finalized (we were given a wf_*.json), so
      // treat as completed-but-flagged via a warning at the call site.
      return 'completed';
  }
}

/**
 * Derive an AgentState from the raw agent `state` + the run-level status
 * (boundaries §3 "State derivation"):
 *   - raw 'done'      -> 'done'
 *   - raw 'progress'  -> 'running' normally, BUT 'interrupted' on a killed/failed
 *                        run (static, never a perpetual live pulse).
 *   - raw 'queued'    -> 'queued'
 *   - raw 'error'     -> 'error'
 *   - anything else   -> 'unknown' (neutral; never crash).
 */
export function deriveAgentState(rawState: unknown, runStatus: RunStatus): AgentState {
  const dead = runStatus === 'killed' || runStatus === 'failed';
  switch (rawState) {
    case 'done':
      return 'done';
    case 'progress':
    case 'running':
      return dead ? 'interrupted' : 'running';
    case 'queued':
      return 'queued';
    case 'error':
      return 'error';
    case 'interrupted':
      return 'interrupted';
    default:
      return 'unknown';
  }
}

// --- failure attribution ----------------------------------------------------

/**
 * Scan `logs[]` for `/failed/` lines (boundaries §3 "Failure attribution"). Returns
 * the verbatim failing lines for the run-level partialFailure badge. Reads logs
 * ONLY — `error` is handled separately. Non-string log entries are ignored.
 */
export function findFailureLogLines(logs: unknown[]): string[] {
  const out: string[] = [];
  for (const l of logs) {
    if (typeof l === 'string' && /failed/i.test(l)) out.push(l);
  }
  return out;
}

/**
 * An agent is `failedInLogs` ONLY on an EXACT label/agentId match inside a failing
 * line (boundaries §3): the agent's label or agentId must appear verbatim as a
 * token in the line. We never use started-vs-result counts (that's an interrupted
 * signal on killed runs, not a failure). Conservative: no slander.
 */
export function agentFailedInLogs(
  label: string | undefined,
  agentId: string | undefined,
  failureLines: string[],
): boolean {
  const candidates = [label, agentId].filter((s): s is string => typeof s === 'string' && s.length > 0);
  if (candidates.length === 0) return false;
  for (const line of failureLines) {
    for (const c of candidates) {
      // Exact token match: the identifier must appear as a whole word, not as an
      // incidental substring. `parallel[0] failed: agent({schema})` matches nothing.
      const re = new RegExp(`(?:^|[^\\w:-])${escapeRegExp(c)}(?:$|[^\\w:-])`);
      if (re.test(line)) return true;
    }
  }
  return false;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
