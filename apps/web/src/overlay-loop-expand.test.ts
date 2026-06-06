import { describe, it, expect } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { AgentNode, Overlay, RunModel } from '@argus/contract';
import type { GraphResult } from './mapping.ts';
import { CARD_SHELL_WIDTH, CARD_SHELL_HEIGHT_EXEC } from './nodes/AgentCardShell.tsx';
import { drawerSize, DRAWER_GAP } from './overlay-expand.ts';
import { expandLoopDrawer, LOOP_GUTTER } from './overlay-loop-expand.ts';

// OPTION 2 — "lane-drawer inside the loop" (loop-drill-gallery.html opt2). expandLoopDrawer draws
// ONE round's loop-body instances as agentCard cells INSIDE the loop container (a recursive
// drawer), grows the loop container to fit, opens a left gutter, shifts the enclosing lane +
// later siblings, and re-routes the dashed loop-back edge around the cards. These are pure
// layout/structure tests over a SYNTHETIC loop graph shaped exactly as planModelToGraph emits one:
//   lane-2 [ loop container (planLoop) > a loop body (planAgent, parented to the loop), a decision
//            below it (also a loop child), with a waypoint-free smoothstep loop-back edge ]

const LANE_2 = 'lane-2';
const LOOP_ID = 'loop-1';
const LOOP_BODY = 'agent:critique:r:1';
const LOOP_DECISION = 'decision:material:1';

const LOOP_X = 30;
const LOOP_Y = 40;
const LOOP_W = 420;
const LOOP_H = 260;
const BODY_X = 24;
const BODY_Y = 50;
const BODY_W = CARD_SHELL_WIDTH;
const BODY_H = CARD_SHELL_HEIGHT_EXEC;
const DECISION_Y = BODY_Y + BODY_H + 24;
const DECISION_SIZE = 116;

// The round 2 instances drawn inside the loop (×4 critics — a small full-card fan).
const R2_IDS = ['c2a', 'c2b', 'c2c', 'c2d'];
const R1_IDS = ['c1a', 'c1b'];

function agentNode(over: Partial<AgentNode> & { agentId: string; label: string }): AgentNode {
  return {
    index: 0,
    phaseIndex: 2,
    model: 'opus',
    state: 'done',
    cached: false,
    agentType: null,
    attempt: null,
    failedInLogs: false,
    tokens: 100,
    toolCalls: 1,
    durationMs: 1000,
    queuedAt: null,
    startedAt: null,
    lastProgressAt: null,
    lastToolName: null,
    lastToolSummary: null,
    promptPreview: null,
    resultPreview: null,
    ...over,
  };
}

function makeGraph(): GraphResult {
  const nodes: Node[] = [
    {
      id: LANE_2,
      type: 'phaseLane',
      position: { x: 800, y: 0 },
      data: { index: 2, title: 'Critique', agentCount: 0 },
      style: { width: 520, height: 380 },
    },
    {
      id: LOOP_ID,
      type: 'planLoop',
      parentId: LANE_2,
      extent: 'parent',
      position: { x: LOOP_X, y: LOOP_Y },
      data: { title: 'loop', stopCondition: 'until done', maxRounds: 3, painted: true, observedRounds: 2, unrolled: true },
      style: { width: LOOP_W, height: LOOP_H },
    },
    {
      id: LOOP_BODY,
      type: 'planAgent',
      parentId: LOOP_ID,
      extent: 'parent',
      position: { x: BODY_X, y: BODY_Y },
      data: { bindStatus: 'complete', bindAgentIds: [...R1_IDS, ...R2_IDS], painted: true },
      style: { width: BODY_W, height: BODY_H },
    },
    {
      // A decision node below the body — also a loop child, so it must ride the gutter shift.
      id: LOOP_DECISION,
      type: 'planDecision',
      parentId: LOOP_ID,
      extent: 'parent',
      position: { x: BODY_X, y: DECISION_Y },
      data: { conditionLabel: 'material.length === 0', conditionKind: 'schema-field' },
      style: { width: DECISION_SIZE, height: DECISION_SIZE },
    },
  ];
  const edges: Edge[] = [
    // The dashed loop-back edge: smoothstep, WAYPOINT-FREE, body/decision → loop container.
    { id: 'e-loopback', source: LOOP_DECISION, target: LOOP_ID, type: 'smoothstep', style: { strokeDasharray: '6 4' } },
    { id: 'spine', source: 'lane-1', target: LANE_2, type: 'smoothstep' },
  ];
  return { nodes, edges };
}

