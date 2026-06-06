// @argus/web — the PURE sort/filter lens for the AGENT TABLE (the at-scale scanning surface
// for a selected run; roadmap "Table panel"). No React, no I/O, contract-only: it reads the
// already-normalized RunModel.agents (AgentNode[]) + RunModel.phases and returns NEW arrays
// (the inputs are never mutated). Extracted here so the table component is a thin renderer and
// every ordering rule is unit-testable without the DOM.
//
// Boundaries: this never re-derives a metric — it sorts/filters the journal scalars the adapter
// already produced. tokens=0 and tokens=null are BOTH treated as "no value" for ordering (a
// 0-token agent has nothing to compare on the cost axis), mirroring the card's em-dash rule.

import type { AgentNode, AgentState, Phase } from '@argus/contract';

/**
 * The sortable columns. RESULT preview is inline-only (not sortable) → not a key here.
 *
 * `order` is a DAG MODE, not a metric sort: it ignores `direction` and groups the agents by
 * phase (the sequential spine), indenting each phase's agents (the parallel members) under a
 * phase header. The renderer special-cases it (calls `orderAgentsByExecution`, not `sortAgents`).
 */
export type SortKey =
  | 'order'
  | 'label'
  | 'phase'
  | 'state'
  | 'model'
  | 'tokens'
  | 'duration'
  | 'toolCalls'
  | 'failure';

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  key: SortKey;
  direction: SortDirection;
}

export const SORT_KEYS: readonly SortKey[] = [
  'order',
  'label',
  'phase',
  'state',
  'model',
  'tokens',
  'duration',
  'toolCalls',
  'failure',
] as const;

/**
 * The fixed STATE order, success-first. `asc` reads top→down in this order (done first);
 * `desc` reverses it (failures float to the top — the common "what broke?" scan). Any state
 * not in the map sorts after the known ones (defensive, should never happen for the enum).
 */
export const STATE_ORDER: Record<AgentState, number> = {
  done: 0,
  running: 1,
  queued: 2,
  error: 3,
  interrupted: 4,
  unknown: 5,
};

/**
 * The DEFAULT sort: the most useful at-scale scan is "what cost the most / took the longest" —
 * so the table opens on tokens, descending (the biggest spender first). Falls back gracefully
 * (nulls/0 last) so a metric-starved live run still reads sensibly.
 */
export const DEFAULT_SORT: SortState = { key: 'tokens', direction: 'desc' };

/** A failure is the same signal the card POPs red on: a terminal error OR a logs-confirmed fail. */
export function isFailure(agent: AgentNode): boolean {
  return agent.state === 'error' || agent.failedInLogs;
}

/** Resolve a 1-based phaseIndex to its declared Phase.title (for filter matching + display). */
export function phaseTitleOf(agent: AgentNode, phases: Phase[] | undefined): string | null {
  if (!phases) return null;
  return phases.find((p) => p.index === agent.phaseIndex)?.title ?? null;
}

/** A non-empty display label for the agent (the same fallback chain the card/instance use). */
function labelOf(agent: AgentNode): string {
  return agent.label || agent.agentId || '';
}

/**
 * Numeric comparator value for a metric: a present, non-zero, finite number sorts by value;
 * null / 0 / non-finite collapse to `null` (sorted LAST regardless of direction). This keeps
 * "no data" agents pinned to the bottom whether you sort ascending or descending — they never
 * masquerade as the smallest (asc) or largest (desc) real value.
 */
function metricValue(v: number | null): number | null {
  if (v == null || !Number.isFinite(v) || v === 0) return null;
  return v;
}

/**
 * Compare two possibly-null numbers with nulls ALWAYS last. Returns the asc-order delta; the
 * caller applies direction by negating, but null-last is preserved (we never negate a null
 * push). Equal/both-null → 0 (the stable tie-break in `sortAgents` then preserves input order).
 */
function compareNumberNullLast(a: number | null, b: number | null, direction: SortDirection): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1; // a after b — always last, regardless of direction
  if (b == null) return -1; // b after a
  const delta = a - b;
  return direction === 'asc' ? delta : -delta;
}

/** Compare two possibly-empty strings (case-insensitive), empties ALWAYS last. */
function compareStringNullLast(a: string, b: string, direction: SortDirection): number {
  const ea = a.trim().length === 0;
  const eb = b.trim().length === 0;
  if (ea && eb) return 0;
  if (ea) return 1;
  if (eb) return -1;
  const delta = a.toLowerCase().localeCompare(b.toLowerCase());
  return direction === 'asc' ? delta : -delta;
}

