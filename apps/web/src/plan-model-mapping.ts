// @argus/web — the Plan-AST view mapping: a rich PlanModel (from the /plan endpoint)
// → @xyflow/react nodes + edges, laid out by elkjs (layered, nested loop containers).
// PURE async function of (PlanModel, elkLayout); no React, no I/O of its own (elk is
// injected). This is the FIRST time the AST-derived structure is shown to a human.
//
// node kinds map (plan-view-design.md §3.1):
//   agent     -> planAgent     edge kinds (§3.2) distinguished by DASH / CURVATURE,
//   process   -> planProcess   never color (saturation is reserved for run state):
//   decision  -> planDecision    flow      solid straight
//   loop      -> planLoop (group) fanout   solid, 1→N spawn
//   output    -> planOutput     merge     solid, N→1 barrier join
//   unparsed  -> planUnparsed   optional  DASHED off a decision (true/false label)
//   pipeline/subworkflow -> planProcess(op)  loop-back DASHED, labeled w/ stop condition
//
// Confidence is encoded as a node BORDER style by the node components (declared/static/
// heuristic), never as edge color. The single multiplicity glyph is a node decoration.

import type { Edge, Node } from '@xyflow/react';
import type {
  DecisionNode,
  LoopNode,
  PlanEdge,
  PlanModel,
  PlanNode,
} from '@argus/contract';
import type { GraphResult } from './mapping.ts';
import type { ElkPlanLayout } from './layout/index.ts';
import type { PlanLayoutInput, PlanLayoutNodeInput } from './layout/index.ts';
import {
  PLAN_AGENT_W,
  PLAN_AGENT_H,
  PLAN_PROCESS_W,
  PLAN_PROCESS_H,
  PLAN_DECISION_SIZE,
  PLAN_OUTPUT_W,
  PLAN_OUTPUT_H,
  PLAN_UNPARSED_W,
  PLAN_UNPARSED_H,
  type PlanAgentData,
  type PlanProcessData,
  type PlanDecisionData,
  type PlanLoopData,
  type PlanOutputData,
  type PlanUnparsedData,
} from './nodes/PlanNodes.tsx';

const EDGE_COLOR = '#475160'; // ONE neutral edge color; kind is carried by dash/curve.

interface KindGeom {
  type: string;
  width: number;
  height: number;
}

function geomFor(node: PlanNode): KindGeom {
  switch (node.kind) {
    case 'agent':
      return { type: 'planAgent', width: PLAN_AGENT_W, height: PLAN_AGENT_H };
    case 'decision':
      return { type: 'planDecision', width: PLAN_DECISION_SIZE, height: PLAN_DECISION_SIZE };
    case 'output':
    case 'input':
      return { type: 'planOutput', width: PLAN_OUTPUT_W, height: PLAN_OUTPUT_H };
    case 'unparsed':
      return { type: 'planUnparsed', width: PLAN_UNPARSED_W, height: PLAN_UNPARSED_H };
    case 'process':
    case 'pipeline':
    case 'subworkflow':
    default:
      return { type: 'planProcess', width: PLAN_PROCESS_W, height: PLAN_PROCESS_H };
  }
}

/** Loop container header band + padding (kept in sync with the elk container padding). */
const LOOP_FALLBACK_W = 360;
const LOOP_FALLBACK_H = 120;

function dataFor(node: PlanNode): Record<string, unknown> {
  const base = { confidence: node.confidence, optional: node.optional };
  switch (node.kind) {
    case 'agent': {
      const d: PlanAgentData = {
        ...base,
        title: node.title,
        labelRaw: node.labelTemplate?.raw ?? null,
        subtitle: node.annotation.subtitle,
        agentType: node.agentType,
        typed: node.annotation.typed,
        multiplicity: node.multiplicity,
      };
      return d;
    }
    case 'process': {
      const role: PlanProcessData['role'] =
        node.title === 'fan-out' ? 'split' : node.title === 'merge' ? 'merge' : 'op';
      const d: PlanProcessData = { ...base, title: node.title, role, multiplicity: node.multiplicity };
      return d;
    }
    case 'pipeline':
    case 'subworkflow': {
      const d: PlanProcessData = { ...base, title: node.title, role: 'op', multiplicity: node.multiplicity };
      return d;
    }
    case 'decision': {
      const dec = node as DecisionNode;
      const d: PlanDecisionData = {
        ...base,
        conditionLabel: dec.conditionLabel,
        conditionKind: dec.conditionKind,
      };
      return d;
    }
    case 'loop': {
      const loop = node as LoopNode;
      const d: PlanLoopData = {
        confidence: node.confidence,
        title: loop.title,
        stopCondition: loop.stopCondition,
        maxRounds: loop.maxRounds,
      };
      return d;
    }
    case 'output':
    case 'input': {
      const d: PlanOutputData = { confidence: node.confidence, title: node.title };
      return d;
    }
    case 'unparsed':
    default: {
      const d: PlanUnparsedData = { title: node.title, span: node.annotation.span ?? null };
      return d;
    }
  }
}

