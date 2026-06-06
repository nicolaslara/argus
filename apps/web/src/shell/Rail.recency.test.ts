import { describe, it, expect } from 'vitest';
import type { RunSummary } from '@argus/contract';
import { partitionByRecency } from './Rail.tsx';

// partitionByRecency() is the pure input to the RECENCY FOLD: it splits an (already
// newest-first) run list into RECENT (≤7d) and OLDER (>7d) against an INJECTED reference
// time. It delegates the boundary to isStale() so a folder's fold matches its age-dimming.

const NOW = new Date(2026, 5, 4, 12, 0, 0).getTime();
const startOfToday = new Date(2026, 5, 4).getTime();
const DAY = 86_400_000;

let seq = 0;
/** A finished RunSummary at an explicit startTime (unique ids so order is assertable). */
function run(startTime: number | null): RunSummary {
  seq += 1;
  return {
    ref: { projectPath: '/p', slug: 'p', sessionId: `s-${seq}`, runId: `r-${seq}` },
    workflowName: 'wf',
    status: 'completed',
    agentCount: 1,
    durationMs: 1000,
    startTime,
    summary: '',
    partialFailure: false,
  };
}

describe('partitionByRecency — recent (≤7d) vs older (>7d) by an injected reference time', () => {
  it('splits a mixed list by the 7-day threshold', () => {
    const runs = [
      run(NOW - 1), // today
      run(startOfToday - 3 * DAY), // 3d → recent
      run(startOfToday - 8 * DAY), // 8d → older
      run(startOfToday - 30 * DAY), // 30d → older
    ];
    const { recent, older } = partitionByRecency(runs, NOW);
    expect(recent).toHaveLength(2);
    expect(older).toHaveLength(2);
  });

  it('preserves input order within each partition (stays newest-first)', () => {
    const r0 = run(NOW - 1);
    const r1 = run(startOfToday - 2 * DAY);
    const r2 = run(startOfToday - 10 * DAY);
    const r3 = run(startOfToday - 20 * DAY);
    const { recent, older } = partitionByRecency([r0, r1, r2, r3], NOW);
    expect(recent.map((r) => r.ref.runId)).toEqual([r0.ref.runId, r1.ref.runId]);
    expect(older.map((r) => r.ref.runId)).toEqual([r2.ref.runId, r3.ref.runId]);
  });

  it('puts a null/invalid startTime in OLDER (treated as stale)', () => {
    const { recent, older } = partitionByRecency([run(null), run(NOW - 1)], NOW);
    expect(recent).toHaveLength(1);
    expect(older).toHaveLength(1);
    expect(older[0]!.startTime).toBeNull();
  });

  it('an all-recent list yields no older (the fold toggle would not render)', () => {
    const { recent, older } = partitionByRecency([run(NOW - 1), run(startOfToday - 1 * DAY)], NOW);
    expect(recent).toHaveLength(2);
    expect(older).toHaveLength(0);
  });

  it('an empty list yields two empty partitions', () => {
    expect(partitionByRecency([], NOW)).toEqual({ recent: [], older: [] });
  });
});
