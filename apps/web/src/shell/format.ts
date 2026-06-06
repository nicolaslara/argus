// @argus/web — small pure presentation helpers for the shell (rail) chrome.
// No format knowledge of the on-disk journal lives here; these only format the
// already-normalized RunSummary scalars (durationMs / startTime epoch ms) for
// display. Pure + deterministic so they are trivially testable and SSR-safe.

import type { RunStatus } from '@argus/contract';

const EM_DASH = '—';

/**
 * A compact, human duration: `1.4s`, `48s`, `3m 12s`, `1h 04m`. The ONE shared home for
 * duration formatting (rail, run-history, agent cards/chips, the agent table all import it).
 *
 * null/undefined/NaN/±Infinity → em-dash, and `ms <= 0` → em-dash too: a zero or negative
 * duration is treated as MISSING, not as a literal "0ms" (0-with-context is "unknown", not an
 * instant run — boundaries.md §7, same convention as formatTokens/formatTools below).
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return EM_DASH;
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) {
    // sub-10s gets one decimal so a fast run doesn't read as a flat "3s".
    if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${totalSec}s`;
  }
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${String(sec).padStart(2, '0')}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${String(remMin).padStart(2, '0')}m`;
}

/**
 * A compact token count: `1`, `999`, `1.0k`, `12k`, `1.0M`. The ONE shared home for token
 * formatting (agent cards + the agent table import it). null/undefined/0 → em-dash (0-with-
 * tools is activity, not a cost worth comparing — boundaries.md §7), and NaN/±Infinity → em-dash.
 */
export function formatTokens(tokens: number | null | undefined): string {
  if (tokens == null || tokens === 0 || !Number.isFinite(tokens)) return EM_DASH;
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/**
 * A tool-call count: the raw integer, or em-dash. The ONE shared home for tool formatting
 * (agent cards + the agent table import it). null/undefined/0 → em-dash (same missing-vs-zero
 * convention as formatTokens), and NaN/±Infinity → em-dash.
 */
export function formatTools(toolCalls: number | null | undefined): string {
  if (toolCalls == null || toolCalls === 0 || !Number.isFinite(toolCalls)) return EM_DASH;
  return String(toolCalls);
}

/**
 * elapsed-to-failure / run-header duration: a compact `42s` or `3m07s` string, or `null`.
 *
 * A THIN WRAPPER over the same duration math as formatDuration BUT with two deliberate
 * differences for its caller (App's failure banner + run-header):
 *   1. Returns `null` (not the em-dash) on missing/invalid input, so the CALLER controls
 *      rendering — both call sites render `after {elapsed}` / the header pill only when truthy.
 *   2. A flatter, secondless-decimal compact format (`42s`, `3m07s`, `60m00s`) — no decimal
 *      seconds and no hours rollover — so the banner/header read as a single calm token.
 */
export function formatElapsed(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m${String(s).padStart(2, '0')}s`;
}

/**
 * A relative time for a start epoch (ms): `just now`, `5m ago`, `3h ago`,
 * `2d ago`, then an absolute `Mon D` once it is older than a week. `null` → ''.
 * `now` is injectable for deterministic tests.
 */
export function formatRelativeTime(startMs: number | null, now: number = Date.now()): string {
  if (startMs == null || !Number.isFinite(startMs)) return '';
  const diff = now - startMs;
  if (diff < 0) return 'just now';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  // Older than a week → an absolute month/day (locale-independent, no year noise).
  const d = new Date(startMs);
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

/**
 * Predicate: is a run STALE (older than the 7-day retention threshold)?
 *
 * Deterministic + testable: the reference time is INJECTED (the helper never reads the
 * wall clock itself), so unit tests pin "now" and the rail injects Date.now() once per
 * render. Mirrors the timeBucket() boundary in Rail.tsx — `startMs < startOfToday - 7d`
 * is exactly the "older than This week" cutoff, so age-dimming lines up with that lens.
 * A null/invalid startTime is treated as stale (it sorts/buckets as "Older" too).
 */
export function isStale(startMs: number | null, referenceNow: number): boolean {
  if (startMs == null || !Number.isFinite(startMs)) return true;
  const dayMs = 86_400_000;
  const now = new Date(referenceNow);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return startMs < startOfToday - 7 * dayMs;
}

/**
 * A status glyph for a run. A single visual token (text, never an icon font) that
 * carries run state by SHAPE; color is applied via a `status-<status>` class so
 * saturation stays reserved for state semantics (design system, boundaries.md §7).
 * `partialFailure` on a completed run gets the warn ring rather than the check.
 */
export function statusGlyph(status: RunStatus, partialFailure: boolean): string {
  if (status === 'completed') return partialFailure ? '◐' : '●';
  if (status === 'failed') return '✕';
  if (status === 'killed') return '◼';
  if (status === 'running') return '◌';
  return '●';
}
