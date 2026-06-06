// @argus/web — useLiveAgentFill: eagerly fill a RUNNING run's instance cards with the
// transcript-fed metrics the live journal lacks (failure-and-live-inspector §4 "Live +
// finished agent card").
//
// THE PROBLEM: a live (run.incomplete) run's AgentNode carries null dur/tok/tools — those
// live only in the per-agent transcript (`agent-<id>.jsonl`), which the journal-fed live
// model can't see. The per-agent `/activity` route HAS them, but DetailPanel only fetches it
// lazily on select, so the instance CARDS show em-dashes until you click each one.
//
// THE FIX: poll `/activity` for the running run's still-incomplete agents on the SAME live
// interval the run model uses (~4s), and return a Map agentId→LiveFill the App merges into
// the card data BEFORE the graph build (overlay-expand.ts stays pure — the fetch lives here,
// not in the layout). REUSES the existing fetchAgentActivity + the AgentActivity contract +
// the /activity route (no new endpoint).
//
// BOUNDED + GRACEFUL:
//   - runs ONLY when the run is live (incomplete) — finished runs already fill from the
//     finalized wf_*.json model, so this returns an EMPTY map and fetches nothing for them
//     (their cards must stay byte-unchanged).
//   - targets only the agents that NEED a fill: running/queued, OR finished-but-missing
//     dur/tok (the journal is starved). A capped set (MAX_LIVE_FILL) keeps the fan-out
//     bounded on a huge run.
//   - retry:false so a 404 (sub-agent transcripts aren't always persisted) yields NO fill —
//     the card keeps its journal data (em-dashes / bare-id label), never an error.

import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { AgentActivity, AgentNode, RunModel, RunRef } from '@argus/contract';
import { fetchAgentActivity } from './api.ts';

/**
 * The transcript-derived fields used to fill a live instance card. Every field is OPTIONAL:
 * a 404 (no transcript) or a sparse transcript leaves the corresponding card field on its
 * journal value. `tokens` = Σ(input+output+cacheRead); `toolCount` = Σ tool counts;
 * `durationMs` / `label` come straight from the activity (label = first-user-line task).
 */
export interface LiveFill {
  durationMs?: number;
  tokens?: number;
  toolCount?: number;
  label?: string;
}

/** The live-fill poll interval — matches the run-model live poll (~4s) so cards keep up. */
const LIVE_FILL_INTERVAL_MS = 4000;

/**
 * Cap the number of agents we eager-fetch per live tick. A live fan can be large; the cards
 * that matter most (running/queued + the ones still missing metrics) are prioritized and the
 * tail is left on its journal data until it finalizes (the finalized model then fills it for
 * free). Keeps the concurrent /activity fan-out bounded.
 */
export const MAX_LIVE_FILL = 24;

/** Project an AgentActivity onto the minimal LiveFill (only the fields a card needs). */
function toLiveFill(a: AgentActivity): LiveFill {
  const fill: LiveFill = {};
  if (typeof a.durationMs === 'number' && Number.isFinite(a.durationMs)) fill.durationMs = a.durationMs;
  if (a.tokens) {
    const sum = a.tokens.input + a.tokens.output + a.tokens.cacheRead;
    if (Number.isFinite(sum)) fill.tokens = sum;
  }
  if (typeof a.toolCalls === 'number' && Number.isFinite(a.toolCalls)) fill.toolCount = a.toolCalls;
  if (typeof a.label === 'string' && a.label.trim().length > 0) fill.label = a.label;
  return fill;
}

/**
 * An agent NEEDS a live fill when it is still in flight (running/queued — its metrics arrive
 * only via the transcript) OR it is missing dur/tok (the journal didn't record them). A
 * finished agent that already carries dur AND tok is left alone (the model is the truth).
 */
function needsFill(a: AgentNode): boolean {
  if (a.state === 'running' || a.state === 'queued') return true;
  return a.durationMs == null || a.tokens == null;
}

const EMPTY_FILL: Map<string, LiveFill> = new Map();

