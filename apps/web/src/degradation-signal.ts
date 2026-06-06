// @argus/web — the PURE, React-free seam that turns the adapter's HONEST degradation signals
// (RunModel.warnings, PlanModel.warnings, PlanModel.coverageRatio) into calm, human-readable
// chip/tooltip strings. The adapter already computes these (boundaries §honesty); the web app
// just has to render them so a degraded run/plan is VISIBLE and EXPLAINED rather than silent.
//
// Kept React-free so it can be unit-tested without jsdom and reused by both the run-header chip
// and the RunOverviewPanel warnings section, and by the plan-header coverage badge.

import type { AdapterWarning } from '@argus/contract';

/** "1 warning" / "3 warnings" — the run-header chip label. Empty for no warnings. */
export function warningCountLabel(warnings: readonly AdapterWarning[]): string {
  const n = warnings.length;
  if (n === 0) return '';
  return `${n} ${n === 1 ? 'warning' : 'warnings'}`;
}

/**
 * The chip's `title` tooltip — the distinct warning codes, comma-separated (codes only, never
 * raw text/paths — the contract guarantees codes are user-safe). Counts repeats so a run with
 * three `journal-bad-lines` reads "journal-bad-lines ×3" instead of a noisy triple-list.
 */
export function summarizeWarningCodes(warnings: readonly AdapterWarning[]): string {
  if (warnings.length === 0) return '';
  const counts = new Map<string, number>();
  for (const w of warnings) counts.set(w.code, (counts.get(w.code) ?? 0) + 1);
  return [...counts.entries()].map(([code, n]) => (n > 1 ? `${code} ×${n}` : code)).join(', ');
}

/** Coverage as a whole-percent integer (0–100), clamped; non-finite/absent → treated as full. */
export function coveragePercent(ratio: number | null | undefined): number {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return 100;
  return Math.round(Math.max(0, Math.min(1, ratio)) * 100);
}

/** A plan/run is "degraded" if coverage is below full OR there is at least one warning. */
export function isDegraded(
  ratio: number | null | undefined,
  warnings: readonly AdapterWarning[],
): boolean {
  return coveragePercent(ratio) < 100 || warnings.length > 0;
}

/**
 * The plan-header coverage badge LABEL: "82% parsed" when coverage is below full, else a calm
 * "partial" (coverage is full but warnings exist). Empty string when not degraded — the caller
 * renders nothing, keeping a clean plan silent.
 */
export function planCoverageLabel(
  ratio: number | null | undefined,
  warnings: readonly AdapterWarning[],
): string {
  if (!isDegraded(ratio, warnings)) return '';
  const pct = coveragePercent(ratio);
  return pct < 100 ? `${pct}% parsed` : 'partial';
}

/** The plan-header coverage badge TOOLTIP: percent parsed + the warning codes when present. */
export function planCoverageTitle(
  ratio: number | null | undefined,
  warnings: readonly AdapterWarning[],
): string {
  const pct = coveragePercent(ratio);
  const base = `${pct}% of the plan source was parsed`;
  if (warnings.length === 0) return base;
  return `${base} · ${summarizeWarningCodes(warnings)}`;
}
