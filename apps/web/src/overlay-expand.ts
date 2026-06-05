// @argus/web — expandInstances: the PURE, ELK-free drawer re-flow for the merged Run view
// (run-view-merge-plan.md §2 "How a planned step expands to its instances").
//
// Runs AFTER paintOverlay. For each EXPANDED template node that is a lane-member fan-out,
// it resolves the painted `bindAgentIds` → `run.agents` → instance cards (via the shared
// `agentToCardData` from mapping.ts), emits an `instanceGroup` drawer parented to the host
// lane, grows the host lane, shifts same-lane siblings below the template down by the
// drawer height, and emits grid `agentCard` children. It is a pure arithmetic re-flow:
//
//   - NO second ELK pass (spine/merge edges are waypoint-free, so React Flow re-docks them
//     to the moved handles for free — `plan-model-mapping.ts:426-437`). Edges are returned
//     UNCHANGED here.
//   - It returns a NEW graph (new node array, new edge ref kept) and NEVER mutates inputs.
//   - It touches ONLY the host lane (X is safe — disjoint ELK bands; Y is safe — siblings
//     in the SAME lane are the only ones that can overlap a grown drawer).
//
// Instance cards are emitted WITHOUT `extent:'parent'` (unlike normal lane members) so a
// sizing error OVERFLOWS visibly rather than silently clipping a real agent. Parent-before-
// child order is re-established by APPENDING lane(copy) is left in place + drawer + cards at
// the end (so every child's array index > its parent's index — React Flow drops/mis-parents
// a child that precedes its parent).

import type { Edge, Node } from '@xyflow/react';
import type { AgentNode, Overlay, RunModel } from '@argus/contract';
import type { GraphResult } from './mapping.ts';
import { agentToCardData } from './mapping.ts';
import { CARD_SHELL_WIDTH, CARD_SHELL_HEIGHT_EXEC } from './nodes/AgentCardShell.tsx';

// --- drawer geometry (one source of truth; lane growth reads the drawer's own height) ---
/** Per-instance card cell footprint inside the drawer grid. */
const CARD_W = CARD_SHELL_WIDTH;
const CARD_H = CARD_SHELL_HEIGHT_EXEC;
/** Gaps between grid cells + the drawer's inner padding. */
const CELL_GAP_X = 16;
const CELL_GAP_Y = 16;
const DRAWER_PAD_X = 18;
const DRAWER_PAD_TOP = 40; // drawer header band (label + aggregate chip + [▴])
const DRAWER_PAD_BOTTOM = 18;
/** The vertical gap between the host template node and its drawer below it. */
export const DRAWER_GAP = 20;

/** Column count for N instances: clamp(ceil(sqrt(N)), 2, 5) — a roughly-square, bounded grid. */
export function drawerCols(n: number): number {
  return Math.min(5, Math.max(2, Math.ceil(Math.sqrt(Math.max(n, 1)))));
}

interface DrawerSize {
  width: number;
  height: number;
  cols: number;
  rows: number;
}

/**
 * The explicit drawer `style:{width,height}` for N instances:
 *   width  = cols × cardW (+ gaps + side padding)
 *   height = header + ceil(N/cols) card rows + ONE ghost row (+ gaps + bottom padding)
 * The ghost row is the "upcoming slot" gutter — it keeps the drawer from hugging the last
 * real card and reserves room for the dashed upcoming-instance placeholder.
 */
export function drawerSize(n: number): DrawerSize {
  const cols = drawerCols(n);
  const cardRows = Math.ceil(Math.max(n, 1) / cols);
  const rows = cardRows + 1; // + one ghost row
  const width = DRAWER_PAD_X * 2 + cols * CARD_W + (cols - 1) * CELL_GAP_X;
  const height =
    DRAWER_PAD_TOP + rows * CARD_H + (rows - 1) * CELL_GAP_Y + DRAWER_PAD_BOTTOM;
  return { width, height, cols, rows };
}

/** The lane-relative grid position of the i-th card inside the drawer (drawer-relative). */
function cardCellPosition(i: number, cols: number): { x: number; y: number } {
  const col = i % cols;
  const row = Math.floor(i / cols);
  return {
    x: DRAWER_PAD_X + col * (CARD_W + CELL_GAP_X),
    y: DRAWER_PAD_TOP + row * (CARD_H + CELL_GAP_Y),
  };
}

const drawerNodeId = (templateId: string): string => `instances-${templateId}`;
const cardNodeId = (templateId: string, agentId: string, i: number): string =>
  `inst-${templateId}-${agentId || 'x'}-${i}`;