function makeOverlay(): Overlay {
  return {
    bindings: [
      {
        planNodeId: LOOP_BODY,
        agentIds: [...R1_IDS, ...R2_IDS],
        status: 'complete',
        succeeded: 6,
        failed: 0,
        total: 6,
        confidence: 'medium',
        ambiguous: false,
      },
    ],
    unplannedAgentIds: [],
    rounds: 2,
    loopRounds: {
      [LOOP_ID]: [
        { round: 1, agentIds: R1_IDS, instances: R1_IDS.map((id) => ({ agentId: id, label: `critique:${id}:r1`, state: 'done' as const })) },
        { round: 2, agentIds: R2_IDS, instances: R2_IDS.map((id) => ({ agentId: id, label: `critique:${id}:r2`, state: 'done' as const })) },
      ],
    },
  };
}

function makeRun(): RunModel {
  return {
    ref: { projectPath: '', slug: 's', sessionId: 'x', runId: 'wf_x' },
    workflowName: 'x',
    status: 'completed',
    incomplete: false,
    startTime: null,
    durationMs: null,
    defaultModel: null,
    summary: '',
    phases: [{ index: 2, title: 'Critique', detail: null }],
    agents: [
      ...R1_IDS.map((id) => agentNode({ agentId: id, label: `critique:${id}:r1` })),
      ...R2_IDS.map((id) => agentNode({ agentId: id, label: `critique:${id}:r2` })),
    ],
    edges: [],
    logs: [],
    partialFailure: { present: false, lines: [] },
    error: null,
    args: null,
    warnings: [],
    format: 'cc-workflow/observed-2026-06-04',
  };
}

function absRect(graph: GraphResult, id: string): { x: number; y: number; w: number; h: number } {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const n = byId.get(id);
  if (!n) throw new Error(`no node ${id}`);
  let x = n.position.x;
  let y = n.position.y;
  let p = typeof n.parentId === 'string' ? byId.get(n.parentId) : undefined;
  while (p) {
    x += p.position.x;
    y += p.position.y;
    p = typeof p.parentId === 'string' ? byId.get(p.parentId) : undefined;
  }
  const s = (n.style ?? {}) as { width?: number; height?: number };
  return { x, y, w: s.width ?? CARD_SHELL_WIDTH, h: s.height ?? CARD_SHELL_HEIGHT_EXEC };
}

function rectInside(child: ReturnType<typeof absRect>, parent: ReturnType<typeof absRect>): boolean {
  return (
    child.x >= parent.x &&
    child.y >= parent.y &&
    child.x + child.w <= parent.x + parent.w &&
    child.y + child.h <= parent.y + parent.h
  );
}

