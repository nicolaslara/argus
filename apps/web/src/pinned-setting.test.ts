import { describe, it, expect } from 'vitest';
import {
  readPinnedWorkflows,
  writePinnedWorkflows,
  togglePinned,
  PINNED_KEY,
  DEFAULT_PINNED_WORKFLOWS,
  type PinnedStore,
} from './pinned-setting.ts';

// The persisted explorer PINNED-WORKFLOWS set (the Workflow lens pins a workflow to the top):
//   - DEFAULTS to the EMPTY set (nothing pinned, recency sort wins — the zero-regression baseline).
//   - round-trips through localStorage (a write then a fresh read restores the set).
//   - togglePinned is PURE (returns a new Set, never mutates its input).
// The node test env has no real `localStorage`, so we inject a fake Storage-like store (the SAME
// `PinnedStore` seam the Rail uses ambiently). This exercises the exact pure helpers the Rail
// calls — no React, no jsdom.

/** A minimal in-memory `localStorage` stand-in for the round-trip tests. */
function fakeStore(seed: Record<string, string> = {}): PinnedStore & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

describe('pinned-setting — the persisted explorer pinned set (empty default + round-trip)', () => {
  it('defaults to an empty set when nothing is stored', () => {
    expect(DEFAULT_PINNED_WORKFLOWS.size).toBe(0);
    expect(readPinnedWorkflows(fakeStore()).size).toBe(0);
  });

  it('defaults to an empty set when no store is available (e.g. the node/SSR path)', () => {
    expect(readPinnedWorkflows(undefined).size).toBe(0);
  });

  it('round-trips a single pinned workflow', () => {
    const store = fakeStore();
    writePinnedWorkflows(new Set(['fetch-docs']), store);
    expect(store.map.get(PINNED_KEY)).toBe('fetch-docs');
    expect(readPinnedWorkflows(store)).toEqual(new Set(['fetch-docs']));
  });

  it('round-trips multiple pinned workflows', () => {
    const store = fakeStore();
    writePinnedWorkflows(new Set(['fetch-docs', 'llm-routing']), store);
    // stored normalized + sorted, so the value is stable across reorders.
    expect(store.map.get(PINNED_KEY)).toBe('fetch-docs,llm-routing');
    expect(readPinnedWorkflows(store)).toEqual(new Set(['fetch-docs', 'llm-routing']));
  });

  it('round-trips back to empty (unpinning the last one persists too)', () => {
    const store = fakeStore({ [PINNED_KEY]: 'fetch-docs' });
    expect(readPinnedWorkflows(store)).toEqual(new Set(['fetch-docs']));
    writePinnedWorkflows(new Set(), store);
    expect(store.map.get(PINNED_KEY)).toBe('');
    expect(readPinnedWorkflows(store).size).toBe(0);
  });

  it('normalizes a malformed stored value (extra commas / whitespace) to a clean set', () => {
    expect(readPinnedWorkflows(fakeStore({ [PINNED_KEY]: 'foo,,,bar' }))).toEqual(new Set(['foo', 'bar']));
    expect(readPinnedWorkflows(fakeStore({ [PINNED_KEY]: '  foo , bar  ' }))).toEqual(new Set(['foo', 'bar']));
    expect(readPinnedWorkflows(fakeStore({ [PINNED_KEY]: '' })).size).toBe(0);
    // dupes collapse (a Set never holds two copies).
    expect(readPinnedWorkflows(fakeStore({ [PINNED_KEY]: 'foo,foo' }))).toEqual(new Set(['foo']));
  });

  it('togglePinned adds a name to an empty set', () => {
    expect(togglePinned('foo', new Set())).toEqual(new Set(['foo']));
  });

  it('togglePinned removes a name that is present (and keeps the rest)', () => {
    expect(togglePinned('foo', new Set(['foo']))).toEqual(new Set());
    expect(togglePinned('foo', new Set(['foo', 'bar']))).toEqual(new Set(['bar']));
  });

  it('togglePinned is PURE: it returns a new Set and never mutates its input', () => {
    const input = new Set(['foo']);
    const out = togglePinned('bar', input);
    expect(out).not.toBe(input); // a fresh reference (so the groupRuns memo re-runs)
    expect(input).toEqual(new Set(['foo'])); // input untouched
    expect(out).toEqual(new Set(['foo', 'bar']));
  });

  it('togglePinned ignores a blank/whitespace name (returns an unchanged copy)', () => {
    const input = new Set(['foo']);
    const out = togglePinned('   ', input);
    expect(out).not.toBe(input);
    expect(out).toEqual(new Set(['foo']));
  });

  it('a throwing store is non-fatal: read → empty set, write → swallowed', () => {
    const throwing: PinnedStore = {
      getItem: () => {
        throw new Error('SecurityError: localStorage is disabled');
      },
      setItem: () => {
        throw new Error('SecurityError: localStorage is disabled');
      },
    };
    expect(readPinnedWorkflows(throwing).size).toBe(0);
    expect(() => writePinnedWorkflows(new Set(['foo']), throwing)).not.toThrow();
  });

  it('a write to a missing store is a safe no-op (does not throw)', () => {
    expect(() => writePinnedWorkflows(new Set(['foo']), undefined)).not.toThrow();
  });
});
