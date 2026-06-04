// @argus/web — layout seam entry point. The execution view (M3) default = the
// deterministic hand-rolled phase-lane engine. The PLAN-AST view (P1b) uses the
// elkjs-backed layered engine, loaded LAZILY here so elk's bundle weight never
// reaches the execution view (boundaries.md §6 / plan-view-design.md §5).

import type { LayoutEngine } from './types.ts';
import { horizontalLaneLayout } from './horizontal-lanes.ts';
import { verticalLaneLayout } from './vertical-lanes.ts';
import type { PlanLayoutInput, PlanLayoutResult } from './elk.ts';

export type { LayoutEngine, LayoutInput, LayoutResult, Placement } from './types.ts';
export { CARD_WIDTH, CARD_HEIGHT } from './horizontal-lanes.ts';
export { horizontalLaneLayout, verticalLaneLayout };
export type {
  PlanLayoutInput,
  PlanLayoutEdgeInput,
  PlanLayoutNodeInput,
  PlanLayoutResult,
  PlanPlacement,
} from './elk.ts';

/**
 * The default execution-view layout: horizontal phase columns (left→right), matching
 * the article's flow. `verticalLaneLayout` stays available behind the same seam.
 */
export const defaultLayout: LayoutEngine = horizontalLaneLayout;

/** The lazily-loaded Plan-AST layout function (elkjs, layered, nested loop containers). */
export type ElkPlanLayout = (input: PlanLayoutInput) => Promise<PlanLayoutResult>;

/**
 * Lazily load the elkjs-backed Plan-AST layout. The dynamic import keeps elkjs out of
 * the main/execution-view chunk; it loads only when the Plan-AST view is first rendered.
 * Implemented (P1b) — no longer throws.
 */
export async function loadElkLayout(): Promise<ElkPlanLayout> {
  const mod = await import('./elk.ts');
  return mod.planLayout;
}
