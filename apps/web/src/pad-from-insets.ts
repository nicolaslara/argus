// The no-overlap padding MATH, extracted from App.tsx's chromeAwareFitOptions so the
// inset → React-Flow-Padding calculation is unit-testable WITHOUT a DOM. App still does the
// DOM measuring (querySelector + getBoundingClientRect → raw insets); this module turns those
// measured insets into the per-side pixel-string padding React Flow v12 expects.

/** The measured chrome footprint (CSS px from the live DOM), before margins are added. */
export interface ChromeInsets {
  /** bottom edge of the top chrome (header + objective/failure column). */
  top: number;
  /** right edge of the tall left band (Plan run-history). */
  left: number;
  /** top edge of the bottom agent table panel, measured up from the viewport bottom. */
  bottom: number;
  /** Optional explicit right inset; defaults to a fixed 40px gutter when omitted. */
  right?: number;
}

/** The per-side pixel-string padding React Flow v12 accepts (a subset of its `Padding` union,
 *  kept concrete so callers + tests can read each side). */
export interface SidePadding {
  top: `${number}px`;
  right: `${number}px`;
  bottom: `${number}px`;
  left: `${number}px`;
}

/**
 * Turn measured chrome insets into React Flow v12 padding. Behavior is byte-identical to the
 * inline math chromeAwareFitOptions used:
 *   - top/left/bottom: clamp to >= 0, round, add the per-side margin (+20 top/left, +40 bottom)
 *   - right: the supplied inset (clamped + rounded) when given, else a fixed 40px gutter
 * Every output is a pixel STRING (never a unitless number) so React Flow reads it as px.
 */
export function padFromInsets(insets: ChromeInsets): SidePadding {
  return {
    top: `${Math.round(Math.max(insets.top, 0)) + 20}px`,
    left: `${Math.round(Math.max(insets.left, 0)) + 20}px`,
    right: insets.right == null ? '40px' : `${Math.round(Math.max(insets.right, 0))}px`,
    bottom: `${Math.round(Math.max(insets.bottom, 0)) + 40}px`,
  };
}
