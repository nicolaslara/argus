// @argus/web — expandLoopDrawer: the PURE, ELK-free in-loop drawer re-flow for the merged
// Run view's OPTION 2 (loop-drill-gallery.html "lane-drawer inside the loop"), gated behind
// `loopDrillMode === 'lane-drawer'`.
//
// This is the loop-container analogue of overlay-expand.ts's flat-fan lane-drawer. Where
// `expandInstances` draws a fan-out's instances as cards inside the host PHASE LANE,
// `expandLoopDrawer` draws ONE round's loop-body instances as cards inside the LOOP
// CONTAINER (a recursive drawer). It runs AFTER paintOverlay (+ after expandInstances), is a
// pure arithmetic re-flow (NO second ELK pass), returns a NEW graph, and NEVER mutates inputs.
//
// What it does, per open (loop node id → round):
//   1. resolves the round's agentIds (from overlay.loopRounds) → run.agents → instance cards
//      (the SAME agentToCardData / AgentCard renderer the flat fan uses).
//   2. opens a LEFT GUTTER inside the loop: shifts every existing loop child right by
//      LOOP_GUTTER so the dashed back-edge has a clear lane to route down (the design's
//      "runs down the left gutter, around the grown drawer").
//   3. emits an `instanceGroup` drawer (parented to the LOOP container) below the loop's
//      existing body content, left-aligned to the gutter, + grid `agentCard` children.
//   4. grows the loop container (height to fit the drawer; width if the drawer is wider) so
//      the back-edge + same-loop content (decision, revise, the round axis) shift to fit.
//   5. when the loop is a LANE MEMBER, grows the enclosing phase lane by the same delta and
//      shifts later same-lane siblings down so nothing collides.
//   6. RE-ROUTES the dashed loop-back (smoothstep) edge so it does NOT cross the cards: it
//      bows out through the left gutter (an explicit pathOptions.offset), docking at the loop
//      body's + the loop container's LEFT handles. Waypoint-free, so React Flow re-docks it.
//
// Cards are emitted WITHOUT `extent:'parent'` (like the flat fan) so a sizing error OVERFLOWS
// visibly rather than silently clipping a real agent. Parent-before-child order is preserved
// by APPENDING the drawer + cards at the end (every child index > its parent index).

import type { Edge, Node } from '@xyflow/react';
import type { AgentNode, LoopRoundBinding, Overlay, RunModel } from '@argus/contract';
import type { GraphResult } from './mapping.ts';
import { agentToCardData } from './mapping.ts';
import { drawerSize, buildChipCells, DRAWER_GAP, CHIP_W, CHIP_H } from './overlay-expand.ts';
import { CARD_SHELL_WIDTH, CARD_SHELL_HEIGHT_EXEC } from './nodes/AgentCardShell.tsx';

/**
 * The left gutter opened inside a loop when a round drawer is shown. Every existing loop child
 * shifts right by this much so the dashed back-edge has a clear vertical lane (and the drawer +
 * cards sit to the RIGHT of it) — the design's "down the left gutter, around the grown drawer".
 */
export const LOOP_GUTTER = 34;
/** The smoothstep bow the re-routed back-edge takes through the gutter (clears the cards). */
const BACKEDGE_OFFSET = 24;
/**
 * Extra bow given to the back-edge when the loop BODY ends in a DECISION diamond (POLISH 3). A
 * decision's only source handles are its RIGHT (`true`) and BOTTOM (`false`) vertices — neither
 * faces the left gutter — so a back-edge leaving it has to wrap the long way round and, with the
 * default offset, grazes the diamond / the cards. We dock the source at the decision's BOTTOM
 * handle (drops the edge below the diamond, clear of its body) and give it a wider bow so it
 * settles firmly in the gutter lane before climbing to the loop's left handle.
 */
const BACKEDGE_OFFSET_DECISION = LOOP_GUTTER + 12;
/** Inner padding kept between the drawer and the loop container's bottom edge. */
const LOOP_DRAWER_PAD_BOTTOM = 14;
/** Inner padding kept between the drawer and the loop container's right edge. */
const LOOP_DRAWER_PAD_RIGHT = 14;

