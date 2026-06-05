// @argus/adapter — the LIVE path (L1 running-run detection + L2 journal→model). The
// ONLY module that knows the LIVE on-disk shape. Empirically grounded
// (workpads/live/knowledge.md F1–F5, verified 2026-06-05 by polling a real run):
//
//   F1  `workflows/wf_<id>.json` is written ONCE, at finalize — NEVER progressively.
//       So its EXISTENCE ≈ the run is OVER; we cannot poll it for live progress.
//   F2  the live source is `subagents/workflows/wf_<id>/journal.jsonl`: an append-only
//       log of exactly two event kinds — {type:'started', key, agentId} and
//       {type:'result', key, agentId, result}. No labels, phases, model, tokens, or
//       timing. Phase ordering is only IMPLICIT (a later phase's agents `started` after
//       the prior phase's `result`s).
//   F3  labels/phases/metrics live ONLY in the finalized json. A journal-only model is
//       therefore anonymous unless labels are recovered elsewhere…
//   F4  …the persisted SCRIPT (`workflows/scripts/<name>-wf_<id>.js`) IS on disk for the
//       whole run → parse it (parsePlan) and bind journal agents to plan nodes by
//       START-ORDER when the plan is statically resolvable; else stay anonymous.
//   F5  per-agent `subagents/agent-<id>.jsonl` transcripts are NOT reliable live — the
//       journal `result` field is the live content source.
//
// PURE — no node:fs. Disk is read by the caller through the FileSystemPort; the pure
// builders here take the journal TEXT (so a journal replay is a first-class test).

import type {
  RunModel,
  AgentNode,
  AgentState,
  Phase,
  PhaseEdge,
  Preview,
  PlanModel,
  RunRef,
  AdapterWarning,
} from '@argus/contract';
import { PREVIEW_EMIT_CAP } from './raw.ts';

// --- journal parsing --------------------------------------------------------

export interface JournalEvent {
  type: 'started' | 'result' | 'unknown';
  agentId: string;
  key: string | null;
  /** Present on a `result` event — the FULL result text (uncapped on disk). */
  result?: string;
}

export interface ParsedJournal {
  events: JournalEvent[];
  /** JSONL lines that failed to parse / lacked an agentId (skipped — line-independent). */
  badLines: number;
}

/**
 * Parse `journal.jsonl` text into ordered events. LINE-INDEPENDENT: a single malformed
 * line is counted in `badLines` and skipped, never aborting the parse (a journal being
 * actively appended can have a torn final line). NEVER throws.
 */
export function parseJournal(text: string): ParsedJournal {
  const events: JournalEvent[] = [];
  let badLines = 0;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      badLines += 1;
      continue;
    }
    if (!o || typeof o !== 'object') {
      badLines += 1;
      continue;
    }
    const rec = o as Record<string, unknown>;
    const agentId = typeof rec.agentId === 'string' ? rec.agentId : '';
    if (agentId.length === 0) {
      badLines += 1;
      continue;
    }
    const rawType = rec.type;
    const type: JournalEvent['type'] =
      rawType === 'started' ? 'started' : rawType === 'result' ? 'result' : 'unknown';
    const ev: JournalEvent = {
      type,
      agentId,
      key: typeof rec.key === 'string' ? rec.key : null,
    };
    if (type === 'result' && typeof rec.result === 'string') ev.result = rec.result;
    events.push(ev);
  }
  return { events, badLines };
}

/** A journal agent, reduced from its lifecycle events (first-appearance ordered). */
interface LiveAgent {
  agentId: string;
  /** 0-based order of first appearance in the journal (start order). */
  order: number;
  started: boolean;
  /** result text if a `result` event was seen (else undefined → still running). */
  result?: string;
}

/** Reduce raw events to one LiveAgent per agentId, ordered by first appearance. */
export function reduceJournal(events: JournalEvent[]): LiveAgent[] {
  const byId = new Map<string, LiveAgent>();
  for (const ev of events) {
    let a = byId.get(ev.agentId);
    if (!a) {
      a = { agentId: ev.agentId, order: byId.size, started: false };
      byId.set(ev.agentId, a);
    }
    if (ev.type === 'started') a.started = true;
    if (ev.type === 'result') {
      a.started = true; // a result implies it ran (a torn journal may miss the `started`)
      a.result = ev.result ?? '';
    }
  }
  return [...byId.values()];
}

