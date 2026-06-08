// @argus/web — shared session time helpers for the Story view. Used by BOTH the rail's
// Sessions section (the navigator) and the StoryPage narrative, so the ordering + default
// selection never diverge between where you pick a session and what renders.

import type { SessionSummary } from '@argus/contract';

/** Parse an ISO timestamp to epoch ms, or null when absent/unparseable. */
export function isoToMs(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * "Most recently ACTIVE" sort key for a session — its last-activity time (`end`), falling
 * back to `start`, else -Infinity (sorts last). We order + default-select by activity, NOT
 * by start: a long-running session that started days ago but was touched moments ago (the
 * live argus-building session) is the one to land on, yet sorting by `start` would bury it
 * beneath a dozen trivial throwaway sessions that merely BEGAN later.
 */
export function sessionActivityMs(s: SessionSummary): number {
  return isoToMs(s.timeRange.end) ?? isoToMs(s.timeRange.start) ?? -Infinity;
}

/** Sessions ordered most-recently-active first (a stable copy; the input is untouched). */
export function orderSessionsByActivity(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((a, b) => sessionActivityMs(b) - sessionActivityMs(a));
}
