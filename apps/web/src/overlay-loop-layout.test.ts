import { describe, it, expect } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { AgentNode, Overlay, RunModel } from '@argus/contract';
import type { GraphResult } from './mapping.ts';
import { CARD_SHELL_WIDTH, CARD_SHELL_HEIGHT_EXEC } from './nodes/AgentCardShell.tsx';
import { expandInstances, drawerSize, DRAWER_GAP } from './overlay-expand.ts';

// STEP 3(a) — a loop back-edge still re-docks / the loop REGION lays out without overlap after
// the drill change (run-view-merge-plan.md §2, §5, Risk 2 "the back-edge is the regression
// canary"). The chosen design reaches a loop body's agents via the round axis → DetailPanel,
// NOT a lane-drawer inside the loop. So the loop region must be INERT to the flat-fan drawer
// mechanism: expandInstances must never lane-draw a loop body, and a flat-fan expand in another
// lane must leave the loop container / its body / the loop-back edge byte-identical (so React
// Flow re-docks the waypoint-free back-edge to the unchanged handles for free).
//
// This is a pure layout/structure test (mirrors overlay-expand.test.ts) over a SYNTHETIC loop
// graph shaped exactly as planModelToGraph emits one:
//   lane-1 [ flat-fan template (fanned, bound 4) → drawer-able, + a sibling below ]
//   lane-2 [ loop container (planLoop) > loop body (parented to the loop, extent:'parent'),
//            with a waypoint-free loop-back edge body → loop ]

const FLAT_TEMPLATE = 'agent:research:1';
const FLAT_SIBLING = 'agent:synthesize:1';
const LANE_1 = 'lane-1';
const LANE_2 = 'lane-2';
const LOOP_ID = 'loop-1';
const LOOP_BODY = 'agent:critique:r:1';

const FLAT_N = 4;
const FLAT_IDS = Array.from({ length: FLAT_N }, (_, i) => `f${i + 1}`);

const TEMPLATE_Y = 40;
const TEMPLATE_H = CARD_SHELL_HEIGHT_EXEC;
const SIBLING_Y = TEMPLATE_Y + TEMPLATE_H + 60;

// Loop container geometry (lane-2-relative). The body sits INSIDE it (loop-relative).
const LOOP_X = 30;
const LOOP_Y = 40;
const LOOP_W = 420;
const LOOP_H = 240;
const BODY_X = 24;
const BODY_Y = 90;
const BODY_W = CARD_SHELL_WIDTH;
const BODY_H = TEMPLATE_H;