const loopDrawerNodeId = (loopId: string, round: number): string => `loop-drawer-${loopId}-r${round}`;
const loopCardNodeId = (loopId: string, round: number, agentId: string, i: number): string =>
  `loop-inst-${loopId}-r${round}-${agentId || 'x'}-${i}`;

/** Read a node's explicit style width/height (group/loop nodes carry size in style). */
function styleSize(n: Node): { width: number; height: number } {
  const s = (n.style ?? {}) as { width?: number; height?: number };
  return { width: s.width ?? 0, height: s.height ?? 0 };
}

/** Reuse the flat-fan grid cell math so an in-loop drawer matches a phase-lane drawer exactly. */
function cardCellPosition(
  i: number,
  cols: number,
  padX: number,
  padTop: number,
  cardW: number,
  cardH: number,
  gapX: number,
  gapY: number,
): { x: number; y: number } {
  const col = i % cols;
  const row = Math.floor(i / cols);
  return { x: padX + col * (cardW + gapX), y: padTop + row * (cardH + gapY) };
}

// The same grid constants the flat-fan drawer uses (kept local so the cell math is explicit;
// drawerSize() owns the OUTER box, these own the per-cell placement WITHIN it).
const CARD_W = CARD_SHELL_WIDTH;
const CARD_H = CARD_SHELL_HEIGHT_EXEC;
const CELL_GAP_X = 16;
const CELL_GAP_Y = 16;
const DRAWER_PAD_X = 18;
const DRAWER_PAD_TOP = 40;

/**
 * Expand the given loops' selected rounds into in-loop instance drawers (OPTION 2).
 *
 * @param graph   the painted plan graph (after paintOverlay / expandInstances) — NOT mutated.
 * @param overlay the (plan, run) overlay — the per-round split lives in overlay.loopRounds.
 * @param run     the run whose agents the round's ids resolve against (for the instance cards).
 * @param openLoopDrawers loopNodeId → the open ROUND (1-based). Empty = a no-op (return by ref).
 * @param failureAgentIds the dead agentIds on a failed run (the matching card reads as failed).
 * @returns a NEW GraphResult with the loop drawer(s) + cards inserted, the loop(s) grown, the
 *          enclosing lane(s) grown, later siblings shifted, and the loop-back edge re-routed.
 */
