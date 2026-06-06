import { describe, it, expect } from 'vitest';
import { formatDuration, formatElapsed, formatTokens, formatTools, isStale } from './format.ts';

const EM_DASH = '—';

// formatDuration / formatTokens / formatTools are the ONE shared home for the agent metric
// formatters (consolidated from per-component copies). The null/0 → em-dash convention is
// uniform: a zero or missing metric reads as MISSING (em-dash), never a literal "0".
describe('formatDuration — shared agent/run duration formatter', () => {
  it('returns em-dash for null/undefined/NaN/±Infinity', () => {
    expect(formatDuration(null)).toBe(EM_DASH);
    expect(formatDuration(undefined)).toBe(EM_DASH);
    expect(formatDuration(Number.NaN)).toBe(EM_DASH);
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe(EM_DASH);
    expect(formatDuration(Number.NEGATIVE_INFINITY)).toBe(EM_DASH);
  });

  it('treats 0 and negative as MISSING → em-dash (not "0ms")', () => {
    expect(formatDuration(0)).toBe(EM_DASH);
    expect(formatDuration(-1)).toBe(EM_DASH);
  });

  it('renders sub-second as `<ms>ms`', () => {
    expect(formatDuration(1)).toBe('1ms');
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('renders sub-10s with one decimal second', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(1400)).toBe('1.4s');
    expect(formatDuration(9900)).toBe('9.9s');
  });

  it('renders 10–59s as a whole-second count', () => {
    expect(formatDuration(10_000)).toBe('10s');
    expect(formatDuration(48_000)).toBe('48s');
  });

  it('renders minutes as `Xm SSs` (zero-padded seconds, space-separated)', () => {
    expect(formatDuration(60_000)).toBe('1m 00s');
    expect(formatDuration(192_000)).toBe('3m 12s');
    expect(formatDuration(3_599_000)).toBe('59m 59s');
  });

  it('renders hours as `Xh MMm` (zero-padded minutes)', () => {
    expect(formatDuration(3_600_000)).toBe('1h 00m');
    expect(formatDuration(3_840_000)).toBe('1h 04m');
  });
});

describe('formatTokens — shared token-count formatter', () => {
  it('returns em-dash for null/undefined/0 (0-with-tools is activity, not a cost)', () => {
    expect(formatTokens(null)).toBe(EM_DASH);
    expect(formatTokens(undefined)).toBe(EM_DASH);
    expect(formatTokens(0)).toBe(EM_DASH);
  });

  it('returns em-dash for NaN/±Infinity', () => {
    expect(formatTokens(Number.NaN)).toBe(EM_DASH);
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe(EM_DASH);
  });

  it('returns the raw count for 1–999', () => {
    expect(formatTokens(1)).toBe('1');
    expect(formatTokens(999)).toBe('999');
  });

  it('formats k-notation for 1k–999k (one decimal under 10k, none above)', () => {
    expect(formatTokens(1000)).toBe('1.0k');
    expect(formatTokens(9999)).toBe('10.0k');
    expect(formatTokens(10_000)).toBe('10k');
    expect(formatTokens(999_000)).toBe('999k');
  });

  it('formats M-notation (one decimal) for 1M+', () => {
    expect(formatTokens(1_000_000)).toBe('1.0M');
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });
});

describe('formatTools — shared tool-call-count formatter', () => {
  it('returns em-dash for null/undefined/0', () => {
    expect(formatTools(null)).toBe(EM_DASH);
    expect(formatTools(undefined)).toBe(EM_DASH);
    expect(formatTools(0)).toBe(EM_DASH);
  });

  it('returns em-dash for NaN/±Infinity', () => {
    expect(formatTools(Number.NaN)).toBe(EM_DASH);
    expect(formatTools(Number.POSITIVE_INFINITY)).toBe(EM_DASH);
  });

  it('returns the raw count for any n > 0', () => {
    expect(formatTools(1)).toBe('1');
    expect(formatTools(7)).toBe('7');
    expect(formatTools(128)).toBe('128');
  });
});

// formatElapsed is the failure-banner / run-header variant: it returns NULL (not em-dash) on
// missing input so the caller controls rendering, and uses a flat compact format (no decimal
// seconds, no hours rollover).
describe('formatElapsed — failure-banner / run-header duration (null when missing)', () => {
  it('returns null (NOT em-dash) for null/undefined/NaN/±Infinity/negative', () => {
    expect(formatElapsed(null)).toBeNull();
    expect(formatElapsed(undefined)).toBeNull();
    expect(formatElapsed(Number.NaN)).toBeNull();
    expect(formatElapsed(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatElapsed(-1)).toBeNull();
  });

  it('renders sub-minute as whole seconds (no decimal)', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(5000)).toBe('5s');
    expect(formatElapsed(59_000)).toBe('59s');
  });

  it('renders minutes as `Xm SSs` (zero-padded, no space)', () => {
    expect(formatElapsed(60_000)).toBe('1m00s');
    expect(formatElapsed(187_000)).toBe('3m07s');
  });

  it('never rolls over to hours (flat minutes, unlike formatDuration)', () => {
    expect(formatElapsed(3_600_000)).toBe('60m00s');
  });
});

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
