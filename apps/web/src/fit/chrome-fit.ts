import type { FitViewOptions } from '@xyflow/react';
import { padFromInsets } from '../pad-from-insets.ts';

/**
 * No-overlap invariant: the floating top-left chrome (the run-header chip, the run-chrome
 * column = objective band + failure banner, and the Plan run-history band) sits ABSOLUTE over
 * a full-bleed React Flow canvas, so a fit-viewed graph would otherwise land UNDERNEATH it.
 * We RESERVE the chrome's footprint as per-side fitView padding (React Flow v12 `Padding`),
 * MEASURED from the live DOM so it adapts to a tall failure banner / a long objective / the
 * Plan band — the graph then fits into the clear region (below the top chrome, right of the
 * left band). `top`/`left` only; right/bottom get a small fixed gutter.
 *
 * Extracted from App.tsx (behavior-preserving). App only ever MEASURES the DOM here; the
 * inset → React-Flow-Padding MATH lives in ../pad-from-insets.ts (pure, unit-tested).
 */
export function chromeAwareFitOptions(extra?: Partial<FitViewOptions>): FitViewOptions {
  let top = 0;
  let left = 0;
  let bottom = 0;
  const main = typeof document !== 'undefined' ? document.querySelector('.argus-main') : null;
  if (main) {
    const m = main.getBoundingClientRect();
    // top chrome (the header chip + the objective/failure column) → reserve their bottom edge.
    for (const sel of ['.run-header', '.run-chrome']) {
      const el = document.querySelector(sel);
      if (el) top = Math.max(top, el.getBoundingClientRect().bottom - m.top);
    }
    // the tall left band (Plan run-history) → reserve its right edge.
    const band = document.querySelector('.plan-run-history');
    if (band) left = Math.max(left, band.getBoundingClientRect().right - m.left);
    // the collapsible bottom AGENT TABLE (Table panel) → reserve its top edge so a fit-viewed
    // graph never lands underneath it (keeps the no-overlap invariant when the table is open).
    const table = document.querySelector('.agent-table-panel');
    if (table) bottom = Math.max(bottom, m.bottom - table.getBoundingClientRect().top);
  }
  return {
    // The padding MATH lives in ../pad-from-insets.ts (pure, unit-tested); App only MEASURES.
    padding: padFromInsets({ top, left, bottom }),
    duration: 240,
    maxZoom: 2.6,
    ...extra,
  };
}
