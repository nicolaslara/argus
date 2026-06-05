import { describe, it, expect } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { AgentNode, Overlay, RunModel } from '@argus/contract';
import type { GraphResult } from './mapping.ts';
import { CARD_SHELL_WIDTH, CARD_SHELL_HEIGHT_EXEC } from './nodes/AgentCardShell.tsx';
import { expandInstances, drawerSize, drawerCols, DRAWER_GAP } from './overlay-expand.ts';

// STEP 2 — browser-free correctness of the pure drawer re-flow (run-view-merge-plan.md §2).
// A SYNTHETIC painted graph + overlay with ONE fan-out template (N=7) bound to 7 agents,
// plus a same-lane sibling BELOW the template, plus a SECOND, unrelated lane. We assert the
// six §2 invariants without ELK or React.

const TEMPLATE_ID = 'agent:research:1';
const LANE_ID = 'phase-1';
const SIBLING_ID = 'agent:synthesize:1';
const OTHER_LANE_ID = 'phase-2';
const OTHER_MEMBER_ID = 'agent:design:2';

const N = 7;
const AGENT_IDS = Array.from({ length: N }, (_, i) => `a${i + 1}`);

// The template's lane-relative geometry (mirrors a painted plan agent card).
const TEMPLATE_Y = 40;
const TEMPLATE_H = CARD_SHELL_HEIGHT_EXEC;
const TEMPLATE_BOTTOM = TEMPLATE_Y + TEMPLATE_H;
// A sibling sits below the template in the SAME lane (must shift down on expand).
const SIBLING_Y = TEMPLATE_BOTTOM + 60;

function agentNode(over: Partial<AgentNode> & { agentId: string }): AgentNode {
  return {
    index: 0,
    label: over.agentId,
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
    // Lane 1 (the host lane) — parent BEFORE its children.
    {
      id: LANE_ID,
      type: 'phaseLane',
      position: { x: 0, y: 0 },
      data: { index: 1, title: 'Research', agentCount: 2 },
      style: { width: 600, height: 400 },
    },
    // The fan-out template, parented to lane 1, with bindAgentIds painted on data.
    {
      id: TEMPLATE_ID,
      type: 'planAgent',
      parentId: LANE_ID,
      extent: 'parent',
      position: { x: 30, y: TEMPLATE_Y },
      data: {
        bindStatus: 'complete',
        bindAgentIds: AGENT_IDS,
        bindSucceeded: N,
        bindFailed: 0,
        bindTotal: N,
        painted: true,
      },
      style: { width: CARD_SHELL_WIDTH, height: TEMPLATE_H },
    },
    // A same-lane sibling BELOW the template — must shift down by drawerH.
    {
      id: SIBLING_ID,
      type: 'planAgent',
      parentId: LANE_ID,
      extent: 'parent',
      position: { x: 30, y: SIBLING_Y },
      data: { bindStatus: 'complete', bindAgentIds: ['s1'], painted: true },
      style: { width: CARD_SHELL_WIDTH, height: TEMPLATE_H },
    },
    // Lane 2 — a wholly unrelated lane that must NOT move.
    {
      id: OTHER_LANE_ID,
      type: 'phaseLane',
      position: { x: 800, y: 0 },
      data: { index: 2, title: 'Design', agentCount: 1 },
      style: { width: 400, height: 300 },
    },
    {
      id: OTHER_MEMBER_ID,
      type: 'planAgent',
      parentId: OTHER_LANE_ID,
      extent: 'parent',
      position: { x: 20, y: 50 },
      data: { painted: true },
      style: { width: CARD_SHELL_WIDTH, height: TEMPLATE_H },
    },
  ];
  const edges: Edge[] = [
    { id: 'spine-1-2', source: LANE_ID, target: OTHER_LANE_ID, type: 'smoothstep' },
  ];
  return { nodes, edges };
}

function makeOverlay(): Overlay {
  return {
    bindings: [
      {
        planNodeId: TEMPLATE_ID,
        agentIds: AGENT_IDS,
        status: 'complete',
        succeeded: N,
        failed: 0,
        total: N,
        confidence: 'medium',
        ambiguous: false,
      },
    ],
    unplannedAgentIds: [],
    rounds: null,
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
    phases: [{ index: 1, title: 'Research', detail: null }],
    agents: AGENT_IDS.map((id) => agentNode({ agentId: id })),
    edges: [],
    logs: [],
    partialFailure: { present: false, lines: [] },
    error: null,
    args: null,
    warnings: [],
    format: 'cc-workflow/observed-2026-06-04',
  };
}

