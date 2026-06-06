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
//   - It re-flows in BOTH axes (the vertical grow+shift and its horizontal twin):
//       Y: the host lane grows in HEIGHT by its drawers' heights, and same-lane siblings
//          BELOW a template shift DOWN by the drawer height (only same-lane siblings can
//          overlap a grown drawer vertically).
//       X: a drawer can be WIDER than its host lane (a ×N fan grids into a multi-column
//          drawer ~812px wide, far wider than a ~300px lane). Left unhandled it would
//          overflow RIGHT into the neighbour lane. So the host lane also grows in WIDTH to
//          contain its widest drawer, and every lane/top-level node to its RIGHT shifts
//          right by that width delta — the horizontal analogue of the vertical grow+shift.
//          (Children ride their parent lane via extent:'parent', so they need no X-shift.)
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
import type { LiveFill } from './live-agent-fill.ts';
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

// --- density degrade (Ship #6): above the threshold, full cards collapse to chips --------
/**
 * Above this instance count an expanded fan degrades from full `agentCard` cells to compact
 * `agentChip` cells, so the drawer height stays bounded instead of growing to ~ceil(N/5) card
 * rows (a 50-instance fan would otherwise be a wall of cards taller than the viewport). At or
 * below the threshold the fan renders full cards exactly as before.
 */
export const CHIP_DEGRADE_THRESHOLD = 18;
/**
 * Compact chip cell footprint — far smaller than a card (a label + a state dot + a duration).
 * EXPORTED so the React `AgentChip` node's CSS sizes to the SAME box the layout reserves for it
 * (one source of truth — the node must fill, never overflow, the cell expandInstances positions).
 */
export const CHIP_W = 150;
export const CHIP_H = 30;
const CHIP_GAP_X = 10;
const CHIP_GAP_Y = 8;
/** Dense column count for a chip grid: clamp(ceil(sqrt(N)), 4, 8) — wider/denser than cards. */
export function chipCols(n: number): number {
  return Math.min(8, Math.max(4, Math.ceil(Math.sqrt(Math.max(n, 1)))));
}
/**
 * Max chip CELLS rendered in a degraded drawer. The last cell is always a `+N more` overflow
 * tile when there is overflow, so at most `CHIP_RENDER_CAP - 1` real instance chips show and
 * one tile accounts for the rest (an honest overflow marker; "show all" is later work).
 */
const CHIP_RENDER_CAP = 24; // → up to 23 instance chips + 1 "+N more" tile

/** Column count for N instances: clamp(ceil(sqrt(N)), 2, 5) — a roughly-square, bounded grid. */
export function drawerCols(n: number): number {
  return Math.min(5, Math.max(2, Math.ceil(Math.sqrt(Math.max(n, 1)))));
}

export interface DrawerSize {
  width: number;
  height: number;
  cols: number;
  rows: number;
  /** Whether this drawer renders compact chips (true) or full cards (false). */
  degraded: boolean;
  /** Number of grid CELLS actually rendered (chips + an optional overflow tile, or all cards). */
  cells: number;
}

/**
 * The explicit drawer `style:{width,height}` for N instances:
 *   width  = cols × cardW (+ gaps + side padding)
 *   height = header + ceil(N/cols) card rows + ONE ghost row (+ gaps + bottom padding)
 * The ghost row is the "upcoming slot" gutter — it keeps the drawer from hugging the last
 * real card and reserves room for the dashed upcoming-instance placeholder.
 *
 * When `n > CHIP_DEGRADE_THRESHOLD` the drawer degrades to a DENSE chip grid: the rendered
 * cell count is capped at CHIP_RENDER_CAP (the last cell a `+N more` tile), so the height is
 * BOUNDED by ceil(CHIP_RENDER_CAP/cols) chip rows regardless of how large N gets.
 */
