import { describe, it, expect } from 'vitest';
import {
  readLoopDrillMode,
  writeLoopDrillMode,
  LOOP_DRILL_MODE_KEY,
  DEFAULT_LOOP_DRILL_MODE,
  type ModeStore,
} from './loop-drill-setting.ts';

// STEP 3(a) — the loop-drill MODE setting (loop-drill-gallery.html opt1 vs opt2):
//   - DEFAULTS to 'round-axis' (option 1, the fully-working baseline) when nothing is stored.
//   - round-trips through localStorage (a write then a fresh read restores the choice).
// The node test env has no real `localStorage`, so we inject a fake Storage-like store (the
// SAME `ModeStore` seam App.tsx uses ambiently). This exercises the exact pure helpers the App
// calls — no React, no jsdom.

/** A minimal in-memory `localStorage` stand-in for the round-trip tests. */
function fakeStore(seed: Record<string, string> = {}): ModeStore & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

describe('loop-drill-setting — the persisted loop-drill MODE (option 1 default + round-trip)', () => {
  it('defaults to round-axis (option 1) when nothing is stored', () => {
    expect(DEFAULT_LOOP_DRILL_MODE).toBe('round-axis');
    expect(readLoopDrillMode(fakeStore())).toBe('round-axis');
  });

  it('defaults to round-axis when no store is available (e.g. the node/SSR path)', () => {
    expect(readLoopDrillMode(undefined)).toBe('round-axis');
  });

  it('round-trips lane-drawer (option 2) through the store', () => {
    const store = fakeStore();
    writeLoopDrillMode('lane-drawer', store);
    // Persisted under the canonical key…
    expect(store.map.get(LOOP_DRILL_MODE_KEY)).toBe('lane-drawer');
    // …and a fresh read restores it (survives a "reload").
    expect(readLoopDrillMode(store)).toBe('lane-drawer');
  });

  it('round-trips back to round-axis (toggling option 2 → option 1 persists too)', () => {
    const store = fakeStore({ [LOOP_DRILL_MODE_KEY]: 'lane-drawer' });
    expect(readLoopDrillMode(store)).toBe('lane-drawer');
    writeLoopDrillMode('round-axis', store);
    expect(store.map.get(LOOP_DRILL_MODE_KEY)).toBe('round-axis');
    expect(readLoopDrillMode(store)).toBe('round-axis');
  });

  it('normalizes an unknown / garbage stored value to the round-axis default', () => {
    expect(readLoopDrillMode(fakeStore({ [LOOP_DRILL_MODE_KEY]: 'banana' }))).toBe('round-axis');
    expect(readLoopDrillMode(fakeStore({ [LOOP_DRILL_MODE_KEY]: '' }))).toBe('round-axis');
    // A legacy/renamed value that is not exactly 'lane-drawer' must NOT silently enable option 2.
    expect(readLoopDrillMode(fakeStore({ [LOOP_DRILL_MODE_KEY]: 'lane_drawer' }))).toBe('round-axis');
  });

  it('a throwing store is non-fatal: read → default, write → swallowed', () => {
    const throwing: ModeStore = {
      getItem: () => {
        throw new Error('SecurityError: localStorage is disabled');
      },
      setItem: () => {
        throw new Error('SecurityError: localStorage is disabled');
      },
    };
    expect(readLoopDrillMode(throwing)).toBe('round-axis');
    expect(() => writeLoopDrillMode('lane-drawer', throwing)).not.toThrow();
  });

  it('a write to a missing store is a safe no-op (does not throw)', () => {
    expect(() => writeLoopDrillMode('lane-drawer', undefined)).not.toThrow();
  });
});
