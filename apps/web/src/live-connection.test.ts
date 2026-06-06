import { describe, it, expect } from 'vitest';
import {
  nextConnectionState,
  INITIAL_LIVE_CONNECTION_STATE,
  type LiveConnectionState,
} from './live-connection.ts';

// Live & inspection #2 (SUB-TASK A): the SSE connection state machine, extracted from
// App.tsx's useEffect so its transitions are testable without a browser EventSource. App
// owns the 10s lost-escalation timer (which sets 'lost' directly); this reducer models the
// IMMEDIATE event → state mapping the effect's onopen/onerror/reset handlers feed it.

describe('nextConnectionState (SSE live-connection reducer)', () => {
  it('exposes the initial state as connecting', () => {
    expect(INITIAL_LIVE_CONNECTION_STATE).toBe('connecting');
  });

  describe('open event', () => {
    it('connecting → open (the first successful connect)', () => {
      expect(nextConnectionState('connecting', 'open')).toBe('open');
    });

    it('open → open (an already-healthy socket re-opening is preserved)', () => {
      expect(nextConnectionState('open', 'open')).toBe('open');
    });

    it('reconnecting → open (a successful reconnect clears the amber chip)', () => {
      expect(nextConnectionState('reconnecting', 'open')).toBe('open');
    });

    it('lost → open (a recovered socket clears even the red chip)', () => {
      expect(nextConnectionState('lost', 'open')).toBe('open');
    });
  });

  describe('error event', () => {
    it('connecting → reconnecting (an error before first open is a transient drop)', () => {
      expect(nextConnectionState('connecting', 'error')).toBe('reconnecting');
    });

    it('open → reconnecting (a drop on a healthy socket goes amber)', () => {
      expect(nextConnectionState('open', 'error')).toBe('reconnecting');
    });

    it('reconnecting → reconnecting (stays amber while EventSource retries)', () => {
      expect(nextConnectionState('reconnecting', 'error')).toBe('reconnecting');
    });

    it('lost → lost (red is STICKY: a repeated error never de-escalates to amber)', () => {
      expect(nextConnectionState('lost', 'error')).toBe('lost');
    });
  });

  describe('reset event', () => {
    it('returns to the initial connecting state from every state', () => {
      const all: LiveConnectionState[] = ['connecting', 'open', 'reconnecting', 'lost'];
      for (const s of all) {
        expect(nextConnectionState(s, 'reset')).toBe(INITIAL_LIVE_CONNECTION_STATE);
        expect(nextConnectionState(s, 'reset')).toBe('connecting');
      }
    });
  });

  describe('robustness', () => {
    it('an unknown event is a safe no-op (returns prev unchanged, never crashes)', () => {
      const all: LiveConnectionState[] = ['connecting', 'open', 'reconnecting', 'lost'];
      for (const s of all) {
        // @ts-expect-error — deliberately feeding an out-of-alphabet event.
        expect(nextConnectionState(s, 'bogus')).toBe(s);
      }
    });

    it('is pure — repeated calls with the same input give the same output', () => {
      expect(nextConnectionState('open', 'error')).toBe(nextConnectionState('open', 'error'));
      expect(nextConnectionState('lost', 'error')).toBe(nextConnectionState('lost', 'error'));
    });
  });
});
