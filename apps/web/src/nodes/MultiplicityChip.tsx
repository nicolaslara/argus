// @argus/web — the ONE multiplicity glyph (plan-view-design.md §3.4).
//
// A single corner count chip (`×5` for fixed, `1..N` for unbounded) + a single
// stacked-card silhouette behind the node — NOT five stacked markers. `sourceExpr`
// ("one per item in WORKPADS") is NOT on the canvas; it goes to the hover title only.
// Field-driven decoration shared by every plan node kind, not a separate node kind.
//
// All text is React text nodes (no dangerouslySetInnerHTML); the values are derived
// from the adapter's structured Multiplicity, never from raw user content.

import type { Multiplicity } from '@argus/contract';

/** Is this node fanned out (renders the stacked silhouette + a count chip)? */
export function isFanned(m: Multiplicity): boolean {
  return m.kind !== 'one';
}

/** The corner glyph label: `×N` (fixed) or `1..N` (unbounded). */
export function multiplicityLabel(m: Multiplicity): string | null {
  if (m.kind === 'fixed') return `×${m.n}`;
  if (m.kind === 'unbounded') return m.min > 0 ? `${m.min}..N` : '1..N';
  return null;
}

/** The hover detail (kept OFF the canvas per §3.4) — the source expr / floor. */
export function multiplicityTitle(m: Multiplicity): string | undefined {
  if (m.kind === 'unbounded') {
    return m.sourceExpr ?? `runtime count (at least ${m.min})`;
  }
  if (m.kind === 'fixed') return `${m.n} instances`;
  return undefined;
}

/**
 * The single multiplicity glyph (`×N` / `1..N`). Two render variants (U1):
 *   - 'corner' (default): the absolute top-right corner glyph rendered by the card
 *     shell's positioned container (`.agent-shell` is `position:relative`).
 *   - 'inline': a footer chip in the plan card's chip row, matching the typed/optional
 *     chip family — so the plan footer reads as one chip strip.
 * A non-fanned (one) node renders nothing in either variant.
 */
export function MultiplicityChip({
  multiplicity,
  variant = 'corner',
}: {
  multiplicity: Multiplicity;
  variant?: 'corner' | 'inline';
}) {
  if (!isFanned(multiplicity)) return null;
  const label = multiplicityLabel(multiplicity);
  if (!label) return null;
  if (variant === 'inline') {
    return (
      <span className="agent-chip agent-chip-mult" title={multiplicityTitle(multiplicity)}>
        {label}
      </span>
    );
  }
  return (
    <span className="plan-mult-chip" title={multiplicityTitle(multiplicity)}>
      {label}
    </span>
  );
}