/**
 * Sort agents by a column + direction. Returns a NEW array; the input is never mutated. The
 * sort is STABLE (every comparator falls through to the original index on a tie), so equal
 * rows keep their adapter order (phaseIndex→index). `phases` is optional and only used to keep
 * the signature uniform with `filterAgents`; phase sorting uses the numeric phaseIndex directly
 * (ties broken by agent.index, then input order).
 */
export function sortAgents(
  agents: AgentNode[],
  key: SortKey,
  direction: SortDirection,
  _phases?: Phase[],
): AgentNode[] {
  // Decorate with the original index so the comparator can fall through to a STABLE tie-break
  // (Array.prototype.sort is spec-stable in modern engines, but the explicit index makes the
  // intent — and the tests — independent of that guarantee).
  const decorated = agents.map((agent, index) => ({ agent, index }));
  decorated.sort((a, b) => {
    const primary = compareBy(a.agent, b.agent, key, direction);
    if (primary !== 0) return primary;
    return a.index - b.index; // stable: preserve adapter order on a tie
  });
  return decorated.map((d) => d.agent);
}

function compareBy(a: AgentNode, b: AgentNode, key: SortKey, direction: SortDirection): number {
  switch (key) {
    case 'label':
      return compareStringNullLast(labelOf(a), labelOf(b), direction);
    case 'model':
      return compareStringNullLast(a.model ?? '', b.model ?? '', direction);
    case 'tokens':
      return compareNumberNullLast(metricValue(a.tokens), metricValue(b.tokens), direction);
    case 'duration':
      return compareNumberNullLast(metricValue(a.durationMs), metricValue(b.durationMs), direction);
    case 'toolCalls':
      return compareNumberNullLast(metricValue(a.toolCalls), metricValue(b.toolCalls), direction);
    case 'phase': {
      // Numeric 1→2→3; ties broken by the agent's own index (its order within the phase).
      const delta = a.phaseIndex - b.phaseIndex || a.index - b.index;
      return direction === 'asc' ? delta : -delta;
    }
    case 'state': {
      // Fixed enum order (success-first). Unknown states sort after the known ones.
      const oa = STATE_ORDER[a.state] ?? Number.MAX_SAFE_INTEGER;
      const ob = STATE_ORDER[b.state] ?? Number.MAX_SAFE_INTEGER;
      const delta = oa - ob;
      return direction === 'asc' ? delta : -delta;
    }
    case 'failure': {
      // Boolean: asc → failures first (true before false); desc → failures last.
      const fa = isFailure(a) ? 0 : 1;
      const fb = isFailure(b) ? 0 : 1;
      const delta = fa - fb;
      return direction === 'asc' ? delta : -delta;
    }
    default:
      return 0;
  }
}

/**
 * Case-insensitive substring filter over an agent's LABEL, its PHASE TITLE (resolved via
 * `phases`), its MODEL, and its STATE. Returns a NEW array; an empty/whitespace query is a
 * no-op (returns the input unchanged, by reference, so a non-filtering render is allocation-
 * free). State matches as a plain substring of the state word too ('err' matches 'error') —
 * a forgiving scan filter, not an exact-enum match.
 */
export function filterAgents(agents: AgentNode[], query: string, phases?: Phase[]): AgentNode[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return agents;
  return agents.filter((agent) => {
    const haystacks = [
      labelOf(agent),
      phaseTitleOf(agent, phases) ?? '',
      agent.model ?? '',
      agent.state,
    ];
    return haystacks.some((h) => h.toLowerCase().includes(q));
  });
}

// --- EXECUTION-ORDER (DAG) view ---------------------------------------------------------------
// The "order" mode reveals the run's DAG STRUCTURE rather than a metric ranking. The run is
// strictly layered: phases run SEQUENTIALLY (phase 1 → 2 → 3, the spine), and agents WITHIN a
// phase run in PARALLEL (ordered only by the adapter's stable discovery `index` — NOT wall-clock
// start). `orderAgentsByExecution` flattens that into rows the table renders as phase headers
// (depth 0) each followed by their agents (depth 1, indented). Like sortAgents/filterAgents it is
// PURE: a NEW array, inputs never mutated, ties fall back to input order.

