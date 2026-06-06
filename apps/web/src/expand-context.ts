// @argus/web — ExpandContext: lets a node's expand caret reach the Run view's
// `toggle(id)` WITHOUT putting a function on `node.data` (xyflow node data must stay a
// serializable-ish snapshot, and a closure there breaks memoization / re-render checks).
// The Run view wraps <ReactFlow> in <ExpandContext.Provider>; a PlanAgentNode caret reads
// the context via `useExpand()` and calls `toggle(node.id)`. Default value is inert (an
// empty set + a no-op) so a node rendered outside a provider never throws.

import { createContext, useContext } from 'react';

/**
 * How a loop step's body subagents are drilled (loop-drill-gallery.html opt1 vs opt2):
 *  - 'round-axis'  (DEFAULT, option 1): the loop CONTAINER shows a clickable round axis; a
 *    round pill routes (loop node id, round) → DetailPanel, where that round's instances are
 *    listed. The loop box stays compact; the back-edge never re-routes.
 *  - 'lane-drawer' (option 2): the loop step's round agents expand AS CARDS inside the loop
 *    compound (a recursive drawer), with the dashed back-edge routing around them. The most
 *    visually consistent with flat fans, but the loop box grows + the back-edge re-routes.
 */
export type LoopDrillMode = 'round-axis' | 'lane-drawer';

export interface ExpandContextValue {
  /** The currently-expanded host node ids (lane-member templates with an open drawer). */
  expanded: Set<string>;
  /** Flip a host node's expanded state. */
  toggle: (id: string) => void;
  /**
   * Select a loop CONTAINER + a specific ROUND from its clickable round axis. The Run view
   * routes this to the DetailPanel (selectedNode = the loop node, scoped to the chosen round)
   * so a loop-body fan's per-round instances become reachable WITHOUT a lane-drawer inside the
   * loop. Inert default (a round pill rendered outside a provider never throws).
   */
  selectRound?: (loopNodeId: string, round: number) => void;
  /**
   * The active loop-drill MODE (the settings toggle). 'round-axis' is the default and keeps
   * option 1 fully working; 'lane-drawer' selects option 2 (the recursive in-loop drawer).
   * Read by LoopContainer + the overlay/expand path. Inert default = 'round-axis'.
   */
  loopDrillMode: LoopDrillMode;
  /**
   * OPTION 2 only: which loop's round drawer is OPEN in-canvas (loopNodeId → the open round).
   * LoopContainer reads it to mark the open round pill as expanded (so the round axis shows
   * which round's cards are drawn inside the loop). Absent/empty in 'round-axis' mode.
   */
  openLoopRound?: Map<string, number>;
}

const DEFAULT: ExpandContextValue = {
  expanded: new Set<string>(),
  toggle: () => {},
  selectRound: () => {},
  loopDrillMode: 'round-axis',
};

export const ExpandContext = createContext<ExpandContextValue>(DEFAULT);

/** Read the expand state + toggle from the nearest provider (inert default if none). */
export function useExpand(): ExpandContextValue {
  return useContext(ExpandContext);
}