describe('expandLoopDrawer — OPTION 2 (lane-drawer inside the loop)', () => {
  it('no-op when no drawer is open (returns the graph by reference)', () => {
    const graph = makeGraph();
    const r = expandLoopDrawer(graph, makeOverlay(), makeRun(), new Map());
    expect(r).toBe(graph);
  });

  it('no-op when the overlay has no loopRounds', () => {
    const graph = makeGraph();
    const overlay = makeOverlay();
    delete (overlay as { loopRounds?: unknown }).loopRounds;
    const r = expandLoopDrawer(graph, overlay, makeRun(), new Map([[LOOP_ID, 2]]));
    expect(r).toBe(graph);
  });

  it('draws the selected round’s agents as agentCard cells inside the loop', () => {
    const graph = makeGraph();
    const r = expandLoopDrawer(graph, makeOverlay(), makeRun(), new Map([[LOOP_ID, 2]]));

    // One drawer (instanceGroup) parented to the LOOP container + one card per round-2 instance.
    const drawer = r.nodes.find((n) => n.type === 'instanceGroup');
    expect(drawer).toBeDefined();
    expect(drawer!.parentId).toBe(LOOP_ID);
    const cards = r.nodes.filter((n) => n.type === 'agentCard');
    expect(cards.length).toBe(R2_IDS.length);
    for (const c of cards) expect(c.parentId).toBe(drawer!.id);
    // The cards carry the round-2 labels (reuses agentToCardData → AgentCard renderer).
    const labels = cards.map((c) => (c.data as { label?: string }).label).sort();
    expect(labels).toEqual(R2_IDS.map((id) => `critique:${id}:r2`).sort());
  });

  it('grows the loop container + the enclosing lane to fit the drawer; cards stay inside', () => {
    const graph = makeGraph();
    const loopBefore = absRect(graph, LOOP_ID);
    const laneBefore = (graph.nodes.find((n) => n.id === LANE_2)!.style as { height: number }).height;

    const r = expandLoopDrawer(graph, makeOverlay(), makeRun(), new Map([[LOOP_ID, 2]]));

    const loopAfter = absRect(r, LOOP_ID);
    const laneAfter = (r.nodes.find((n) => n.id === LANE_2)!.style as { height: number }).height;
    const size = drawerSize(R2_IDS.length);
    // The loop grew taller (by at least the drawer + gap) and the lane grew by the same delta.
    expect(loopAfter.h).toBeGreaterThan(loopBefore.h);
    expect(loopAfter.h - loopBefore.h).toBeGreaterThanOrEqual(size.height + DRAWER_GAP - BODY_H);
    expect(laneAfter - laneBefore).toBe(loopAfter.h - loopBefore.h);

    // Every drawn card sits strictly inside its drawer, and the drawer inside the grown loop.
    const drawer = r.nodes.find((n) => n.type === 'instanceGroup')!;
    expect(rectInside(absRect(r, drawer.id), absRect(r, LOOP_ID))).toBe(true);
    for (const c of r.nodes.filter((n) => n.type === 'agentCard')) {
      expect(rectInside(absRect(r, c.id), absRect(r, drawer.id))).toBe(true);
      expect(rectInside(absRect(r, c.id), absRect(r, LOOP_ID))).toBe(true);
    }
  });

  it('opens a left gutter: every existing loop child shifts right by LOOP_GUTTER', () => {
    const graph = makeGraph();
    const r = expandLoopDrawer(graph, makeOverlay(), makeRun(), new Map([[LOOP_ID, 2]]));
    const body = r.nodes.find((n) => n.id === LOOP_BODY)!;
    const decision = r.nodes.find((n) => n.id === LOOP_DECISION)!;
    expect(body.position.x).toBe(BODY_X + LOOP_GUTTER);
    expect(decision.position.x).toBe(BODY_X + LOOP_GUTTER);
    // The drawer sits to the RIGHT of the gutter (clear of the back-edge lane on the left).
    const drawer = r.nodes.find((n) => n.type === 'instanceGroup')!;
    expect(drawer.position.x).toBeGreaterThanOrEqual(LOOP_GUTTER);
  });

  it('re-routes the dashed loop-back edge with a left-gutter bow (waypoint-free)', () => {
    const graph = makeGraph();
    const r = expandLoopDrawer(graph, makeOverlay(), makeRun(), new Map([[LOOP_ID, 2]]));
    const back = r.edges.find((e) => e.id === 'e-loopback')!;
    // Still a smoothstep edge targeting the loop, source/target endpoints unchanged.
    expect(back.type).toBe('smoothstep');
    expect(back.source).toBe(LOOP_DECISION);
    expect(back.target).toBe(LOOP_ID);
    // It now carries a pathOptions offset (the bow through the gutter) but NO baked waypoints
    // (so React Flow re-docks it to the moved handles for free).
    const bo = back as Edge & { pathOptions?: { offset?: number }; data?: { points?: unknown } };
    expect(bo.pathOptions?.offset).toBeGreaterThan(0);
    expect(bo.data?.points).toBeUndefined();
    // A NON-loop-back smoothstep edge (the inter-lane spine) is left untouched.
    const spine = r.edges.find((e) => e.id === 'spine')!;
    expect((spine as Edge & { pathOptions?: unknown }).pathOptions).toBeUndefined();
    // …and it docks at the loop's LEFT handle (targetHandle cleared so RF re-docks for free).
    expect(back.targetHandle).toBeNull();
  });

  it('the re-routed back-edge bows through a left gutter that is CLEAR of every card', () => {
    // The back-edge bows out through the left gutter (x ∈ [0, LOOP_GUTTER]); the drawer + its cards
    // sit to the RIGHT of the gutter, so the routed edge never crosses a card. We pin the geometry
    // that guarantees it: every emitted card's left edge (loop-relative) is ≥ LOOP_GUTTER.
    const graph = makeGraph();
    const r = expandLoopDrawer(graph, makeOverlay(), makeRun(), new Map([[LOOP_ID, 2]]));
    const drawer = r.nodes.find((n) => n.type === 'instanceGroup')!;
    const drawerX = drawer.position.x; // loop-relative
    expect(drawerX).toBeGreaterThanOrEqual(LOOP_GUTTER);
    for (const c of r.nodes.filter((n) => n.type === 'agentCard')) {
      // card x is drawer-relative; its loop-relative left edge clears the gutter lane.
      expect(drawerX + c.position.x).toBeGreaterThanOrEqual(LOOP_GUTTER);
    }
  });

  it('child-before-parent order holds for the appended drawer + cards', () => {
    const graph = makeGraph();
    const r = expandLoopDrawer(graph, makeOverlay(), makeRun(), new Map([[LOOP_ID, 2]]));
    const idx = new Map<string, number>();
    r.nodes.forEach((n, i) => idx.set(n.id, i));
    const drawer = r.nodes.find((n) => n.type === 'instanceGroup')!;
    expect(idx.get(drawer.id)!).toBeGreaterThan(idx.get(LOOP_ID)!);
    for (const c of r.nodes.filter((n) => n.type === 'agentCard')) {
      expect(idx.get(c.id)!).toBeGreaterThan(idx.get(drawer.id)!);
    }
  });

  it('a different round swaps the drawn cards (round 1 → 2 instances)', () => {
    const graph = makeGraph();
    const r = expandLoopDrawer(graph, makeOverlay(), makeRun(), new Map([[LOOP_ID, 1]]));
    const cards = r.nodes.filter((n) => n.type === 'agentCard');
    expect(cards.length).toBe(R1_IDS.length);
    const labels = cards.map((c) => (c.data as { label?: string }).label).sort();
    expect(labels).toEqual(R1_IDS.map((id) => `critique:${id}:r1`).sort());
  });

  it('an unknown round (no bound instances) is a no-op', () => {
    const graph = makeGraph();
    const r = expandLoopDrawer(graph, makeOverlay(), makeRun(), new Map([[LOOP_ID, 9]]));
    expect(r).toBe(graph);
  });

  it('shifts a same-lane sibling BELOW the loop down by the loop’s growth', () => {
    const graph = makeGraph();
    // Add a lane sibling (a finalize step) below the loop in lane-2.
    const SIBLING = 'agent:finalize:1';
    const SIBLING_Y = LOOP_Y + LOOP_H + 40;
    graph.nodes.push({
      id: SIBLING,
      type: 'planAgent',
      parentId: LANE_2,
      extent: 'parent',
      position: { x: LOOP_X, y: SIBLING_Y },
      data: { bindStatus: 'not-run', bindAgentIds: [], painted: true },
      style: { width: BODY_W, height: BODY_H },
    });
    const r = expandLoopDrawer(graph, makeOverlay(), makeRun(), new Map([[LOOP_ID, 2]]));
    const loopBefore = LOOP_H;
    const loopAfter = (r.nodes.find((n) => n.id === LOOP_ID)!.style as { height: number }).height;
    const grow = loopAfter - loopBefore;
    const sibling = r.nodes.find((n) => n.id === SIBLING)!;
    expect(sibling.position.y).toBe(SIBLING_Y + grow);
    // It no longer overlaps the grown loop.
    expect(absRect(r, SIBLING).y).toBeGreaterThanOrEqual(absRect(r, LOOP_ID).y + absRect(r, LOOP_ID).h);
  });

  it('marks a failed round instance as a failure point', () => {
    const graph = makeGraph();
    const r = expandLoopDrawer(graph, makeOverlay(), makeRun(), new Map([[LOOP_ID, 2]]), new Set(['c2b']));
    const failed = r.nodes.find(
      (n) => n.type === 'agentCard' && (n.data as { agentId?: string }).agentId === 'c2b',
    );
    expect((failed!.data as { failurePoint?: boolean }).failurePoint).toBe(true);
    const clean = r.nodes.find(
      (n) => n.type === 'agentCard' && (n.data as { agentId?: string }).agentId === 'c2a',
    );
    expect((clean!.data as { failurePoint?: boolean }).failurePoint).toBe(false);
  });
});