function agentNode(over: Partial<AgentNode> & { agentId: string; label: string }): AgentNode {
  return {
    index: 0,
    phaseIndex: 1,
    model: null,
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
    // --- lane-1: the FLAT fan (parents before children) -----------------------------------
    {
      id: LANE_1,
      type: 'phaseLane',
      position: { x: 0, y: 0 },
      data: { index: 1, title: 'Research', agentCount: 2 },
      style: { width: 600, height: 400 },
    },
    {
      id: FLAT_TEMPLATE,
      type: 'planAgent',
      parentId: LANE_1,
      extent: 'parent',
      position: { x: 30, y: TEMPLATE_Y },
      data: {
        bindStatus: 'complete',
        bindAgentIds: FLAT_IDS,
        bindSucceeded: FLAT_N,
        bindFailed: 0,
        bindTotal: FLAT_N,
        painted: true,
      },
      style: { width: CARD_SHELL_WIDTH, height: TEMPLATE_H },
    },
    {
      id: FLAT_SIBLING,
      type: 'planAgent',
      parentId: LANE_1,
      extent: 'parent',
      position: { x: 30, y: SIBLING_Y },
      data: { bindStatus: 'complete', bindAgentIds: ['s1'], painted: true },
      style: { width: CARD_SHELL_WIDTH, height: TEMPLATE_H },
    },
    // --- lane-2: the LOOP region (loop container > body), a separate lane ------------------
    {
      id: LANE_2,
      type: 'phaseLane',
      position: { x: 800, y: 0 },
      data: { index: 2, title: 'Critique', agentCount: 0 },
      style: { width: 500, height: 360 },
    },
    {
      id: LOOP_ID,
      type: 'planLoop',
      parentId: LANE_2,
      extent: 'parent',
      position: { x: LOOP_X, y: LOOP_Y },
      data: { title: 'refine', stopCondition: 'until done', maxRounds: 3, painted: true, observedRounds: 2 },
      style: { width: LOOP_W, height: LOOP_H },
    },
    {
      // A loop body: parented to the LOOP container (NOT the lane), extent:'parent'. Its agents
      // are reached via the round axis, never a lane drawer — so it must carry no drawer.
      id: LOOP_BODY,
      type: 'planAgent',
      parentId: LOOP_ID,
      extent: 'parent',
      position: { x: BODY_X, y: BODY_Y },
      data: { bindStatus: 'partial', bindAgentIds: ['c1', 'c2'], painted: true },
      style: { width: BODY_W, height: BODY_H },
    },
  ];
  const edges: Edge[] = [
    // The loop-back edge: smoothstep, WAYPOINT-FREE (no baked points), body → loop container.
    // React Flow re-docks it to the (unchanged) handles; this is the regression canary.
    { id: 'e-loopback', source: LOOP_BODY, target: LOOP_ID, type: 'smoothstep' },
    // A plain spine edge between lanes (also waypoint-free).
    { id: 'spine-1-2', source: LANE_1, target: LANE_2, type: 'smoothstep' },
  ];
  return { nodes, edges };
}