/**
 * One row of the execution-order view. The discriminator is `isPhaseHeader`:
 *   - header row → `{ isPhaseHeader: true, depth: 0, phase, agentCountInPhase }` (no `agent`)
 *   - agent row  → `{ agent, depth: 1 }`                                          (no `phase`)
 * Consumers MUST check `isPhaseHeader` before reading `phase`/`agentCountInPhase` or `agent`
 * (TypeScript will not auto-narrow these optionals without that guard).
 */
export interface ExecutionOrderRow {
  /** Present iff this is an agent row; the agent to render (indented under its phase header). */
  agent?: AgentNode;
  /** Nesting depth: 0 for phase headers, 1 for the agents within a phase. */
  depth: number;
  /** True iff this row is a phase-grouping header, not an agent. */
  isPhaseHeader?: boolean;
  /** Present iff `isPhaseHeader`; the phase this header groups (synthetic for an unresolved bucket). */
  phase?: Phase;
  /** Present iff `isPhaseHeader`; the count of agents grouped under this header. */
  agentCountInPhase?: number;
}

/**
 * Order agents by execution STRUCTURE: phases in sequence, agents within a phase in parallel
 * (indented). Returns a flat `ExecutionOrderRow[]` for table rendering — a phase header (depth 0)
 * followed by its agents (depth 1) for each phase, in phase-index order.
 *
 * Rules (mirroring sortAgents' purity + stability):
 *   - PURE: returns a NEW array; never mutates `agents` or `phases`.
 *   - Phases are emitted in ascending `phase.index` order (sorted DEFENSIVELY here — the adapter
 *     guarantees RunModel.phases is ordered, but we don't rely on it).
 *   - A phase with NO bound agents is SKIPPED (no empty header).
 *   - Within a phase, agents are sorted by `agent.index` ascending; ties keep input order (stable).
 *   - An agent whose `phaseIndex` has no declared `Phase` is grouped under a SYNTHETIC header
 *     (`{ index, title: 'phase N' }`); these unresolved buckets sort after the declared phases.
 *   - `phases === undefined` (or empty) → all agents under ONE synthetic `{ index: 0, title:
 *     'agents' }` header (sorted by index). An empty `agents` array returns `[]` (no header).
 */
export function orderAgentsByExecution(
  agents: AgentNode[],
  phases: Phase[] | undefined,
): ExecutionOrderRow[] {
  if (agents.length === 0) return [];

  // No declared phases → one synthetic "agents" bucket holding everything (sorted by index).
  if (!phases || phases.length === 0) {
    const synthetic: Phase = { index: 0, title: 'agents', detail: null };
    return emitPhase(synthetic, agents);
  }

  // Group agents by phaseIndex, preserving input order within each bucket (stable tie-break).
  const byPhase = new Map<number, AgentNode[]>();
  for (const agent of agents) {
    const bucket = byPhase.get(agent.phaseIndex);
    if (bucket) bucket.push(agent);
    else byPhase.set(agent.phaseIndex, [agent]);
  }

  // The phase index → declared Phase map, and the union of declared + observed phase indices so an
  // agent under an UNRESOLVED index still gets a (synthetic) header instead of vanishing.
  const declared = new Map<number, Phase>();
  for (const p of phases) declared.set(p.index, p);
  const indices = new Set<number>([...declared.keys(), ...byPhase.keys()]);

  const rows: ExecutionOrderRow[] = [];
  // Defensive sort by index (ascending) — the sequential DAG spine, regardless of input order.
  for (const index of [...indices].sort((a, b) => a - b)) {
    const members = byPhase.get(index);
    if (!members || members.length === 0) continue; // skip an agent-less (declared-only) phase
    const phase = declared.get(index) ?? { index, title: `phase ${index}`, detail: null };
    rows.push(...emitPhase(phase, members));
  }
  return rows;
}

/** Emit one phase header (depth 0) + its agents (depth 1, sorted by agent.index, stable). */
function emitPhase(phase: Phase, members: AgentNode[]): ExecutionOrderRow[] {
  // Stable index sort: decorate with input order so equal `agent.index` keeps discovery order.
  const ordered = members
    .map((agent, i) => ({ agent, i }))
    .sort((a, b) => a.agent.index - b.agent.index || a.i - b.i)
    .map((d) => d.agent);
  const rows: ExecutionOrderRow[] = [
    { depth: 0, isPhaseHeader: true, phase, agentCountInPhase: ordered.length },
  ];
  for (const agent of ordered) rows.push({ agent, depth: 1 });
  return rows;
}
