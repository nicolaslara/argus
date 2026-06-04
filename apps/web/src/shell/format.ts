// @argus/web — small pure presentation helpers for the shell (rail) chrome.
// No format knowledge of the on-disk journal lives here; these only format the
// already-normalized RunSummary scalars (durationMs / startTime epoch ms) for
// display. Pure + deterministic so they are trivially testable and SSR-safe.

import type { RunStatus } from '@argus/contract';

/** A compact, human duration: `1.4s`, `48s`, `3m 12s`, `1h 04m`. `null` → em-dash. */
export function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
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
