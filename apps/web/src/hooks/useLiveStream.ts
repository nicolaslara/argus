import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  nextConnectionState,
  INITIAL_LIVE_CONNECTION_STATE,
  type LiveConnectionState,
} from '../live-connection.ts';

/** What App needs to subscribe to a live run's SSE stream. `slug`/`session`/`runId` may be
 *  undefined while no run is focused; `isLiveRun` gates the whole subscription. */
export interface LiveStreamArgs {
  isLiveRun: boolean;
  slug: string | undefined;
  session: string | undefined;
  runId: string | undefined;
}

/**
 * L3: subscribe to the run's SSE stream while it's live — a journal append pushes a `changed`
 * event → invalidate the live model immediately (no poll lag). EventSource auto-reconnects
 * (the server sends `retry:`), giving the gate's "clean reconnect".
 *
 * Extracted verbatim from App.tsx (behavior-preserving): this hook owns the EventSource + the
 * 10s lost-escalation TIMER + the React state cell, and feeds events through the pure
 * ./live-connection.ts reducer. Returns the connection state so App can surface the status chip.
 *
 * Live & inspection #2 (SUB-TASK A): the live-stream connection state, surfaced as a small
 * status chip so a dropped stream is never silent. 'connecting' is the brief pre-open gap;
 * 'open' is healthy (no chip shown — the 4s poll backstop also covers it); 'reconnecting' is a
 * transient drop where EventSource is retrying (amber); 'lost' is a prolonged outage where we've
 * given up auto-recovering this socket (red — the poll backstop still runs). The chip is gated
 * on isLiveRun, so a finished run never shows one.
 */
export function useLiveStream({ isLiveRun, slug, session, runId }: LiveStreamArgs): LiveConnectionState {
  const queryClient = useQueryClient();
  const [liveConnectionState, setLiveConnectionState] =
    useState<LiveConnectionState>(INITIAL_LIVE_CONNECTION_STATE);
  useEffect(() => {
    if (!isLiveRun || !slug || !session || !runId) {
      // Not a live run → no stream, no chip. Reset so a future live run starts clean.
      setLiveConnectionState((prev) => nextConnectionState(prev, 'reset'));
      return;
    }
    const url = `/api/runs/${encodeURIComponent(slug)}/${encodeURIComponent(session)}/${encodeURIComponent(runId)}/stream`;
    const es = new EventSource(url);
    setLiveConnectionState((prev) => nextConnectionState(prev, 'reset'));
    // After a brief outage, escalate the amber "reconnecting" chip to a red "lost" one so a
    // long stall reads as paused (the slow poll backstop above keeps the data fresh meanwhile).
    // Note: Last-Event-ID resumption is deferred — the server resends the full state on
    // reconnect (each `changed` just triggers a refetch), so a missed id is harmless here.
    let lostTimer: ReturnType<typeof setTimeout> | null = null;
    const clearLostTimer = () => {
      if (lostTimer) {
        clearTimeout(lostTimer);
        lostTimer = null;
      }
    };
    const onChanged = () => {
      // SUB-TASK C: the run query key is now suffix-free (stable across live→final), so the
      // SSE invalidation must target the same stable key.
      void queryClient.invalidateQueries({ queryKey: ['run', slug, session, runId] });
    };
    const onOpen = () => {
      clearLostTimer();
      setLiveConnectionState((prev) => nextConnectionState(prev, 'open'));
    };
    const onError = () => {
      // EventSource auto-reconnects (server `retry: 3000`); reflect the transient drop as
      // amber, then escalate to red "lost" if it stays down past the grace window. The reducer
      // keeps 'lost' sticky; the timer (App-owned) is what promotes amber → red.
      setLiveConnectionState((prev) => nextConnectionState(prev, 'error'));
      clearLostTimer();
      lostTimer = setTimeout(() => setLiveConnectionState('lost'), 10_000);
    };
    es.addEventListener('changed', onChanged);
    es.addEventListener('open', onOpen);
    es.addEventListener('error', onError);
    return () => {
      clearLostTimer();
      es.removeEventListener('changed', onChanged);
      es.removeEventListener('open', onOpen);
      es.removeEventListener('error', onError);
      es.close();
    };
  }, [isLiveRun, slug, session, runId, queryClient]);
  return liveConnectionState;
}
