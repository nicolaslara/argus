// @argus/web — P0 Plan view (run-free): map a static WorkflowMeta onto @xyflow/react
// nodes + edges. Pure function of (WorkflowMeta, engine); no I/O, no React. This is the
// "review-the-workflow" mode — a workflow's DECLARED intent, with NO run, NO AST, NO
// agents, NO overlay. It emits ONLY:
//   - one PhaseLane node per declared phase (top→down by 1-based index), carrying the
//     phase title + its meta detail as a subtitle (text node, 2-line clamped)
//   - the single synthesized phase_i→phase_i+1 spine edge (no edges beyond the spine)
//
// It reuses the M3 vertical-lanes layout with EMPTY agentIds per phase, so the geometry
// stays the deterministic, jitter-free lane stack. runModelToGraph is left untouched.

import type { Edge, Node } from '@xyflow/react';
import type { WorkflowMeta } from '@argus/contract';
import type { PhaseLaneData } from './nodes/PhaseLane.tsx';
import { defaultLayout, type LayoutEngine, type LayoutInput } from './layout/index.ts';
import type { GraphResult } from './mapping.ts';

export function planMetaToGraph(meta: WorkflowMeta, engine: LayoutEngine = defaultLayout): GraphResult {
  // Declared phases -> 1-based lanes, top→down. No agents: every lane is agent-free, so
  // the layout collapses to a clean vertical title/subtitle stack.
  const layoutInput: LayoutInput = {
    phases: meta.phases.map((phase, i) => ({
      index: i + 1,
      title: phase.title,
      agentIds: [],
    })),
  };
  const placed = engine.layout(layoutInput);

  const nodes: Node[] = [];
  meta.phases.forEach((phase, i) => {
    const index = i + 1;
    const lane = placed.lanes.get(index);
    if (!lane) return;
    const data: PhaseLaneData = {
      index,
      title: phase.title,
      agentCount: 0,
      hideAgentCount: true, // run-free: no run, no agents to count
      subtitle: phase.detail,
    };
    nodes.push({
      id: laneNodeId(index),
      type: 'phaseLane',
      position: { x: lane.x, y: lane.y },
      data,
      draggable: false,
      selectable: false,
      style: { width: lane.width, height: lane.height },
    });
  });

  // Edges: ONLY the synthesized phase_i→phase_i+1 spine (no edges beyond the spine).
  const edges: Edge[] = [];
  for (let i = 1; i < meta.phases.length; i += 1) {
    edges.push({
      id: `spine-${i}-${i + 1}`,
      source: laneNodeId(i),
      target: laneNodeId(i + 1),
      type: 'smoothstep',
      animated: false,
      style: { stroke: '#30363d', strokeWidth: 2 },
    });
  }

  return { nodes, edges };
}

function laneNodeId(phaseIndex: number): string {
  return `phase-${phaseIndex}`;
}
