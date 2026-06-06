// @argus/web — ExpandContext: lets a node's expand caret reach the Run view's
// `toggle(id)` WITHOUT putting a function on `node.data` (xyflow node data must stay a
// serializable-ish snapshot, and a closure there breaks memoization / re-render checks).
// The Run view wraps <ReactFlow> in <ExpandContext.Provider>; a PlanAgentNode caret reads
// the context via `useExpand()` and calls `toggle(node.id)`. Default value is inert (an
// empty set + a no-op) so a node rendered outside a provider never throws.

import { createContext, useContext } from 'react';

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
}

const DEFAULT: ExpandContextValue = {
  expanded: new Set<string>(),
  toggle: () => {},
  selectRound: () => {},
};

export const ExpandContext = createContext<ExpandContextValue>(DEFAULT);

/** Read the expand state + toggle from the nearest provider (inert default if none). */
export function useExpand(): ExpandContextValue {
  return useContext(ExpandContext);
}
