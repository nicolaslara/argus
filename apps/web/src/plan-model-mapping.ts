// @argus/web — the Plan-AST view mapping: a rich PlanModel (from the /plan endpoint)
// → @xyflow/react nodes + edges, laid out by elkjs (layered, nested loop containers).
// PURE async function of (PlanModel, elkLayout); no React, no I/O of its own (elk is
// injected). This is the FIRST time the AST-derived structure is shown to a human.
//
// U1 (unify Plan & Execution): the Plan-AST view now draws the SAME phase-lane
// containers the execution view uses — top-level nodes are grouped by PlanNode.phaseRef
// into PhaseLane group nodes (reusing PhaseLane.tsx with the PlanLane.detail subtitle +
// hideAgentCount). So BOTH views read as 'phase lanes of agent cards'; the plan view
// additionally draws the structural connectors (fan-out / merge / decision / loop) +
// multiplicity INSIDE those lanes. elk still does the intra-DAG layout; we derive the
// lane bounding boxes from elk's placements, then reparent the lane members.
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
  PlanLane,
  PlanModel,
  PlanNode,
} from '@argus/contract';
import type { GraphResult } from './mapping.ts';
import type { ElkPlanLayout } from './layout/index.ts';
import type { PlanLayoutInput, PlanLayoutNodeInput, PlanPlacement } from './layout/index.ts';
import type { PhaseLaneData } from './nodes/PhaseLane.tsx';
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

// Phase-lane container insets (mirror the execution lane look in PhaseLane.tsx / index.css).
const LANE_HEADER_H = 56; // phase index + title row (matches .phase-lane-header)
const LANE_SUBTITLE_H = 44; // room for the 2-line PlanLane.detail subtitle
const LANE_PAD_X = 22;
const LANE_PAD_BOTTOM = 22;

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