/**
 * The FULL (uncapped) result value for one agent, read from the journal `result` event
 * (the journal is the only place the complete result lives — the finalized wf_<id>.json
 * only keeps a ~401-char `resultPreview`). The value is whatever the agent returned: a
 * STRING for a text agent, or a structured OBJECT for a schema (StructuredOutput) agent.
 * Returns null if the agent has no result event. Line-independent; NEVER throws.
 *
 * Used by the inspect detail panel's lazy "full result" fetch (R1): the dashboard renders
 * this readably (and offers raw JSON), instead of the truncated preview.
 */
export function agentResultFromJournal(journalText: string, agentId: string): unknown {
  for (const rawLine of journalText.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o !== 'object') continue;
    const rec = o as Record<string, unknown>;
    if (rec.type === 'result' && rec.agentId === agentId) {
      return 'result' in rec ? (rec.result ?? null) : null;
    }
  }
  return null;
}

// --- running-run detection (L1) ---------------------------------------------

export type RunLiveness = 'running' | 'stale' | 'finalized';

export interface LivenessInput {
  /** `subagents/workflows/wf_<id>/journal.jsonl` exists. */
  journalExists: boolean;
  /** `workflows/wf_<id>.json` exists (F1: existence ≈ run-over). */
  finalizedExists: boolean;
  /** mtime of the journal, or null if unknown. */
  journalMtimeMs: number | null;
  nowMs: number;
  /** A journal untouched for longer than this is `stale` (crashed/abandoned). Default 5 min. */
  staleAfterMs?: number;
}

/**
 * Classify a run's liveness from cheap file-existence + journal mtime signals (F1):
 * - the finalized json exists                       → `finalized` (run over; use loadRun).
 * - no journal at all                               → `finalized` (nothing live to show).
 * - journal exists, no finalized, recently touched  → `running`.
 * - journal exists, no finalized, gone quiet        → `stale` (never finalized → likely crashed).
 */
export function classifyRunLiveness(i: LivenessInput): RunLiveness {
  if (i.finalizedExists) return 'finalized';
  if (!i.journalExists) return 'finalized';
  const staleAfter = i.staleAfterMs ?? 5 * 60_000;
  if (i.journalMtimeMs !== null && i.nowMs - i.journalMtimeMs > staleAfter) return 'stale';
  return 'running';
}

// --- plan binding (F4): recover labels/phases from the persisted script ------

interface ExpectedSlot {
  label: string;
  phaseIndex: number;
}

/**
 * Flatten a PlanModel's agent nodes into an ordered list of expected agent slots, in
 * (phase, source) order, expanding `fixed:n` multiplicity into n copies. Returns null
 * when the plan is NOT statically resolvable — any agent node with `unbounded`
 * multiplicity means we cannot know how many agents map to which template, so we refuse
 * to half-bind (F4: ambiguous → anonymous). `null` ⇒ caller renders anonymous agents.
 */
export function planExpectedSlots(plan: PlanModel): ExpectedSlot[] | null {
  const agents = plan.nodes.filter((n) => n.kind === 'agent');
  // Preserve plan node order (it is source/phase order), stably keyed by phaseRef.
  const ordered = [...agents].sort((a, b) => (a.phaseRef ?? 0) - (b.phaseRef ?? 0));
  const slots: ExpectedSlot[] = [];
  for (const n of ordered) {
    const m = n.multiplicity;
    const count = m.kind === 'one' ? 1 : m.kind === 'fixed' ? m.n : 0;
    if (m.kind === 'unbounded') return null; // not statically resolvable
    const label = n.labelTemplate?.literalPrefix || n.title || '';
    const phaseIndex = n.phaseRef ?? 1;
    for (let i = 0; i < count; i += 1) slots.push({ label, phaseIndex });
  }
  return slots;
}

// --- live model (L2) --------------------------------------------------------

/** Cap a live result string at the emit cap; `truncated` when it was longer (F2: full text on disk). */
function makeLivePreview(s: string | undefined): Preview | null {
  if (typeof s !== 'string') return null;
  const truncated = s.length > PREVIEW_EMIT_CAP;
  return { text: truncated ? s.slice(0, PREVIEW_EMIT_CAP) : s, truncated };
}