/** Edge visual: distinguished by DASH + CURVATURE only (kind is never carried by color). */
function edgeStyle(edge: PlanEdge): Pick<Edge, 'type' | 'animated' | 'style' | 'label' | 'labelStyle' | 'labelBgStyle'> {
  const base = { stroke: EDGE_COLOR, strokeWidth: 1.6 };
  switch (edge.kind) {
    case 'fanout':
      // 1→N spawn: straight, solid, slightly emphasized.
      return { type: 'default', animated: false, style: { ...base, strokeWidth: 1.8 } };
    case 'merge':
      // N→1 barrier join: straight, solid.
      return { type: 'default', animated: false, style: base };
    case 'optional':
      // conditional branch off a decision: DASHED, carries the true/false label.
      return {
        type: 'default',
        animated: false,
        style: { ...base, strokeDasharray: '5 4' },
        label: edge.label,
        labelStyle: { fill: '#9aa4b2', fontSize: 11 },
        labelBgStyle: { fill: '#0b0d10', fillOpacity: 0.85 },
      };
    case 'loop-back':
      // back-edge: DASHED + curved (smoothstep), labeled with the stop condition.
      return {
        type: 'smoothstep',
        animated: false,
        style: { ...base, strokeDasharray: '6 4', stroke: '#6b7280' },
        label: edge.label,
        labelStyle: { fill: '#9aa4b2', fontSize: 11 },
        labelBgStyle: { fill: '#0b0d10', fillOpacity: 0.85 },
      };
    case 'flow':
    default:
      // sequential: straight, solid.
      return { type: 'default', animated: false, style: base };
  }
}

/**
 * Map a PlanModel onto xyflow nodes/edges using the elk layout. Async (elk is async).
 * The loop container is a real nested compound node: its children carry `parentId` so
 * xyflow nests them, and elk lays the body out inside the container's box.
 */
export async function planModelToGraph(plan: PlanModel, elkLayout: ElkPlanLayout): Promise<GraphResult> {
  // Which node ids are loop bodies (→ parented to the loop container)?
  const loopOf = new Map<string, string>(); // childId -> loopContainerId
  const loopIds = new Set<string>();
  for (const n of plan.nodes) {
    if (n.kind === 'loop') loopIds.add(n.id);
    if (n.loopRef) loopOf.set(n.id, n.loopRef);
  }

  // Build the elk input: every node, with parentId = its loop container (if any).
  const layoutNodes: PlanLayoutNodeInput[] = plan.nodes.map((n) => {
    if (n.kind === 'loop') {
      return { id: n.id, width: LOOP_FALLBACK_W, height: LOOP_FALLBACK_H, parentId: null, isContainer: true };
    }
    const g = geomFor(n);
    return { id: n.id, width: g.width, height: g.height, parentId: loopOf.get(n.id) ?? null, isContainer: false };
  });

  // Edges: elk needs only the topology. The loop-back edge IS routed (it closes the loop).
  const layoutInput: PlanLayoutInput = {
    nodes: layoutNodes,
    edges: plan.edges.map((e) => ({ id: e.id, from: e.from, to: e.to })),
  };

  const { placements } = await elkLayout(layoutInput);

  const nodes: Node[] = [];
  for (const n of plan.nodes) {
    const p = placements.get(n.id);
    if (!p) continue;
    const geom = n.kind === 'loop' ? { type: 'planLoop' } : geomFor(n);
    const parentId = loopOf.get(n.id);
    if (parentId) {
      // Child of a loop container: position is RELATIVE to the container (xyflow parent).
      const parent = placements.get(parentId);
      const rx = parent ? p.x - parent.x : p.x;
      const ry = parent ? p.y - parent.y : p.y;
      nodes.push({
        id: n.id,
        type: geom.type,
        parentId,
        extent: 'parent',
        position: { x: rx, y: ry },
        data: dataFor(n),
        draggable: false,
        selectable: false,
      });
    } else if (n.kind === 'loop') {
      // The loop container group node: absolute, sized by elk.
      nodes.push({
        id: n.id,
        type: 'planLoop',
        position: { x: p.x, y: p.y },
        data: dataFor(n),
        draggable: false,
        selectable: false,
        style: { width: p.width, height: p.height },
      });
    } else {
      nodes.push({
        id: n.id,
        type: geom.type,
        position: { x: p.x, y: p.y },
        data: dataFor(n),
        draggable: false,
        selectable: false,
      });
    }
  }

  // xyflow requires a group/parent node to appear BEFORE its children in the array.
  nodes.sort((a, b) => {
    const aLoop = a.type === 'planLoop' ? 0 : 1;
    const bLoop = b.type === 'planLoop' ? 0 : 1;
    return aLoop - bLoop;
  });

  const edges: Edge[] = plan.edges.map((e) => {
    const decision = plan.nodes.find((n) => n.id === e.from && n.kind === 'decision');
    const sourceHandle =
      e.kind === 'optional' && decision ? (e.label === 'false' ? 'false' : 'true') : undefined;
    return {
      id: e.id,
      source: e.from,
      target: e.to,
      sourceHandle,
      ...edgeStyle(e),
    };
  });

  return { nodes, edges };
}
