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
}

const DEFAULT: ExpandContextValue = {
  expanded: new Set<string>(),
  toggle: () => {},
};

export const ExpandContext = createContext<ExpandContextValue>(DEFAULT);

/** Read the expand state + toggle from the nearest provider (inert default if none). */
export function useExpand(): ExpandContextValue {
  return useContext(ExpandContext);
}
