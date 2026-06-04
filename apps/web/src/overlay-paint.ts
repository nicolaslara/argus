// @argus/web — paintOverlay: morph the SHARED plan layout into the Execution overlay.
//
// PURE, additive, and topology-preserving (the SAME discipline as overlayExplanations):
// it takes the already-laid-out plan graph (from planModelToGraph — the canonical shared
// layout) plus the web-side Overlay (from buildOverlay) and patches ONLY node.data with
// binding fields. It NEVER adds/removes/reorders nodes or edges and NEVER relayouts — so
// selecting a run "paints status onto" the plan template without moving anything. The
// Plan template is the canonical layout; this is the Plan→Execution paint.
//
// No edges are invented: execution inherits the Plan edges already present in the graph.
// Binding lives only in the Overlay; AgentNode/RunModel/mapping.ts are byte-unchanged.

import type { Node } from '@xyflow/react';
import type { Overlay, PlanBinding } from '@argus/contract';
import type { GraphResult } from './mapping.ts';

/** The binding fields painted onto a plan agent/process node's data (read by PlanNodes). */
export interface PaintedBinding {
  bindStatus: PlanBinding['status'];
  bindSucceeded: number;
  bindFailed: number;
  bindTotal: number | 'N';
  bindConfidence: PlanBinding['confidence'];
  bindAmbiguous: boolean;
}

/**
 * Paint an Overlay onto the shared plan graph. Returns a NEW node array with binding
 * fields merged into each bound/planned plan node's data; the original `graph` reference
 * is returned unchanged when there is nothing to paint (so React Flow keeps identity).
 *
 * A lane (phaseLane) is painted with a coarse `laneStatus` derived from its members so a
 * gate-skipped phase (all members not-run) reads as ghosted at the lane level too. Loop
 * containers receive the observed round count + the folded↔unrolled `unrolled` flag (the
 * MODE switch); toggling `unrolled` re-renders the loop header only — no canvas relayout.
 */
export function paintOverlay(graph: GraphResult, overlay: Overlay, unrolled = false): GraphResult {
  if (overlay.bindings.length === 0 && overlay.unplannedAgentIds.length === 0 && overlay.rounds == null) {
    return graph;
  }

  const byNodeId = new Map<string, PlanBinding>();
  for (const b of overlay.bindings) byNodeId.set(b.planNodeId, b);

  // First pass: paint each plan node that has a binding. Track per-lane member statuses
  // (a lane's children carry parentId === the lane node id) for the lane-level rollup.
  const laneMemberStatuses = new Map<string, PlanBinding['status'][]>();

  const painted: Node[] = graph.nodes.map((n) => {
    // Loop containers receive the observed run rounds + the folded↔unrolled mode flag.
    if (n.type === 'planLoop') {
      return { ...n, data: { ...n.data, observedRounds: overlay.rounds, unrolled, painted: true } };
    }
    const b = byNodeId.get(n.id);
    if (!b) return n;
    if (typeof n.parentId === 'string') {
      if (!laneMemberStatuses.has(n.parentId)) laneMemberStatuses.set(n.parentId, []);
      laneMemberStatuses.get(n.parentId)!.push(b.status);
    }
    const fields: PaintedBinding = {
      bindStatus: b.status,
      bindSucceeded: b.succeeded,
      bindFailed: b.failed,
      bindTotal: b.total,
      bindConfidence: b.confidence,
      bindAmbiguous: b.ambiguous,
    };
    return { ...n, data: { ...n.data, ...fields, painted: true } };
  });

  // Second pass: roll a coarse status up to each phase lane (ghost a wholly not-run lane).
  const nodes = painted.map((n) => {
    if (n.type !== 'phaseLane') return n;
    const statuses = laneMemberStatuses.get(n.id);
    if (!statuses || statuses.length === 0) return n;
    const laneStatus = rollupLane(statuses);
    return { ...n, data: { ...n.data, laneStatus } };
  });

  return { nodes, edges: graph.edges };
}

/** Coarse lane status: all not-run → not-run (ghost); any partial/mixed → partial; else complete. */
function rollupLane(statuses: PlanBinding['status'][]): PlanBinding['status'] {
  if (statuses.every((s) => s === 'not-run')) return 'not-run';
  if (statuses.some((s) => s === 'partial') || statuses.some((s) => s === 'not-run')) return 'partial';
  return 'complete';
}