function makeOverlay(): Overlay {
  return {
    bindings: [
      {
        planNodeId: FLAT_TEMPLATE,
        agentIds: FLAT_IDS,
        status: 'complete',
        succeeded: FLAT_N,
        failed: 0,
        total: FLAT_N,
        confidence: 'medium',
        ambiguous: false,
      },
      // The loop BODY binding is folded onto the body plan node (the per-round split lives in
      // overlay.loopRounds, consumed by the round axis — not by expandInstances).
      {
        planNodeId: LOOP_BODY,
        agentIds: ['c1', 'c2'],
        status: 'partial',
        succeeded: 1,
        failed: 1,
        total: 2,
        confidence: 'medium',
        ambiguous: false,
      },
    ],
    unplannedAgentIds: [],
    rounds: 2,
    loopRounds: {
      [LOOP_ID]: [
        { round: 1, agentIds: ['c1'], instances: [{ agentId: 'c1', label: 'critique:a:r1', state: 'done' }] },
        { round: 2, agentIds: ['c2'], instances: [{ agentId: 'c2', label: 'critique:a:r2', state: 'interrupted' }] },
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
    phases: [
      { index: 1, title: 'Research', detail: null },
      { index: 2, title: 'Critique', detail: null },
    ],
    agents: [
      ...FLAT_IDS.map((id) => agentNode({ agentId: id, label: `research:${id}` })),
      agentNode({ agentId: 's1', label: 'synthesize' }),
      agentNode({ agentId: 'c1', label: 'critique:a:r1' }),
      agentNode({ agentId: 'c2', label: 'critique:a:r2', state: 'interrupted' }),
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

/** Absolute rects of every node (lane-relative children resolved through their parent chain). */
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
  const w = s.width ?? CARD_SHELL_WIDTH;
  const h = s.height ?? CARD_SHELL_HEIGHT_EXEC;
  return { x, y, w, h };
}

function overlaps(a: ReturnType<typeof absRect>, b: ReturnType<typeof absRect>): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe('loop region — inert to the flat-fan drawer; back-edge re-docks (no lane-draw)', () => {
  it('a loop BODY fan is NEVER lane-drawn (round-axis drill, not a drawer inside the loop)', () => {
    const graph = makeGraph();
    // Hand expandInstances the loop body id directly — it must refuse (parent is a planLoop,
    // not a phaseLane) and return the graph by reference with no drawer/cards emitted.
    const r = expandInstances(graph, makeOverlay(), makeRun(), new Set([LOOP_BODY]), false);
    expect(r).toBe(graph);
    expect(r.nodes.some((n) => n.type === 'instanceGroup')).toBe(false);
  });

  it('expanding the FLAT fan leaves the loop container / body / loop-back edge UNTOUCHED', () => {
    const graph = makeGraph();
    const loopBefore = graph.nodes.find((n) => n.id === LOOP_ID)!;
    const bodyBefore = graph.nodes.find((n) => n.id === LOOP_BODY)!;
    const lane2Before = graph.nodes.find((n) => n.id === LANE_2)!;

    const r = expandInstances(graph, makeOverlay(), makeRun(), new Set([FLAT_TEMPLATE]), false);

    // The flat fan DID expand (the mechanism still works alongside the loop).
    const drawer = r.nodes.find((n) => n.type === 'instanceGroup');
    expect(drawer).toBeDefined();
    expect(r.nodes.filter((n) => n.type === 'agentCard').length).toBe(FLAT_N);

    // The loop region is in ANOTHER lane → byte-identical (same object identity: untouched
    // nodes are returned as-is, so the back-edge's source/target handles never move).
    const loopAfter = r.nodes.find((n) => n.id === LOOP_ID)!;
    const bodyAfter = r.nodes.find((n) => n.id === LOOP_BODY)!;
    const lane2After = r.nodes.find((n) => n.id === LANE_2)!;
    expect(loopAfter).toBe(loopBefore);
    expect(bodyAfter).toBe(bodyBefore);
    expect(lane2After).toBe(lane2Before);

    // The loop-back edge re-docks for free: edges are returned by reference, waypoint-free.
    expect(r.edges).toBe(graph.edges);
    const back = r.edges.find((e) => e.id === 'e-loopback')!;
    expect(back.source).toBe(LOOP_BODY);
    expect(back.target).toBe(LOOP_ID);
    // No baked waypoints to invalidate (the whole reason no re-route is needed).
    expect((back as Edge & { data?: { points?: unknown } }).data?.points).toBeUndefined();
  });

  it('the loop region lays out without overlap, before and after the flat-fan expand', () => {
    const graph = makeGraph();
    const r = expandInstances(graph, makeOverlay(), makeRun(), new Set([FLAT_TEMPLATE]), false);
    for (const g of [graph, r]) {
      // The loop body sits strictly INSIDE its loop container (extent:'parent' geometry holds).
      const loop = absRect(g, LOOP_ID);
      const body = absRect(g, LOOP_BODY);
      expect(body.x).toBeGreaterThanOrEqual(loop.x);
      expect(body.y).toBeGreaterThanOrEqual(loop.y);
      expect(body.x + body.w).toBeLessThanOrEqual(loop.x + loop.w);
      expect(body.y + body.h).toBeLessThanOrEqual(loop.y + loop.h);
      // The loop region does not collide with the (other-lane) flat fan or its drawer.
      const flat = absRect(g, FLAT_TEMPLATE);
      expect(overlaps(loop, flat)).toBe(false);
      const drawer = g.nodes.find((n) => n.type === 'instanceGroup');
      if (drawer) expect(overlaps(loop, absRect(g, drawer.id))).toBe(false);
    }
  });
});

// A loop CONTAINER as a same-lane sibling BELOW a flat fan: the real re-flow must push the whole
// loop region down by exactly drawerH (so it cannot overlap the grown drawer) WITHOUT distorting
// the loop's internal geometry — the body stays loop-relative, so it rides along intact and the
// back-edge handles stay docked.
describe('loop container as a same-lane sibling below a flat fan — shifts intact', () => {
  function sameLaneGraph(): GraphResult {
    const nodes: Node[] = [
      {
        id: LANE_1,
        type: 'phaseLane',
        position: { x: 0, y: 0 },
        data: { index: 1, title: 'P', agentCount: 1 },
        style: { width: 700, height: 500 },
      },
      {
        id: FLAT_TEMPLATE,
        type: 'planAgent',
        parentId: LANE_1,
        extent: 'parent',
        position: { x: 30, y: TEMPLATE_Y },
        data: {
          bindStatus: 'complete',
          bindAgentIds: FLAT_IDS,
          bindSucceeded: FLAT_N,
          bindFailed: 0,
          bindTotal: FLAT_N,
          painted: true,
        },
        style: { width: CARD_SHELL_WIDTH, height: TEMPLATE_H },
      },
      // The loop container is a LANE MEMBER below the template (its body parented to IT).
      {
        id: LOOP_ID,
        type: 'planLoop',
        parentId: LANE_1,
        extent: 'parent',
        position: { x: 30, y: SIBLING_Y },
        data: { title: 'refine', stopCondition: 'until done', maxRounds: 3, painted: true },
        style: { width: LOOP_W, height: LOOP_H },
      },
      {
        id: LOOP_BODY,
        type: 'planAgent',
        parentId: LOOP_ID,
        extent: 'parent',
        position: { x: BODY_X, y: BODY_Y },
        data: { bindStatus: 'partial', bindAgentIds: ['c1', 'c2'], painted: true },
        style: { width: BODY_W, height: BODY_H },
      },
    ];
    const edges: Edge[] = [{ id: 'e-loopback', source: LOOP_BODY, target: LOOP_ID, type: 'smoothstep' }];
    return { nodes, edges };
  }

  it('shifts the loop container down by exactly drawerH; body stays loop-relative (intact)', () => {
    const graph = sameLaneGraph();
    const drawerH = drawerSize(FLAT_N).height + DRAWER_GAP;
    const r = expandInstances(graph, makeOverlay(), makeRun(), new Set([FLAT_TEMPLATE]), false);

    const loop = r.nodes.find((n) => n.id === LOOP_ID)!;
    const body = r.nodes.find((n) => n.id === LOOP_BODY)!;
    // The loop container (a same-lane sibling below the template) shifts down by drawerH.
    expect(loop.position.y).toBe(SIBLING_Y + drawerH);
    // The body's LOOP-RELATIVE position is unchanged — it rides the container, so the loop's
    // internal geometry (and the back-edge's handles) is preserved across the shift.
    expect(body.position).toEqual({ x: BODY_X, y: BODY_Y });
    expect((body.style as { width: number; height: number })).toEqual({ width: BODY_W, height: BODY_H });

    // The shifted loop region no longer overlaps the drawer that pushed it down.
    const drawer = r.nodes.find((n) => n.type === 'instanceGroup')!;
    expect(overlaps(absRect(r, LOOP_ID), absRect(r, drawer.id))).toBe(false);
    // The body is still inside its (shifted) container.
    expect(overlaps(absRect(r, LOOP_BODY), absRect(r, LOOP_ID))).toBe(true);
    const bAbs = absRect(r, LOOP_BODY);
    const lAbs = absRect(r, LOOP_ID);
    expect(bAbs.x).toBeGreaterThanOrEqual(lAbs.x);
    expect(bAbs.y).toBeGreaterThanOrEqual(lAbs.y);
    expect(bAbs.x + bAbs.w).toBeLessThanOrEqual(lAbs.x + lAbs.w);
    expect(bAbs.y + bAbs.h).toBeLessThanOrEqual(lAbs.y + lAbs.h);

    // child-before-parent rank holds for the loop body after the re-flow append.
    const idx = new Map<string, number>();
    r.nodes.forEach((n, i) => idx.set(n.id, i));
    expect(idx.get(LOOP_BODY)!).toBeGreaterThan(idx.get(LOOP_ID)!);
    // The back-edge is still docked to the (moved-as-a-unit) handles, no waypoints.
    expect(r.edges).toBe(graph.edges);
  });
});