function laneNodeId(index: number): string {
  return `plan-lane-${index}`;
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Map a PlanModel onto xyflow nodes/edges using the elk layout, then GROUP the top-level
 * nodes into the same phase-lane containers the execution view uses (U1). Async (elk is
 * async). The loop container remains a real nested compound node: its body children carry
 * `parentId`; the loop container itself is parented to its phaseRef lane (if any).
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

  const nodeById = new Map<string, PlanNode>();
  for (const n of plan.nodes) nodeById.set(n.id, n);

  // ---- Phase-lane grouping (U1) --------------------------------------------------
  // A node is a LANE MEMBER iff it is TOP-LEVEL (not a loop body) AND has a phaseRef
  // that resolves to a declared lane. Loop bodies stay parented to their loop; the loop
  // container itself can be a lane member. Nodes without a phaseRef stay top-level
  // (defensive — we never invent a lane the model doesn't support).
  const laneByIndex = new Map<number, PlanLane>();
  for (const l of plan.lanes) laneByIndex.set(l.index, l);

  const laneMembers = new Map<number, string[]>(); // laneIndex -> top-level member ids
  for (const n of plan.nodes) {
    if (loopOf.has(n.id)) continue; // a loop body — laid out inside its loop, not a lane
    if (n.phaseRef == null || !laneByIndex.has(n.phaseRef)) continue;
    if (!placements.has(n.id)) continue;
    if (!laneMembers.has(n.phaseRef)) laneMembers.set(n.phaseRef, []);
    laneMembers.get(n.phaseRef)!.push(n.id);
  }

  // Compute each populated lane's bounding box (over its members' absolute rects), then
  // pad: header + subtitle on top, symmetric x-pad, bottom pad.
  const laneBox = new Map<number, Box & { x: number; y: number; w: number; h: number }>();
  for (const [idx, ids] of laneMembers) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const id of ids) {
      const p = placements.get(id)!;
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + p.width);
      maxY = Math.max(maxY, p.y + p.height);
    }
    const x = minX - LANE_PAD_X;
    const headerTotal = LANE_HEADER_H + LANE_SUBTITLE_H;
    const y = minY - headerTotal;
    const w = maxX - minX + LANE_PAD_X * 2;
    const h = maxY - minY + headerTotal + LANE_PAD_BOTTOM;
    laneBox.set(idx, { minX, minY, maxX, maxY, x, y, w, h });
  }

  const nodes: Node[] = [];

  // 1) Phase-lane group nodes FIRST (xyflow requires parents before children).
  for (const l of plan.lanes) {
    const box = laneBox.get(l.index);
    if (!box) continue; // no members → no lane drawn (never an empty phantom lane)
    const data: PhaseLaneData = {
      index: l.index,
      title: l.title,
      agentCount: 0,
      hideAgentCount: true, // plan template: ×N multiplicity lives on the cards, not a count
      subtitle: l.detail,
    };
    nodes.push({
      id: laneNodeId(l.index),
      type: 'phaseLane',
      position: { x: box.x, y: box.y },
      data,
      draggable: false,
      selectable: false,
      style: { width: box.w, height: box.h },
    });
  }

  // 2) Loop containers (group nodes) — parented to their lane when they have one, so the
  //    nesting is lane > loop > bodies. Absolute or lane-relative depending on parenting.
  const laneOfTop = new Map<string, number>(); // top-level nodeId -> laneIndex (if a member)
  for (const [idx, ids] of laneMembers) for (const id of ids) laneOfTop.set(id, idx);

  for (const n of plan.nodes) {
    if (n.kind !== 'loop') continue;
    const p = placements.get(n.id);
    if (!p) continue;
    const laneIdx = laneOfTop.get(n.id);
    const parentId = laneIdx != null ? laneNodeId(laneIdx) : undefined;
    const rel = parentId ? relTo(p, laneBox.get(laneIdx!)!) : { x: p.x, y: p.y };
    nodes.push({
      id: n.id,
      type: 'planLoop',
      ...(parentId ? { parentId, extent: 'parent' as const } : {}),
      position: rel,
      data: dataFor(n),
      draggable: false,
      selectable: false,
      style: { width: p.width, height: p.height },
    });
  }

  // 3) Every non-loop node: a loop body (parented to its loop), a lane member (parented
  //    to its lane, lane-relative), or an unparented top-level node (absolute).
  for (const n of plan.nodes) {
    if (n.kind === 'loop') continue;
    const p = placements.get(n.id);
    if (!p) continue;
    const geom = geomFor(n);

    const loopParent = loopOf.get(n.id);
    if (loopParent) {
      // Child of a loop container: position RELATIVE to the loop (xyflow parent).
      const parent = placements.get(loopParent);
      const rx = parent ? p.x - parent.x : p.x;
      const ry = parent ? p.y - parent.y : p.y;
      nodes.push({
        id: n.id,
        type: geom.type,
        parentId: loopParent,
        extent: 'parent',
        position: { x: rx, y: ry },
        data: dataFor(n),
        draggable: false,
        selectable: false,
      });
      continue;
    }

    const laneIdx = laneOfTop.get(n.id);
    if (laneIdx != null) {
      // Lane member: position RELATIVE to the lane container.
      const box = laneBox.get(laneIdx)!;
      nodes.push({
        id: n.id,
        type: geom.type,
        parentId: laneNodeId(laneIdx),
        extent: 'parent',
        position: relTo(p, box),
        data: dataFor(n),
        draggable: false,
        selectable: false,
      });
      continue;
    }

    // Unparented top-level node (no resolvable phaseRef): absolute placement.
    nodes.push({
      id: n.id,
      type: geom.type,
      position: { x: p.x, y: p.y },
      data: dataFor(n),
      draggable: false,
      selectable: false,
    });
  }

  // xyflow requires a parent node to appear BEFORE its children: phase lanes, then loop
  // containers, then leaf nodes. (Lanes are already pushed first; sort stabilizes the
  // loop-before-its-bodies invariant for the mixed leaf/loop section.)
  const rank = (t: string | undefined): number => (t === 'phaseLane' ? 0 : t === 'planLoop' ? 1 : 2);
  nodes.sort((a, b) => rank(a.type) - rank(b.type));

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

/** Absolute placement → coordinates relative to a lane's top-left origin. */
function relTo(p: PlanPlacement, box: { x: number; y: number }): { x: number; y: number } {
  return { x: p.x - box.x, y: p.y - box.y };
}