/** Read a node's explicit style width/height (group nodes carry size in style). */
function styleSize(n: Node): { width: number; height: number } {
  const s = (n.style ?? {}) as { width?: number; height?: number };
  return { width: s.width ?? 0, height: s.height ?? 0 };
}

/**
 * Expand the given template nodes' fan-outs into in-lane instance drawers.
 *
 * @param graph   the painted plan graph (output of paintOverlay) — NOT mutated.
 * @param overlay the (plan, run) overlay (the bindings live painted on node.data already;
 *                kept in the signature as the contract source of truth for the binding).
 * @param run     the run whose agents the bound ids resolve against (for the instance cards).
 * @param expandedNodeIds the host template node ids whose drawers are open.
 * @param live    whether the painted run is live (threaded for parity with paintOverlay;
 *                does not change the layout arithmetic here).
 * @returns a NEW GraphResult with drawer + card nodes inserted and the host lanes re-flowed.
 */
export function expandInstances(
  graph: GraphResult,
  overlay: Overlay,
  run: RunModel,
  expandedNodeIds: Set<string>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- threaded for parity with paintOverlay; arithmetic is live-independent
  live = false,
): GraphResult {
  if (expandedNodeIds.size === 0) return graph;

  // Index for fast lookup; the run agents are resolved by agentId from the painted ids.
  const agentById = new Map<string, AgentNode>();
  for (const a of run.agents) agentById.set(a.agentId, a);

  // The set of plan nodes that actually bound agents (defensive parity with the painted
  // data; we read bindAgentIds off node.data, but cross-check against the overlay so a
  // stale/foreign id can't fabricate a drawer).
  const boundByPlanNode = new Map<string, string[]>();
  for (const b of overlay.bindings) boundByPlanNode.set(b.planNodeId, b.agentIds);

  // Working copy of the node array (every node a NEW object once we may touch it). We index
  // nodes by id so we can resolve a template's host lane + its same-lane siblings.
  const byId = new Map<string, Node>();
  for (const n of graph.nodes) byId.set(n.id, n);

  // Collect the drawers to emit + the per-lane growth/shift to apply.
  interface PendingDrawer {
    templateId: string;
    laneId: string;
    cards: Node[];
    drawer: Node;
    drawerH: number; // = drawer.height + DRAWER_GAP
    templateBottomY: number; // lane-relative bottom edge of the template (shift threshold)
  }
  const pending: PendingDrawer[] = [];

  for (const templateId of expandedNodeIds) {
    const template = byId.get(templateId);
    if (!template) continue;
    // A fan-out host is a LANE MEMBER (parentId resolves to a phaseLane). A loop-body fan
    // (parented to a planLoop) is Phase-2 work — skip it here (do not lane-drawer a loop).
    const laneId = typeof template.parentId === 'string' ? template.parentId : null;
    if (!laneId) continue;
    const lane = byId.get(laneId);
    if (!lane || lane.type !== 'phaseLane') continue;

    // Resolve bindAgentIds (painted on node.data) → run agents → instance cards. Prefer the
    // painted ids but intersect with the overlay binding so only genuinely-bound ids count.
    const painted = (template.data ?? {}) as { bindAgentIds?: string[] };
    const overlayIds = boundByPlanNode.get(templateId);
    const sourceIds = painted.bindAgentIds ?? overlayIds ?? [];
    const agents: AgentNode[] = [];
    for (const id of sourceIds) {
      const a = agentById.get(id);
      if (a) agents.push(a);
    }
    if (agents.length === 0) continue; // nothing bound → nothing to expand

    const n = agents.length;
    const size = drawerSize(n);

    // The template's lane-relative geometry: its position is already lane-relative (it has
    // extent:'parent'), and its height is the plan agent card height.
    const templateY = template.position.y;
    const templateH = styleSize(template).height || CARD_SHELL_HEIGHT_EXEC;
    const templateX = template.position.x;
    const templateBottomY = templateY + templateH;

    // The drawer sits directly below the template, left-aligned to it, inside the lane.
    const drawer: Node = {
      id: drawerNodeId(templateId),
      type: 'instanceGroup',
      parentId: laneId,
      // NO extent:'parent' on the drawer body either — a host-lane sizing error must
      // overflow visibly, not clip the drawer (honest about a re-flow miscalculation).
      position: { x: templateX, y: templateBottomY + DRAWER_GAP },
      data: {
        // Carry the host template's painted aggregate fields so the drawer header can render
        // the same `aggregateChipText` (`research ×7 · 6/7 done · 1 failed`) verbatim.
        ...(template.data ?? {}),
        templateId,
        instanceCount: n,
      },
      draggable: false,
      selectable: false,
      // EXPLICIT size — lane growth reads this same value (one source of truth).
      style: { width: size.width, height: size.height },
    };

    // The grid agent cards, drawer-relative, WITHOUT extent:'parent'.
    const cards: Node[] = agents.map((agent, i) => {
      const pos = cardCellPosition(i, size.cols);
      return {
        id: cardNodeId(templateId, agent.agentId, i),
        type: 'agentCard',
        parentId: drawer.id,
        position: pos,
        data: agentToCardData(agent),
        draggable: false,
        selectable: false,
      } as Node;
    });

    const drawerH = size.height + DRAWER_GAP;
    pending.push({ templateId, laneId, cards, drawer, drawerH, templateBottomY });
  }

  if (pending.length === 0) return graph;

  // --- apply lane growth + same-lane sibling shift (new node objects only when touched) ---
  // Accumulate per-lane growth (multiple drawers can open in one lane) and, per drawer, the
  // shift threshold (lane-relative templateBottomY) → shift amount (drawerH).
  const laneGrowth = new Map<string, number>();
  for (const p of pending) laneGrowth.set(p.laneId, (laneGrowth.get(p.laneId) ?? 0) + p.drawerH);

  const out: Node[] = graph.nodes.map((n) => {
    // Grow the host lane(s) by exactly the sum of their drawers' drawerH.
    const grow = laneGrowth.get(n.id);
    if (grow != null && n.type === 'phaseLane') {
      const { width, height } = styleSize(n);
      return { ...n, style: { ...(n.style ?? {}), width, height: height + grow } };
    }
    // Shift same-lane siblings BELOW a template down by that template's drawerH. A node is a
    // sibling iff it is parented to the same lane; the threshold is the template's bottom Y.
    if (typeof n.parentId === 'string') {
      let shift = 0;
      for (const p of pending) {
        if (p.laneId !== n.parentId) continue;
        if (n.id === p.templateId) continue; // the template itself never moves
        if (n.id === p.drawer.id) continue; // the drawer is positioned absolutely, not shifted
        if (n.position.y > p.templateBottomY) shift += p.drawerH;
      }
      if (shift > 0) return { ...n, position: { ...n.position, y: n.position.y + shift } };
    }
    return n;
  });

  // Append in lane → drawer → cards order. The lanes are already in `out` (and were grown in
  // place, preserving their original index). Appending drawer-then-cards at the END
  // guarantees: drawer index > its lane's index, and each card's index > its drawer's index.
  for (const p of pending) {
    out.push(p.drawer);
    for (const c of p.cards) out.push(c);
  }

  // --- dev assertions (correctness invariants; stripped in production builds) -------------
  assertDev(out, pending);

  const edges: Edge[] = graph.edges; // waypoint-free; React Flow re-docks them for free.
  return { nodes: out, edges };
}

