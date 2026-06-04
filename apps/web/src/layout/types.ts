// @argus/web — the swappable layout seam (boundaries.md §6).
//
// The render pipeline maps a RunModel onto an engine-agnostic LayoutGraph, then a
// LayoutEngine assigns absolute (x,y) + sizes. M3 ships a deterministic hand-rolled
// vertical phase-lane engine as the DEFAULT; elkjs is reserved as a lazy/deferred
// fallback for a future real cross-phase DAG (not wired for M3). Keeping the engine
// behind this interface means the viz layer is replaceable without touching mapping.

export interface LayoutPhaseInput {
  /** 1-based phase index. */
  index: number;
  title: string;
  /** agentIds belonging to this phase, in render order. */
  agentIds: string[];
}

export interface LayoutInput {
  phases: LayoutPhaseInput[];
}

/** Absolute placement of a node in canvas coordinates. */
export interface Placement {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutResult {
  /** phase lane container placements, keyed by 1-based phase index. */
  lanes: Map<number, Placement>;
  /** agent card placements, keyed by agentId. Coordinates are RELATIVE to the lane. */
  agents: Map<string, Placement>;
}

export interface LayoutEngine {
  readonly id: string;
  layout(input: LayoutInput): LayoutResult;
}