export function expandLoopDrawer(
  graph: GraphResult,
  overlay: Overlay,
  run: RunModel,
  openLoopDrawers: Map<string, number>,
  failureAgentIds?: Set<string>,
): GraphResult {
  if (openLoopDrawers.size === 0) return graph;
  if (!overlay.loopRounds) return graph;

  const agentById = new Map<string, AgentNode>();
  for (const a of run.agents) agentById.set(a.agentId, a);

  const byId = new Map<string, Node>();
  for (const n of graph.nodes) byId.set(n.id, n);

  // Group existing loop CHILD ids by their loop container, so we can open the gutter (shift
  // every child right) + find where to drop the drawer (below the bottom-most child).
  const childrenOfLoop = new Map<string, Node[]>();
  for (const n of graph.nodes) {
    if (typeof n.parentId !== 'string') continue;
    const parent = byId.get(n.parentId);
    if (parent?.type === 'planLoop') {
      if (!childrenOfLoop.has(n.parentId)) childrenOfLoop.set(n.parentId, []);
      childrenOfLoop.get(n.parentId)!.push(n);
    }
  }

  interface PendingLoopDrawer {
    loopId: string;
    round: number;
    laneId: string | null;
    drawer: Node;
    cards: Node[];
    /** The vertical growth applied to the loop container (drawer height + gap). */
    grow: number;
    /** The new loop container width (may widen for a wide drawer). */
    newLoopW: number;
    /** The new loop container height. */
    newLoopH: number;
  }
  const pending: PendingLoopDrawer[] = [];

  for (const [loopId, round] of openLoopDrawers) {
    const loop = byId.get(loopId);
    if (!loop || loop.type !== 'planLoop') continue;
    const roundBindings: LoopRoundBinding[] | undefined = overlay.loopRounds[loopId];
    if (!roundBindings) continue;
    const rb = roundBindings.find((r) => r.round === round);
    if (!rb || rb.agentIds.length === 0) continue;

    const agents: AgentNode[] = [];
    for (const id of rb.agentIds) {
      const a = agentById.get(id);
      if (a) agents.push(a);
    }
    if (agents.length === 0) continue;

    const n = agents.length;
    const size = drawerSize(n);

    // The loop's current geometry + its existing children (gutter-shifted below).
    const { width: loopW, height: loopH } = styleSize(loop);
    const kids = childrenOfLoop.get(loopId) ?? [];
    // Drop the drawer BELOW the bottom-most existing loop child (loop-relative). The gutter
    // shift (applied below) moves the children right but not down, so the bottom edge is
    // unchanged by the gutter; we read it pre-shift.
    let contentBottom = 0;
    for (const k of kids) {
      const kb = (k.style ?? {}) as { height?: number };
      const kh = kb.height ?? CARD_H;
      contentBottom = Math.max(contentBottom, k.position.y + kh);
    }
    // If the loop has no measurable children (defensive), drop below the header band.
    if (contentBottom === 0) contentBottom = 44;

    const drawerX = LOOP_GUTTER + DRAWER_PAD_X / 2; // sit just right of the gutter
    const drawerY = contentBottom + DRAWER_GAP;

    const drawer: Node = {
      id: loopDrawerNodeId(loopId, round),
      type: 'instanceGroup',
      parentId: loopId,
      // NO extent:'parent' — a sizing error must overflow visibly, not clip the drawer.
      position: { x: drawerX, y: drawerY },
      data: {
        ...(loop.data ?? {}),
        // The drawer header reads as the round it expands (reuses InstanceGroup's title + count).
        templateId: loopId,
        instanceCount: n,
        title: `round r${round}`,
        // OPTION 2 marker: tell InstanceGroup this is a LOOP drawer (not a flat fan) so its header
        // caret collapses via `selectRound(loopId, round)` — re-selecting the open round toggles
        // `loopDrawerRound` off, exactly as re-clicking the round pill does. `loopId`/`round` are
        // the (loop node id, open round) the caret re-selects. A flat-fan drawer omits these, so
        // its caret keeps the original `toggle(templateId)` path (unchanged).
        loopDrawer: true,
        loopId,
        round,
        // Carry no aggregate binding chip for the loop drawer header (the round axis already
        // shows per-round counts); InstanceGroup degrades gracefully when these are absent.
      },
      draggable: false,
      selectable: false,
      style: { width: size.width, height: size.height },
    };

    // For a round with > CHIP_DEGRADE_THRESHOLD instances `drawerSize` degrades to a bounded
    // chip grid; reuse the flat fan's chip path (compact `agentChip` cells + a trailing `+N more`
    // tile) so a large round stays bounded instead of overflowing the chip-sized drawer with
    // full cards. The loop+round-unique `${loopId}-r${round}` namespaces the chip/tile node ids
    // so they never collide with a flat fan's `chip-…` ids. Small (≤ threshold) rounds still
    // render full `agentCard` cells exactly as before.
    const cards: Node[] = size.degraded
      ? buildChipCells(`${loopId}-r${round}`, drawer.id, agents, size, failureAgentIds)
      : agents.map((agent, i) => {
          const pos = cardCellPosition(i, size.cols, DRAWER_PAD_X, DRAWER_PAD_TOP, CARD_W, CARD_H, CELL_GAP_X, CELL_GAP_Y);
          return {
            id: loopCardNodeId(loopId, round, agent.agentId, i),
            type: 'agentCard',
            parentId: drawer.id,
            position: pos,
            data: agentToCardData(agent, failureAgentIds?.has(agent.agentId) === true),
            draggable: false,
            selectable: false,
          } as Node;
        });

    // Grow the loop container to fit the drawer (height always; width only if the gutter +
    // drawer would overflow the current loop width).
    const neededH = drawerY + size.height + LOOP_DRAWER_PAD_BOTTOM;
    const neededW = drawerX + size.width + LOOP_DRAWER_PAD_RIGHT;
    const newLoopH = Math.max(loopH, neededH);
    const newLoopW = Math.max(loopW, neededW);
    const grow = newLoopH - loopH;

    const laneId = typeof loop.parentId === 'string' ? loop.parentId : null;
    pending.push({ loopId, round, laneId, drawer, cards, grow, newLoopW, newLoopH });
  }

  if (pending.length === 0) return graph;

  // Per-lane growth (a lane may host >1 loop, though rare) + per-loop new size, indexed for
  // the rewrite pass. The lane grows by the loop's height delta so the grown loop never
  // overflows it; later same-lane siblings shift down by the loop's bottom-edge growth.
  const loopGrow = new Map<string, PendingLoopDrawer>();
  for (const p of pending) loopGrow.set(p.loopId, p);
  const laneGrowth = new Map<string, number>();
  for (const p of pending) {
    if (p.laneId) laneGrowth.set(p.laneId, (laneGrowth.get(p.laneId) ?? 0) + p.grow);
  }
  // Per lane, the loop's PRE-GROWTH bottom Y (lane-relative) — the threshold above which a
  // sibling is "below the loop" and must shift down.
  const loopBottomByLane = new Map<string, number>();
  for (const p of pending) {
    if (!p.laneId) continue;
    const loop = byId.get(p.loopId)!;
    const { height } = styleSize(loop);
    const bottom = loop.position.y + height; // lane-relative bottom of the loop pre-growth
    loopBottomByLane.set(p.laneId, Math.max(loopBottomByLane.get(p.laneId) ?? 0, bottom));
  }

  const out: Node[] = graph.nodes.map((n) => {
    // (a) the grown loop container — bump its style size.
    const lg = loopGrow.get(n.id);
    if (lg && n.type === 'planLoop') {
      return { ...n, style: { ...(n.style ?? {}), width: lg.newLoopW, height: lg.newLoopH } };
    }
    // (b) a loop CHILD of an expanded loop — open the gutter (shift right by LOOP_GUTTER).
    if (typeof n.parentId === 'string' && loopGrow.has(n.parentId)) {
      return { ...n, position: { x: n.position.x + LOOP_GUTTER, y: n.position.y } };
    }
    // (c) the enclosing phase lane — grow it so the taller loop still fits.
    const grow = laneGrowth.get(n.id);
    if (grow != null && n.type === 'phaseLane') {
      const { width, height } = styleSize(n);
      return { ...n, style: { ...(n.style ?? {}), width, height: height + grow } };
    }
    // (d) a same-lane sibling BELOW an expanded loop — shift down by the loop's growth. (The
    // loop itself + its children are already handled by (a)/(b) above and never reach here, so
    // this only ever moves OTHER lane members that sit below the grown loop.)
    if (typeof n.parentId === 'string') {
      const threshold = loopBottomByLane.get(n.parentId);
      const laneGrow = laneGrowth.get(n.parentId);
      if (threshold != null && laneGrow != null && n.position.y >= threshold) {
        return { ...n, position: { ...n.position, y: n.position.y + laneGrow } };
      }
    }
    return n;
  });

  // Append drawer → cards (parent-before-child: the loop is already in `out` and grew in
  // place, keeping its original index; appending drawer-then-cards guarantees the order).
  for (const p of pending) {
    out.push(p.drawer);
    for (const c of p.cards) out.push(c);
  }

  // --- re-route the dashed loop-back edge(s) around the grown drawer ----------------------
  // The loop-back edge targets the expanded LOOP container; bow it out through the left gutter
  // (an explicit smoothstep offset) and dock both ends at their LEFT handles, so it runs down
  // the gutter and never crosses the freshly-grown drawer's cards. Waypoint-free still (no
  // baked points), so React Flow re-docks it to the moved handles for free.
  //
  // POLISH 3 — the common loop shape ends in a DECISION diamond. A decision exposes source
  // handles only on its RIGHT (`true`) and BOTTOM (`false`) vertices; with no handle override the
  // back-edge leaves the RIGHT vertex and has to wrap the full width of the diamond to reach the
  // left gutter, grazing the diamond and the cards on the way. When the source is a decision we
  // instead dock the source at its BOTTOM (`false`) handle — the edge drops clear below the
  // diamond, then a wider bow pulls it firmly into the gutter lane before it climbs to the loop's
  // left handle. (`false` is just the nearest downward handle; this is a routing choice, not a
  // branch — the real true/false branch edges carry their own explicit sourceHandle and are not
  // touched here.)
  const edges: Edge[] = graph.edges.map((e) => {
    const targetsExpandedLoop = typeof e.target === 'string' && loopGrow.has(e.target);
    if (!targetsExpandedLoop || e.type !== 'smoothstep') return e;
    const src = typeof e.source === 'string' ? byId.get(e.source) : undefined;
    const fromDecision = src?.type === 'planDecision';
    return {
      ...e,
      // Dock the back-edge's TARGET at the loop's LEFT handle (cleared so RF re-docks for free).
      targetHandle: null,
      // For a decision source, leave the diamond's BOTTOM vertex (the downward `false` handle) and
      // bow wider; otherwise keep the source handle + the standard gutter bow.
      ...(fromDecision ? { sourceHandle: 'false' } : null),
      pathOptions: {
        offset: fromDecision ? BACKEDGE_OFFSET_DECISION : BACKEDGE_OFFSET,
        borderRadius: 14,
      },
    } as Edge;
  });
  // Residual limitation: the route is still a waypoint-free smoothstep, so React Flow owns the
  // exact curve — we steer it (handle + offset), we don't pin it. For the common case (loop ends
  // in a decision or a single body, gutter clear of the cards) this keeps the back-edge in the
  // left lane. A pathological loop body — e.g. one wider than gutter+drawer, so a child still sits
  // ABOVE the gutter lane — could let the curve graze that child; the honest fix there is baked
  // waypoints (rejected: it breaks free re-docking) or a per-topology gutter width.

  assertDev(out, pending);
  return { nodes: out, edges };
}

