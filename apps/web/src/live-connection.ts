// Live & inspection #2 (SUB-TASK A): the SSE live-stream CONNECTION STATE, extracted as a
// pure state machine so the transitions are unit-testable WITHOUT a browser EventSource, a
// DOM, or React. App.tsx owns the EventSource + the 10s "lost" escalation TIMER and the
// React state cell; this module owns ONLY the (prev, event) -> next reducer, which is the
// part the arch audit found trapped (and untested) inside the useEffect.
//
// Chip semantics (unchanged from App): 'connecting' is the brief pre-open gap; 'open' is
// healthy; 'reconnecting' is a transient drop where EventSource is auto-retrying (amber);
// 'lost' is a prolonged outage we've given up auto-recovering this socket (red — the poll
// backstop still runs). 'lost' is STICKY across further errors (it never silently de-escalates
// to amber on a repeated error), but a successful 'open' clears it back to healthy.

export type LiveConnectionState = 'connecting' | 'open' | 'reconnecting' | 'lost';

/** The reducer's input alphabet. `reset` returns to the initial 'connecting' state (used when
 *  the effect re-arms for a new live run, or when there is no live run at all). */
export type LiveConnectionEvent = 'open' | 'error' | 'reset';

/** The initial state every fresh subscription starts in. */
export const INITIAL_LIVE_CONNECTION_STATE: LiveConnectionState = 'connecting';

/**
 * The pure transition: given the current connection state and an EventSource event, return the
 * next state. No side effects — the caller owns the 10s lost-escalation timer (it fires `error`
 * is NOT how 'lost' is reached; instead the timer is a separate concern owned by App, and when
 * it elapses App sets 'lost' directly). This reducer only models the IMMEDIATE event mapping:
 *   - open  : always → 'open' (clears any reconnecting/lost)
 *   - error : 'lost' stays 'lost' (sticky); anything else → 'reconnecting' (amber)
 *   - reset : always → 'connecting' (the initial state)
 * An unknown event is a no-op (returns prev unchanged) so a stray listener can never crash.
 */
export function nextConnectionState(
  prev: LiveConnectionState,
  event: LiveConnectionEvent,
): LiveConnectionState {
  switch (event) {
    case 'open':
      return 'open';
    case 'error':
      // EventSource auto-reconnects (server `retry: 3000`); reflect the transient drop as
      // amber. Once we've escalated to 'lost' (red), a repeated error keeps it red — the App
      // timer, not this reducer, is what promotes amber → red after the grace window.
      return prev === 'lost' ? 'lost' : 'reconnecting';
    case 'reset':
      return INITIAL_LIVE_CONNECTION_STATE;
    default:
      return prev;
  }
}
