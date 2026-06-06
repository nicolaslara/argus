import { describe, it, expect } from 'vitest';
import {
  readGroupBy,
  writeGroupBy,
  GROUP_BY_KEY,
  DEFAULT_GROUP_BY,
  type GroupByStore,
} from './group-by-setting.ts';

// The persisted explorer GROUP-BY lens (Workflow | Time | Status):
//   - DEFAULTS to 'workflow' (the original tree, the zero-regression baseline) when nothing stored.
//   - round-trips through localStorage (a write then a fresh read restores the choice).
// The node test env has no real `localStorage`, so we inject a fake Storage-like store (the SAME
// `GroupByStore` seam the Rail uses ambiently). This exercises the exact pure helpers the Rail
// calls — no React, no jsdom.

/** A minimal in-memory `localStorage` stand-in for the round-trip tests. */
function fakeStore(seed: Record<string, string> = {}): GroupByStore & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

describe('group-by-setting — the persisted explorer lens (workflow default + round-trip)', () => {
  it('defaults to workflow (the original tree) when nothing is stored', () => {
    expect(DEFAULT_GROUP_BY).toBe('workflow');
    expect(readGroupBy(fakeStore())).toBe('workflow');
  });

  it('defaults to workflow when no store is available (e.g. the node/SSR path)', () => {
    expect(readGroupBy(undefined)).toBe('workflow');
  });

  it('round-trips time through the store', () => {
    const store = fakeStore();
    writeGroupBy('time', store);
    expect(store.map.get(GROUP_BY_KEY)).toBe('time');
    expect(readGroupBy(store)).toBe('time');
  });

  it('round-trips status through the store', () => {
    const store = fakeStore();
    writeGroupBy('status', store);
    expect(store.map.get(GROUP_BY_KEY)).toBe('status');
    expect(readGroupBy(store)).toBe('status');
  });

  it('round-trips back to workflow (toggling time → workflow persists too)', () => {
    const store = fakeStore({ [GROUP_BY_KEY]: 'time' });
    expect(readGroupBy(store)).toBe('time');
    writeGroupBy('workflow', store);
    expect(store.map.get(GROUP_BY_KEY)).toBe('workflow');
    expect(readGroupBy(store)).toBe('workflow');
  });

  it('normalizes an unknown / garbage stored value to the workflow default', () => {
    expect(readGroupBy(fakeStore({ [GROUP_BY_KEY]: 'banana' }))).toBe('workflow');
    expect(readGroupBy(fakeStore({ [GROUP_BY_KEY]: '' }))).toBe('workflow');
    // A legacy/renamed value that is not exactly 'time'/'status' must NOT silently switch lenses.
    expect(readGroupBy(fakeStore({ [GROUP_BY_KEY]: 'Time' }))).toBe('workflow');
  });

  it('a throwing store is non-fatal: read → default, write → swallowed', () => {
    const throwing: GroupByStore = {
      getItem: () => {
        throw new Error('SecurityError: localStorage is disabled');
      },
      setItem: () => {
        throw new Error('SecurityError: localStorage is disabled');
      },
    };
    expect(readGroupBy(throwing)).toBe('workflow');
    expect(() => writeGroupBy('time', throwing)).not.toThrow();
  });

  it('a write to a missing store is a safe no-op (does not throw)', () => {
    expect(() => writeGroupBy('time', undefined)).not.toThrow();
  });
});