// STEP 3(d) — in 'round-axis' mode (option 1, the DEFAULT) the in-loop drawer must be a NO-OP, so
// option 1's painted/round-axis layout is byte-for-byte unchanged. App.tsx only ever calls
// expandLoopDrawer when `loopDrillMode === 'lane-drawer'` (the gate at App.tsx ~L608); in
// 'round-axis' mode `loopDrawerRound` stays EMPTY, so the call shape is `expandLoopDrawer(graph,
// …, new Map())`. These tests pin that contract from the layout side: the empty-open-map call is a
// referential identity, and NONE of the option-2 mutations (drawer cards, the left gutter, the
// grown loop/lane, the re-routed back-edge) ever appear on the option-1 graph.
describe('round-axis mode (option 1) — no regression: the in-loop drawer is inert', () => {
  it('the empty-open-map call (the round-axis-mode call shape) returns the graph by reference', () => {
    const graph = makeGraph();
    const r = expandLoopDrawer(graph, makeOverlay(), makeRun(), new Map());
    expect(r).toBe(graph); // same object — option 1's layout flows through untouched
  });

  it('emits NO option-2 nodes (no in-loop drawer, no instance cards) in round-axis mode', () => {
    const graph = makeGraph();
    const r = expandLoopDrawer(graph, makeOverlay(), makeRun(), new Map());
    expect(r.nodes.some((n) => n.type === 'instanceGroup')).toBe(false);
    expect(r.nodes.some((n) => n.type === 'agentCard')).toBe(false);
    // The node set is identical to option 1's input (no additions, no removals).
    expect(r.nodes.map((n) => n.id)).toEqual(graph.nodes.map((n) => n.id));
  });

  it('does NOT open the gutter, grow the loop/lane, or re-route the back-edge in round-axis mode', () => {
    const graph = makeGraph();
    const r = expandLoopDrawer(graph, makeOverlay(), makeRun(), new Map());
    // The loop body + decision keep their original (un-gutter-shifted) x.
    expect(r.nodes.find((n) => n.id === LOOP_BODY)!.position.x).toBe(BODY_X);
    expect(r.nodes.find((n) => n.id === LOOP_DECISION)!.position.x).toBe(BODY_X);
    // The loop container + enclosing lane keep their original size.
    expect((r.nodes.find((n) => n.id === LOOP_ID)!.style as { width: number; height: number })).toEqual({
      width: LOOP_W,
      height: LOOP_H,
    });
    expect((r.nodes.find((n) => n.id === LANE_2)!.style as { height: number }).height).toBe(380);
    // The dashed loop-back edge is NOT re-routed (no pathOptions bow).
    const back = r.edges.find((e) => e.id === 'e-loopback')!;
    expect((back as Edge & { pathOptions?: unknown }).pathOptions).toBeUndefined();
    expect(back.targetHandle).toBeUndefined();
  });
});