describe('expandInstances — flat fan-out lane-drawer (N=7)', () => {
  const graph = makeGraph();
  const overlay = makeOverlay();
  const run = makeRun();
  const expanded = new Set([TEMPLATE_ID]);
  const result = expandInstances(graph, overlay, run, expanded, false);

  const drawer = result.nodes.find((n) => n.type === 'instanceGroup');
  const cards = result.nodes.filter((n) => n.type === 'agentCard');

  it('(a) emits exactly one drawer + 7 instance cards', () => {
    expect(drawer).toBeDefined();
    expect(cards.length).toBe(N);
    // The drawer is parented to the host lane.
    expect(drawer!.parentId).toBe(LANE_ID);
    // Every card is parented to the drawer.
    for (const c of cards) expect(c.parentId).toBe(drawer!.id);
  });

  it('(b) every card rect is inside the drawer rect', () => {
    const ds = drawer!.style as { width: number; height: number };
    for (const c of cards) {
      expect(c.position.x).toBeGreaterThanOrEqual(0);
      expect(c.position.y).toBeGreaterThanOrEqual(0);
      expect(c.position.x + CARD_SHELL_WIDTH).toBeLessThanOrEqual(ds.width);
      expect(c.position.y + CARD_SHELL_HEIGHT_EXEC).toBeLessThanOrEqual(ds.height);
    }
  });

  it('(c) the same-lane sibling below the template is shifted down by exactly drawerH', () => {
    const size = drawerSize(N);
    const drawerH = size.height + DRAWER_GAP;
    const sibling = result.nodes.find((n) => n.id === SIBLING_ID)!;
    expect(sibling.position.y).toBe(SIBLING_Y + drawerH);
    // sanity: the drawer's explicit size matches the size-fn used to grow the lane.
    expect((drawer!.style as { height: number }).height).toBe(size.height);
  });

  it('grows the host lane height by exactly drawerH', () => {
    const size = drawerSize(N);
    const drawerH = size.height + DRAWER_GAP;
    const lane = result.nodes.find((n) => n.id === LANE_ID)!;
    expect((lane.style as { height: number }).height).toBe(400 + drawerH);
  });

  it('(d) every child node index > its parent node index', () => {
    const indexOf = new Map<string, number>();
    result.nodes.forEach((n, i) => indexOf.set(n.id, i));
    for (const n of result.nodes) {
      if (typeof n.parentId === 'string') {
        expect(indexOf.get(n.id)!).toBeGreaterThan(indexOf.get(n.parentId)!);
      }
    }
  });

  it('(e) the other lane and its member are unchanged', () => {
    const otherLane = result.nodes.find((n) => n.id === OTHER_LANE_ID)!;
    const otherMember = result.nodes.find((n) => n.id === OTHER_MEMBER_ID)!;
    expect(otherLane.position).toEqual({ x: 800, y: 0 });
    expect(otherLane.style).toEqual({ width: 400, height: 300 });
    expect(otherMember.position).toEqual({ x: 20, y: 50 });
    // identity preserved (untouched node objects are returned as-is).
    const origOther = graph.nodes.find((n) => n.id === OTHER_LANE_ID)!;
    expect(otherLane).toBe(origOther);
  });

  it('does not mutate the input graph and leaves edges untouched', () => {
    // The original sibling node object is not mutated in place.
    const origSibling = graph.nodes.find((n) => n.id === SIBLING_ID)!;
    expect(origSibling.position.y).toBe(SIBLING_Y);
    // Edges are returned by reference (waypoint-free; React Flow re-docks them).
    expect(result.edges).toBe(graph.edges);
  });

  it('returns the graph unchanged when nothing is expanded', () => {
    const same = expandInstances(graph, overlay, run, new Set(), false);
    expect(same).toBe(graph);
  });
});

describe('drawerSize / drawerCols — geometry', () => {
  it('cols = clamp(ceil(sqrt(N)), 2, 5)', () => {
    expect(drawerCols(1)).toBe(2); // floor of 2
    expect(drawerCols(4)).toBe(2);
    expect(drawerCols(7)).toBe(3); // ceil(sqrt(7)) = 3
    expect(drawerCols(25)).toBe(5);
    expect(drawerCols(50)).toBe(5); // ceiling of 5
  });

  it('height accounts for ceil(N/cols) card rows + one ghost row', () => {
    const s = drawerSize(7);
    expect(s.cols).toBe(3);
    expect(s.rows).toBe(Math.ceil(7 / 3) + 1); // 3 card rows + 1 ghost = 4
  });
});
