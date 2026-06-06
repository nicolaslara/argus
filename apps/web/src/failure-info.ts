// STEP 3 — the run FAILURE ANALYSIS, extracted from App.tsx so the three pure helpers that
// power the failure banner + the red failure-point ring + the objective "called on <args>"
// line are unit-testable in isolation (no React, no DOM). Behavior is byte-identical to the
// inline App functions; only their HOME moved.

import type { AgentNode, RunModel } from '@argus/contract';

/**
 * The failure point: the run agent/step that ended WITHOUT a terminal result on a failed run.
 * The adapter already normalizes a started-without-result agent on a failed/killed run to
 * `interrupted` (and a genuine error to `error`), and the overlay already excludes both from
 * the done count — so this is purely the BANNER's attribution + the red failure-point ring.
 * We pick the LAST-STARTED dead agent (design §6 Q3: the proximate failure point), and surface
 * every dead agentId so the matching instance card reads as a failure point (not just amber).
 */
export interface FailureInfo {
  message: string;
  internalDetail: string | null;
  /** A human label for the failing step/agent (the prompt-derived label, else the id), or null. */
  failingLabel: string | null;
  failingAgentId: string | null;
  /** elapsed-to-failure, ms (run.durationMs), or null when timing is unknown. */
  elapsedMs: number | null;
  /** Every dead agentId — the cards that should read as a failure point. */
  failureAgentIds: Set<string>;
}

/**
 * Derive the failure banner content for a run, or null when the run did not fail. A run is
 * "failed" when status==='failed' OR it carries a non-null `error` (the adapter only keeps
 * `error` for a non-completed run). Defensive: an absent message degrades to a generic line,
 * never an empty banner.
 */
export function deriveFailureInfo(run: RunModel | undefined): FailureInfo | null {
  if (!run) return null;
  const failed = run.status === 'failed' || run.error != null;
  if (!failed) return null;

  // A dead agent = a terminal failure state (the adapter maps started-without-result on a
  // failed run → 'interrupted', a real error → 'error'). Both read as the failure point.
  const dead = run.agents.filter((a) => a.state === 'error' || a.state === 'interrupted');
  // FALLBACK: a run can fail at the WORKFLOW level (e.g. a subagent finished its work but never
  // called StructuredOutput) with EVERY agent still recorded 'done' in the finalized tree — the
  // error is real but unattributed. Then pin the proximate point to the LAST-STARTED agent
  // (where the run stopped progressing) so "where" is never blank on a failed run.
  const pointAgents = dead.length > 0 ? dead : run.agents;
  const point = pickFailurePoint(pointAgents);
  const failureAgentIds = new Set(
    dead.length > 0 ? dead.map((a) => a.agentId) : point ? [point.agentId] : [],
  );

  return {
    message: run.error?.message ?? 'this run ended in failure',
    internalDetail: run.error?.internalDetail ?? null,
    failingLabel: point ? point.label || point.agentId : null,
    failingAgentId: point?.agentId ?? null,
    elapsedMs: run.durationMs,
    failureAgentIds,
  };
}

/** The proximate failure point: the dead agent with the latest start (else the last listed). */
export function pickFailurePoint(dead: AgentNode[]): AgentNode | null {
  if (dead.length === 0) return null;
  let best = dead[0]!;
  for (const a of dead) {
    const at = a.startedAt ?? a.queuedAt ?? null;
    const bestAt = best.startedAt ?? best.queuedAt ?? null;
    if (at != null && (bestAt == null || at >= bestAt)) best = a;
  }
  return best;
}

/** A compact, readable summary of a run's `args` (what data it was called on). Object →
 * key: value rows; array → "N items: …"; string → the string; null/empty → null. */
export function formatArgs(args: unknown): string | null {
  if (args == null) return null;
  if (typeof args === 'string') return args.length > 160 ? `${args.slice(0, 160)}…` : args;
  if (typeof args === 'number' || typeof args === 'boolean') return String(args);
  if (Array.isArray(args)) {
    if (args.length === 0) return null;
    const head = args.slice(0, 4).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ');
    return `${args.length} item${args.length === 1 ? '' : 's'}: ${head}${args.length > 4 ? ', …' : ''}`;
  }
  if (typeof args === 'object') {
    const entries = Object.entries(args as Record<string, unknown>);
    if (entries.length === 0) return null;
    return entries
      .slice(0, 5)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' · ');
  }
  return null;
}
