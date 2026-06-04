// @argus/web — layout seam entry point. M3 default = the deterministic vertical
// phase-lane engine. elkjs is the reserved lazy fallback for a future real
// cross-phase DAG (not wired for M3 — see boundaries.md §6).

import type { LayoutEngine } from './types.ts';
import { verticalLaneLayout } from './vertical-lanes.ts';

export type { LayoutEngine, LayoutInput, LayoutResult, Placement } from './types.ts';
export { CARD_WIDTH, CARD_HEIGHT } from './vertical-lanes.ts';

/** The default, engine-agnostic layout used by the M3 canvas. */
export const defaultLayout: LayoutEngine = verticalLaneLayout;

/**
 * Lazily load the elkjs-backed engine (deferred fallback). NOT used by M3; present
 * so the seam is real. Throws until implemented — callers must opt in explicitly.
 */
export async function loadElkLayout(): Promise<LayoutEngine> {
  throw new Error('elk layout is a deferred fallback (not wired for M3)');
}