/**
 * Eagerly fill a LIVE run's instance cards from the per-agent transcript activity.
 *
 * Returns a Map agentId→LiveFill that the App merges into card data before building the
 * graph. For a FINISHED run (or no run / no ref) it returns a STABLE empty map and issues
 * NO requests — those cards fill from the finalized model and must stay byte-unchanged.
 *
 * @param runRef the current run's ref (slug/sessionId/runId), or null while none is selected.
 * @param run    the current run model, or undefined while it loads.
 */
export function useLiveAgentFill(
  runRef: Pick<RunRef, 'slug' | 'sessionId' | 'runId'> | null,
  run: RunModel | undefined,
): Map<string, LiveFill> {
  // ONLY a live (incomplete) run is filled. A finished run returns the empty map; gating the
  // whole hook on `incomplete` keeps a finished run's cards on the finalized model untouched.
  const isLive = !!run?.incomplete && !!runRef;

  // The bounded target set: the agents that need a fill, capped at MAX_LIVE_FILL. Sorted so
  // in-flight (running/queued) agents are fetched first — they're the ones showing em-dashes
  // RIGHT NOW; the still-missing-metric tail follows within the cap.
  const targetIds = useMemo(() => {
    if (!isLive || !run) return [] as string[];
    const inFlight: string[] = [];
    const rest: string[] = [];
    for (const a of run.agents) {
      if (!needsFill(a)) continue;
      if (a.state === 'running' || a.state === 'queued') inFlight.push(a.agentId);
      else rest.push(a.agentId);
    }
    return [...inFlight, ...rest].slice(0, MAX_LIVE_FILL);
  }, [isLive, run]);

  const slug = runRef?.slug;
  const sessionId = runRef?.sessionId;
  const runId = runRef?.runId;

  const queries = useQueries({
    queries: targetIds.map((agentId) => ({
      queryKey: ['agent-activity', slug, sessionId, runId, agentId] as const,
      queryFn: () => fetchAgentActivity({ slug: slug!, sessionId: sessionId!, runId: runId! }, agentId),
      enabled: isLive,
      // A 404 (transcript not persisted yet / ever) → no fill, never an error retry storm.
      retry: false,
      // The transcript grows while the run is live — keep the cards current on the live tick.
      refetchInterval: isLive ? LIVE_FILL_INTERVAL_MS : (false as const),
      // Shares the cache key with DetailPanel's lazy activity query — selecting an agent reuses
      // this already-warmed entry (and vice versa).
      staleTime: LIVE_FILL_INTERVAL_MS,
    })),
  });

  // ARCH-4 (perf): a PRIMITIVE content signature of the resolved activity. The memo then rebuilds
  // ONLY when a fetch actually resolves OR a live metric changes (tokens grow, a tool runs) — NOT
  // every render. `queries.map((q) => q.data)` was a FRESH array each render, so the dep always
  // differed and the memo rebuilt every render (defeating it). A string is stable when unchanged.
  const fillSig = queries
    .map((q, i) => {
      const d = q.data;
      if (!d) return `${targetIds[i]}:`;
      const tok = d.tokens ? d.tokens.input + d.tokens.output + d.tokens.cacheRead : '';
      return `${targetIds[i]}:${d.durationMs ?? ''}:${tok}:${d.toolCalls ?? ''}:${d.label ?? ''}`;
    })
    .join('|');

  return useMemo(() => {
    if (!isLive || targetIds.length === 0) return EMPTY_FILL;
    const map = new Map<string, LiveFill>();
    queries.forEach((q, i) => {
      const id = targetIds[i];
      if (!id || !q.data) return;
      map.set(id, toLiveFill(q.data));
    });
    return map.size > 0 ? map : EMPTY_FILL;
    // Keyed on the primitive `fillSig` (not the fresh `queries` array) so it only rebuilds on a
    // real data change; exhaustive-deps is not enforced here, so no disable directive is needed.
  }, [isLive, targetIds, fillSig]);
}