export function drawerSize(n: number): DrawerSize {
  const count = Math.max(n, 1);
  if (count > CHIP_DEGRADE_THRESHOLD) {
    const cols = chipCols(count);
    // Render at most CHIP_RENDER_CAP cells; the last is a `+N more` tile if there is overflow.
    const overflow = count > CHIP_RENDER_CAP;
    const cells = overflow ? CHIP_RENDER_CAP : count;
    const cellRows = Math.ceil(cells / cols);
    const rows = cellRows + 1; // + one ghost row (parity with the card grid gutter)
    const width = DRAWER_PAD_X * 2 + cols * CHIP_W + (cols - 1) * CHIP_GAP_X;
    const height =
      DRAWER_PAD_TOP + rows * CHIP_H + (rows - 1) * CHIP_GAP_Y + DRAWER_PAD_BOTTOM;
    return { width, height, cols, rows, degraded: true, cells };
  }
  const cols = drawerCols(count);
  const cardRows = Math.ceil(count / cols);
  const rows = cardRows + 1; // + one ghost row
  const width = DRAWER_PAD_X * 2 + cols * CARD_W + (cols - 1) * CELL_GAP_X;
  const height =
    DRAWER_PAD_TOP + rows * CARD_H + (rows - 1) * CELL_GAP_Y + DRAWER_PAD_BOTTOM;
  return { width, height, cols, rows, degraded: false, cells: count };
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

/** The drawer-relative grid position of the i-th CHIP cell in a degraded drawer. */
function chipCellPosition(i: number, cols: number): { x: number; y: number } {
  const col = i % cols;
  const row = Math.floor(i / cols);
  return {
    x: DRAWER_PAD_X + col * (CHIP_W + CHIP_GAP_X),
    y: DRAWER_PAD_TOP + row * (CHIP_H + CHIP_GAP_Y),
  };
}

const drawerNodeId = (templateId: string): string => `instances-${templateId}`;
const cardNodeId = (templateId: string, agentId: string, i: number): string =>
  `inst-${templateId}-${agentId || 'x'}-${i}`;
const chipNodeId = (templateId: string, agentId: string, i: number): string =>
  `chip-${templateId}-${agentId || 'x'}-${i}`;
const moreTileId = (templateId: string): string => `chip-${templateId}-more`;

/** Read a node's explicit style width/height (group nodes carry size in style). */
function styleSize(n: Node): { width: number; height: number } {
  const s = (n.style ?? {}) as { width?: number; height?: number };
  return { width: s.width ?? 0, height: s.height ?? 0 };
}

/**
 * The compact-chip node data for a degraded drawer cell. A real instance chip carries the
 * minimal at-a-glance fields (`label`, `state`, `durationMs`, `agentId`, optional
 * `failurePoint`); the trailing overflow tile carries `more` (the remaining hidden count).
 */
export interface AgentChipData {
  label?: string;
  state?: AgentNode['state'];
  durationMs?: number | null;
  agentId?: string;
  failurePoint?: boolean;
  /** Set ONLY on the trailing overflow tile: the count of instances NOT rendered as chips. */
  more?: number;
  [key: string]: unknown;
}

/**
 * Build the degraded drawer's children: up to `size.cells` cells in a dense chip grid. When
 * the fan overflows the cap, the LAST cell is a `+N more` overflow tile (`data.more` = the
 * hidden remainder) and only the first `size.cells - 1` agents render as instance chips.
 *
 * EXPORTED so the loop-container drawer (overlay-loop-expand.ts, OPTION 2) reuses the SAME
 * chip path a flat fan uses for a large round (`templateId` namespaces the chip/tile node ids,
 * so a loop drawer passes a loop+round-unique id to avoid colliding with flat-fan chip ids).
 */
export function buildChipCells(
  templateId: string,
  drawerId: string,
  agents: AgentNode[],
  size: DrawerSize,
  failureAgentIds: Set<string> | undefined,
): Node[] {
  const n = agents.length;
  const overflow = n > size.cells; // a tile is needed iff more agents than rendered cells
  const chipCount = overflow ? size.cells - 1 : Math.min(n, size.cells);
  const cells: Node[] = [];
  for (let i = 0; i < chipCount; i++) {
    const agent = agents[i];
    if (!agent) continue; // i < chipCount ≤ n, so this never fires — guards noUncheckedIndexedAccess
    const pos = chipCellPosition(i, size.cols);
    const data: AgentChipData = {
      label: agent.label || agent.agentId || 'agent',
      state: agent.state,
      durationMs: agent.durationMs,
      agentId: agent.agentId,
      failurePoint: failureAgentIds?.has(agent.agentId) === true,
    };
    cells.push({
      id: chipNodeId(templateId, agent.agentId, i),
      type: 'agentChip',
      parentId: drawerId,
      position: pos,
      data,
      draggable: false,
      selectable: false,
    } as Node);
  }
  if (overflow) {
    const pos = chipCellPosition(chipCount, size.cols);
    const data: AgentChipData = { more: n - chipCount };
    cells.push({
      id: moreTileId(templateId),
      type: 'agentChip',
      parentId: drawerId,
      position: pos,
      data,
      draggable: false,
      selectable: false,
    } as Node);
  }
  return cells;
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
 * @param failureAgentIds STEP 3 — the dead agentIds on a failed run (red failure-point ring).
 * @param liveFill STEP 2 — agentId→LiveFill for a LIVE run's transcript-derived metrics; merged
 *                into each instance card so a running agent shows real dur/tok/tools/label
 *                instead of em-dashes. OPTIONAL + empty for finished runs (cards stay byte-
 *                unchanged). Affects card data only, never the layout arithmetic.
 * @returns a NEW GraphResult with drawer + card nodes inserted and the host lanes re-flowed.
 */
export function expandInstances(
  graph: GraphResult,
  overlay: Overlay,
  run: RunModel,
  expandedNodeIds: Set<string>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- threaded for parity with paintOverlay; arithmetic is live-independent
  live = false,
  // STEP 3: the dead agentIds on a failed run — the matching instance card reads as the
  // failure point (a red ring), consistent with the Run-view failure banner's attribution.
  failureAgentIds?: Set<string>,
  // STEP 2: the live transcript fill (agentId→LiveFill) for a LIVE run; empty/undefined for a
  // finished run. Read only in the full-card path (a degraded chip drawer shows label/state/
  // dur, and a live fan over CHIP_DEGRADE_THRESHOLD is rare — chips stay on journal data).
  liveFill?: Map<string, LiveFill>,
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

    // The grid children, drawer-relative, WITHOUT extent:'parent'. Small fans render full
    // `agentCard` cells; large (degraded) fans render compact `agentChip` cells capped at
    // CHIP_RENDER_CAP with a trailing `+N more` overflow tile.
    const cards: Node[] = size.degraded
      ? buildChipCells(templateId, drawer.id, agents, size, failureAgentIds)
      : agents.map((agent, i) => {
          const pos = cardCellPosition(i, size.cols);
          return {
            id: cardNodeId(templateId, agent.agentId, i),
            type: 'agentCard',
            parentId: drawer.id,
            position: pos,
            data: agentToCardData(
              agent,
              failureAgentIds?.has(agent.agentId) === true,
              liveFill?.get(agent.agentId),
            ),
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

  // --- UIBUG-1 horizontal re-flow: a drawer WIDER than its host lane grows the lane WIDTH
  //     and pushes every lane/top-level node to its right, so the drawer never overlaps the
  //     neighbour lane (the vertical grow+shift's horizontal twin). ---
  const RIGHT_PAD = DRAWER_PAD_X; // breathing room past the drawer's right edge inside the lane
  const laneWidthGrowth = new Map<string, number>(); // laneId -> dx (>=0)
  for (const p of pending) {
    const lane = byId.get(p.laneId);
    if (!lane) continue;
    const laneW = styleSize(lane).width;
    const drawerW = (p.drawer.style as { width?: number }).width ?? 0;
    const need = p.drawer.position.x + drawerW + RIGHT_PAD - laneW;
    if (need > 0) laneWidthGrowth.set(p.laneId, Math.max(laneWidthGrowth.get(p.laneId) ?? 0, need));
  }
  // Absolute X of each growing lane → cumulative right-shift for anything to its right.
  const grownLanes: { x: number; dx: number }[] = [];
  for (const [laneId, dx] of laneWidthGrowth) {
    const lane = byId.get(laneId);
    if (lane) grownLanes.push({ x: lane.position.x, dx });
  }
  const rightShiftFor = (x: number): number => {
    let s = 0;
    for (const g of grownLanes) if (g.x < x) s += g.dx;
    return s;
  };

  const out: Node[] = graph.nodes.map((n) => {
    // A phaseLane grows in BOTH dimensions (height by its drawers' drawerH, width to contain
    // its widest drawer) and shifts RIGHT by the growth of every lane to its left.
    if (n.type === 'phaseLane') {
      const wGrow = laneWidthGrowth.get(n.id) ?? 0;
      const hGrow = laneGrowth.get(n.id) ?? 0; // existing height growth
      const dx = rightShiftFor(n.position.x); // growth of lanes to MY left pushes me right
      // An untouched lane keeps its object identity (the documented invariant the loop-layout
      // inertness test relies on) — only clone when this lane actually grows or shifts.
      if (wGrow === 0 && hGrow === 0 && dx === 0) return n;
      const { width, height } = styleSize(n);
      let next: Node = {
        ...n,
        style: { ...(n.style ?? {}), width: width + wGrow, height: height + hGrow },
      };
      if (dx > 0) next = { ...next, position: { ...n.position, x: n.position.x + dx } };
      return next;
    }
    // A TOP-LEVEL non-lane node rides nothing — shift it right by the growth of lanes to its left.
    if (n.parentId == null) {
      const dx = rightShiftFor(n.position.x);
      if (dx > 0) return { ...n, position: { ...n.position, x: n.position.x + dx } };
      return n;
    }
    // Shift same-lane siblings BELOW a template down by that template's drawerH. A node is a
    // sibling iff it is parented to the same lane; the threshold is the template's bottom Y.
    // Children ride their parent lane via extent:'parent', so they need NO X-shift here.
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
  assertDrawerFitsLane(out, pending);

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

  // (1) child rect ⊆ drawer rect — cells are drawer-relative, so check 0 ≤ pos and
  //     pos + cellSize ≤ drawerSize. Chip cells use the compact CHIP_* footprint; full-card
  //     cells use the CARD_* footprint (a degraded drawer is sized to chips, not cards).
  for (const { drawer, cards } of pending) {
    const ds = (drawer.style ?? {}) as { width?: number; height?: number };
    const dw = ds.width ?? 0;
    const dh = ds.height ?? 0;
    for (const c of cards) {
      const isChip = c.type === 'agentChip';
      const cw = isChip ? CHIP_W : CARD_W;
      const ch = isChip ? CHIP_H : CARD_H;
      const x = c.position.x;
      const y = c.position.y;
      const ok = x >= 0 && y >= 0 && x + cw <= dw && y + ch <= dh;
      if (!ok) {
        throw new Error(
          `expandInstances: cell ${c.id} rect (${x},${y},${cw}x${ch}) escapes drawer ` +
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

/**
 * Dev-only UIBUG-1 invariant: every drawer's right edge ⊆ its host lane's GROWN width, i.e. the
 * horizontal re-flow grew the host lane wide enough that the drawer never overlaps the neighbour
 * lane. Reads the GROWN lane widths off the `out` nodes (post grow+shift), so it validates the
 * actual emitted geometry, not the pre-growth inputs.
 */
function assertDrawerFitsLane(
  out: Node[],
  pending: { drawer: Node; laneId: string }[],
): void {
  const env = (import.meta as unknown as { env?: { PROD?: boolean } }).env;
  if (env?.PROD === true) return;
  const byId = new Map<string, Node>();
  for (const n of out) byId.set(n.id, n);
  for (const { drawer, laneId } of pending) {
    const lane = byId.get(laneId);
    if (!lane) continue;
    const laneW = styleSize(lane).width;
    const drawerW = (drawer.style as { width?: number }).width ?? 0;
    const drawerRight = drawer.position.x + drawerW;
    if (drawerRight > laneW) {
      throw new Error(
        `expandInstances: drawer ${drawer.id} right edge ${drawerRight} overflows host lane ` +
          `${laneId} grown width ${laneW}`,
      );
    }
  }
}
