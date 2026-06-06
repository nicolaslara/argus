import { describe, it, expect } from 'vitest';
import { isStale } from './format.ts';

// isStale() is the deterministic, injected-reference-time predicate behind AGE-DIMMING.
// It must NEVER read the wall clock itself (the reference is always passed in) and must
// match the timeBucket() "older than This week" boundary: stale ⇔ startMs < startOfToday - 7d.

// A fixed, mid-day reference so startOfToday is unambiguous (2026-06-04 12:00 local).
const NOW = new Date(2026, 5, 4, 12, 0, 0).getTime();
const startOfToday = new Date(2026, 5, 4).getTime();
const DAY = 86_400_000;

describe('isStale — injected-reference-time age predicate (7-day retention boundary)', () => {
  it('is FALSE for a run started just now', () => {
    expect(isStale(NOW - 1, NOW)).toBe(false);
  });

  it('is FALSE for a 6-day-old run (still within "This week")', () => {
    expect(isStale(startOfToday - 6 * DAY, NOW)).toBe(false);
  });

  it('is FALSE exactly AT the 7-day boundary (startOfToday - 7d is the cutoff, not stale)', () => {
    expect(isStale(startOfToday - 7 * DAY, NOW)).toBe(false);
  });

  it('is TRUE 1ms before the 7-day boundary (just past "This week")', () => {
    expect(isStale(startOfToday - 7 * DAY - 1, NOW)).toBe(true);
  });

  it('is TRUE for a clearly old (30-day) run', () => {
    expect(isStale(startOfToday - 30 * DAY, NOW)).toBe(true);
  });

  it('treats a null/invalid startTime as stale (it buckets as "Older" too)', () => {
    expect(isStale(null, NOW)).toBe(true);
    expect(isStale(Number.NaN, NOW)).toBe(true);
    expect(isStale(Number.POSITIVE_INFINITY, NOW)).toBe(true);
  });

  it('is deterministic w.r.t. the injected reference (no wall-clock read)', () => {
    // Same start, two different "nows" → different answers, proving the boundary tracks the arg.
    const start = startOfToday - 5 * DAY;
    expect(isStale(start, NOW)).toBe(false);
    // Roll "now" forward 5 days → the same run is now > 7d old → stale.
    const laterNow = new Date(2026, 5, 9, 12, 0, 0).getTime();
    expect(isStale(start, laterNow)).toBe(true);
  });
});