export interface LiveModelOptions {
  /** Persisted-script plan, used to recover labels/phases by start-order binding (F4). */
  plan?: PlanModel | null;
  clientVersion?: string;
}

/**
 * Build a PARTIAL, live `RunModel` from journal text (L2). `incomplete:true`,
 * `status:'running'`. Agent state = `done` once a `result` event is seen, else
 * `running`. Metrics (tokens/timing/model) are null live (F3 — they only land in the
 * finalized json; L5 reconciliation swaps in the authoritative model then).
 *
 * Labels/phases: when `opts.plan` is given AND statically resolvable (planExpectedSlots),
 * journal agents are bound to plan slots by START-ORDER (F4); the i-th agent to appear
 * takes the i-th expected slot's label + phaseIndex. Otherwise agents are ANONYMOUS in a
 * single synthetic "Running" lane (a `live-unbound-anonymous` warning records the
 * degrade). EXPLICIT field projection only (never spreads parsed JSON). NEVER throws.
 */
export function buildLiveModel(
  journalText: string,
  ref: RunRef,
  opts: LiveModelOptions = {},
): RunModel {
  const warnings: AdapterWarning[] = [{ code: 'live-incomplete' }];
  const { events, badLines } = parseJournal(journalText);
  if (badLines > 0) warnings.push({ code: 'journal-bad-lines', detail: String(badLines) });

  const live = reduceJournal(events);

  const slots = opts.plan ? planExpectedSlots(opts.plan) : null;
  const bound = slots !== null && live.length <= slots.length;
  if (opts.plan && !bound) warnings.push({ code: 'live-unbound-anonymous' });

  const usedPhaseIndices = new Set<number>();
  const agents: AgentNode[] = live.map((a) => {
    const slot = bound ? slots![a.order] : undefined;
    const phaseIndex = slot ? slot.phaseIndex : 1;
    usedPhaseIndices.add(phaseIndex);
    const state: AgentState = a.result !== undefined ? 'done' : a.started ? 'running' : 'queued';
    return {
      agentId: a.agentId,
      index: a.order,
      label: slot ? slot.label : '',
      phaseIndex,
      model: null,
      state,
      cached: false,
      agentType: null,
      attempt: null,
      failedInLogs: false,
      tokens: null,
      toolCalls: null,
      durationMs: null,
      queuedAt: null,
      startedAt: null,
      lastProgressAt: null,
      lastToolName: null,
      lastToolSummary: null,
      promptPreview: null,
      resultPreview: makeLivePreview(a.result),
    };
  });
  agents.sort((x, y) => x.phaseIndex - y.phaseIndex || x.index - y.index);

  // Phases: titled from the plan when bound; else a single synthetic "Running" lane.
  let phases: Phase[];
  if (bound && opts.plan) {
    phases = [...usedPhaseIndices]
      .sort((a, b) => a - b)
      .map((idx) => ({
        index: idx,
        title: opts.plan!.lanes.find((l) => l.index === idx)?.title ?? `Phase ${idx}`,
        detail: null,
      }));
  } else {
    phases = agents.length > 0 ? [{ index: 1, title: 'Running', detail: null }] : [];
  }

  const edges: PhaseEdge[] = [];
  for (let i = 0; i < phases.length - 1; i += 1) {
    edges.push({ from: phases[i]!.index, to: phases[i + 1]!.index });
  }

  const done = agents.filter((a) => a.state === 'done').length;
  const summary =
    agents.length === 0 ? 'waiting for first agent…' : `${done}/${agents.length} agents done`;

  const model: RunModel = {
    ref,
    workflowName: opts.plan?.workflowName ?? '',
    status: 'running',
    incomplete: true,
    startTime: null,
    durationMs: null,
    defaultModel: null,
    summary,
    phases,
    agents,
    edges,
    logs: [],
    partialFailure: { present: false, lines: [] },
    error: null,
    args: null,
    warnings,
    format: ADAPTER_FORMAT_LIVE,
  };
  if (opts.clientVersion !== undefined) model.clientVersion = opts.clientVersion;
  return model;
}

// Re-pinned locally to avoid a runtime import cycle with index.ts (which imports this
// module). Kept identical to index.ts ADAPTER_FORMAT — asserted equal by a unit test.
export const ADAPTER_FORMAT_LIVE = 'cc-workflow/observed-2026-06-04' as const;