/**
 * Dev-only correctness assertions (run under `import.meta.env.DEV` / non-production):
 *   (1) every emitted card rect ⊆ its drawer rect (no clip/escape, since cards carry no
 *       extent:'parent').
 *   (2) every child node's array index > its parent node's array index (React Flow drops or
 *       mis-parents a child that precedes its parent).
 */
function assertDev(nodes: Node[], pending: { drawer: Node; cards: Node[] }[]): void {
  // Vite injects import.meta.env.DEV; in a plain node/vitest run it is undefined → treat as
  // dev (assertions on) unless explicitly production.
  const env = (import.meta as unknown as { env?: { PROD?: boolean } }).env;
  if (env?.PROD === true) return;

  // (1) card rect ⊆ drawer rect — cards are drawer-relative, so check 0 ≤ pos and
  //     pos + cardSize ≤ drawerSize.
  for (const { drawer, cards } of pending) {
    const ds = (drawer.style ?? {}) as { width?: number; height?: number };
    const dw = ds.width ?? 0;
    const dh = ds.height ?? 0;
    for (const c of cards) {
      const x = c.position.x;
      const y = c.position.y;
      const ok = x >= 0 && y >= 0 && x + CARD_W <= dw && y + CARD_H <= dh;
      if (!ok) {
        throw new Error(
          `expandInstances: card ${c.id} rect (${x},${y},${CARD_W}x${CARD_H}) escapes drawer ` +
            `${drawer.id} (${dw}x${dh})`,
        );
      }
    }
  }

  // (2) child index > parent index.
  const indexOf = new Map<string, number>();
  nodes.forEach((n, i) => indexOf.set(n.id, i));
  nodes.forEach((n, i) => {
    if (typeof n.parentId === 'string') {
      const pi = indexOf.get(n.parentId);
      if (pi != null && pi >= i) {
        throw new Error(
          `expandInstances: child ${n.id} (index ${i}) precedes its parent ${n.parentId} (index ${pi})`,
        );
      }
    }
  });
}