/**
 * Dev-only correctness assertions (run under non-production):
 *   (1) every emitted card rect ⊆ its drawer rect (no clip/escape; cards carry no extent).
 *   (2) every emitted drawer rect ⊆ its (grown) loop container rect.
 *   (3) every child node's array index > its parent node's array index.
 */
function assertDev(nodes: Node[], pending: { drawer: Node; cards: Node[]; loopId: string; newLoopW: number; newLoopH: number }[]): void {
  const env = (import.meta as unknown as { env?: { PROD?: boolean } }).env;
  if (env?.PROD === true) return;

  for (const { drawer, cards, newLoopW, newLoopH } of pending) {
    const ds = (drawer.style ?? {}) as { width?: number; height?: number };
    const dw = ds.width ?? 0;
    const dh = ds.height ?? 0;
    // (1) cards ⊆ drawer. Chip cells use the compact CHIP_* footprint; full-card cells use the
    // CARD_* footprint (a degraded drawer is sized to chips, not cards — parity with expandInstances).
    for (const c of cards) {
      const isChip = c.type === 'agentChip';
      const cw = isChip ? CHIP_W : CARD_W;
      const ch = isChip ? CHIP_H : CARD_H;
      const x = c.position.x;
      const y = c.position.y;
      const ok = x >= 0 && y >= 0 && x + cw <= dw && y + ch <= dh;
      if (!ok) {
        throw new Error(
          `expandLoopDrawer: card ${c.id} rect (${x},${y},${cw}x${ch}) escapes drawer ${drawer.id} (${dw}x${dh})`,
        );
      }
    }
    // (2) drawer ⊆ loop container.
    const drawerRight = drawer.position.x + dw;
    const drawerBottom = drawer.position.y + dh;
    if (drawer.position.x < 0 || drawer.position.y < 0 || drawerRight > newLoopW || drawerBottom > newLoopH) {
      throw new Error(
        `expandLoopDrawer: drawer ${drawer.id} rect (${drawer.position.x},${drawer.position.y},${dw}x${dh}) escapes loop (${newLoopW}x${newLoopH})`,
      );
    }
  }

  // (3) child index > parent index.
  const indexOf = new Map<string, number>();
  nodes.forEach((n, i) => indexOf.set(n.id, i));
  nodes.forEach((n, i) => {
    if (typeof n.parentId === 'string') {
      const pi = indexOf.get(n.parentId);
      if (pi != null && pi >= i) {
        throw new Error(
          `expandLoopDrawer: child ${n.id} (index ${i}) precedes its parent ${n.parentId} (index ${pi})`,
        );
      }
    }
  });
}
