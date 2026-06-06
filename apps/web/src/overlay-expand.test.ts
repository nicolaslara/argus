import { describe, it, expect } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { AgentNode, Overlay, RunModel } from '@argus/contract';
import type { GraphResult } from './mapping.ts';
import type { LiveFill } from './live-agent-fill.ts';
import { CARD_SHELL_WIDTH, CARD_SHELL_HEIGHT_EXEC } from './nodes/AgentCardShell.tsx';
import {
  expandInstances,
  drawerSize,
  drawerCols,
  DRAWER_GAP,
  CHIP_DEGRADE_THRESHOLD,
} from './overlay-expand.ts';

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
const agentIdsFor = (n: number): string[] => Array.from({ length: n }, (_, i) => `a${i + 1}`);

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

function makeGraph(agentIds: string[] = AGENT_IDS): GraphResult {
  const count = agentIds.length;
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
        bindAgentIds: agentIds,
        bindSucceeded: count,
        bindFailed: 0,
        bindTotal: count,
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

function makeOverlay(agentIds: string[] = AGENT_IDS): Overlay {
  const count = agentIds.length;
  return {
    bindings: [
      {
        planNodeId: TEMPLATE_ID,
        agentIds,
        status: 'complete',
        succeeded: count,
        failed: 0,
        total: count,
        confidence: 'medium',
        ambiguous: false,
      },
    ],
    unplannedAgentIds: [],
    rounds: null,
  };
}

function makeRun(agentIds: string[] = AGENT_IDS): RunModel {
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
    agents: agentIds.map((id) => agentNode({ agentId: id })),
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

// Ship #6 — DENSITY DEGRADE: above CHIP_DEGRADE_THRESHOLD an expanded fan collapses from full
// cards to compact chips + a `+N more` overflow tile, so the drawer height stays BOUNDED.
describe('expandInstances — density degrade to chips (N=50)', () => {
  const BIG_N = 50;
  const bigIds = agentIdsFor(BIG_N);
  const graph = makeGraph(bigIds);
  const overlay = makeOverlay(bigIds);
  const run = makeRun(bigIds);
  const result = expandInstances(graph, overlay, run, new Set([TEMPLATE_ID]), false);

  const drawer = result.nodes.find((n) => n.type === 'instanceGroup');
  const chips = result.nodes.filter((n) => n.type === 'agentChip');
  const fullCards = result.nodes.filter((n) => n.type === 'agentCard');

  it('emits chips (not full cards) + exactly one `+N more` overflow tile', () => {
    expect(BIG_N).toBeGreaterThan(CHIP_DEGRADE_THRESHOLD);
    expect(drawer).toBeDefined();
    // Degraded: no full agentCard cells at all.
    expect(fullCards.length).toBe(0);
    expect(chips.length).toBeGreaterThan(0);
    // Exactly one overflow tile, carrying the hidden remainder via data.more.
    const tiles = chips.filter((c) => (c.data as { more?: number }).more != null);
    expect(tiles.length).toBe(1);
    const more = (tiles[0]!.data as { more: number }).more;
    const realChips = chips.length - 1;
    // The rendered chips + the hidden remainder account for every instance.
    expect(realChips + more).toBe(BIG_N);
    // The cap is honored: the rendered cell count is bounded well below N.
    expect(chips.length).toBeLessThanOrEqual(24);
    expect(chips.length).toBeLessThan(BIG_N);
  });

  it('real chips carry {label,state,durationMs,agentId}; the tile carries {more}', () => {
    for (const c of chips) {
      const d = c.data as { label?: string; state?: string; agentId?: string; more?: number };
      if (d.more != null) continue; // the overflow tile
      expect(typeof d.label).toBe('string');
      expect(typeof d.state).toBe('string');
      expect(typeof d.agentId).toBe('string');
    }
  });

  it('the drawer height is BOUNDED — far smaller than 50 full-card rows', () => {
    const degraded = drawerSize(BIG_N);
    const drawerH = (drawer!.style as { height: number }).height;
    expect(drawerH).toBe(degraded.height);
    // What 50 FULL cards would have cost (the pre-degrade arithmetic): ceil(50/5)=10 card rows
    // + 1 ghost, each CARD_SHELL_HEIGHT_EXEC tall. The degraded drawer must be a fraction of it.
    const fullCols = drawerCols(BIG_N);
    const fullRows = Math.ceil(BIG_N / fullCols) + 1;
    const fullCardGridH = fullRows * CARD_SHELL_HEIGHT_EXEC; // lower bound on the un-degraded body
    expect(drawerH).toBeLessThan(fullCardGridH / 2);
  });

  it('every chip rect is inside the drawer rect', () => {
    const ds = drawer!.style as { width: number; height: number };
    for (const c of chips) {
      expect(c.position.x).toBeGreaterThanOrEqual(0);
      expect(c.position.y).toBeGreaterThanOrEqual(0);
      // Chips use the compact footprint, narrower than a card; they must fit the drawer box.
      expect(c.position.x).toBeLessThanOrEqual(ds.width);
      expect(c.position.y).toBeLessThanOrEqual(ds.height);
    }
  });

  it('every child node index > its parent node index', () => {
    const indexOf = new Map<string, number>();
    result.nodes.forEach((n, i) => indexOf.set(n.id, i));
    for (const n of result.nodes) {
      if (typeof n.parentId === 'string') {
        expect(indexOf.get(n.id)!).toBeGreaterThan(indexOf.get(n.parentId)!);
      }
    }
  });

  it('grows the host lane by exactly the (bounded) drawerH', () => {
    const degraded = drawerSize(BIG_N);
    const drawerH = degraded.height + DRAWER_GAP;
    const lane = result.nodes.find((n) => n.id === LANE_ID)!;
    expect((lane.style as { height: number }).height).toBe(400 + drawerH);
  });
});

// A fan AT the threshold still renders full cards (the small-fan path is unchanged).
describe('expandInstances — fan at/below threshold still renders full cards', () => {
  const ids = agentIdsFor(CHIP_DEGRADE_THRESHOLD); // exactly the threshold → NOT degraded
  const result = expandInstances(
    makeGraph(ids),
    makeOverlay(ids),
    makeRun(ids),
    new Set([TEMPLATE_ID]),
    false,
  );
  it('emits full agentCard cells and no chips', () => {
    expect(result.nodes.filter((n) => n.type === 'agentChip').length).toBe(0);
    expect(result.nodes.filter((n) => n.type === 'agentCard').length).toBe(CHIP_DEGRADE_THRESHOLD);
    expect(drawerSize(CHIP_DEGRADE_THRESHOLD).degraded).toBe(false);
  });
});

// STEP 2 (failure-and-live-inspector §4) — expandInstances PASSES the live transcript fill
// through to the (full-card) instance cards, so a RUNNING fan's metric-starved cards show real
// dur/tok/tools/label. The fill is data-only — it never touches the layout arithmetic.
describe('expandInstances — live fill threads into the instance cards', () => {
  // A live fan: every agent is running with starved metrics (null dur/tok/tools, no label) —
  // exactly the live-journal state the transcript fill exists to repair. The card renders these
  // nulls as em-dashes and the empty label falls back to the bare agentId.
  const liveAgent = (over: Partial<AgentNode> & { agentId: string }): AgentNode =>
    agentNode({
      state: 'running',
      label: '', // no journal label — the card falls back to the agentId until the fill arrives
      tokens: null,
      toolCalls: null,
      durationMs: null,
      ...over,
    });

  function makeLiveRun(agentIds: string[]): RunModel {
    return { ...makeRun(agentIds), incomplete: true, status: 'running', agents: agentIds.map((id) => liveAgent({ agentId: id })) };
  }

  const ids = agentIdsFor(3);
  const liveRun = makeLiveRun(ids);
  const liveFill: Map<string, LiveFill> = new Map([
    // a1 gets a full fill; a2 a partial fill; a3 is ABSENT from the map (e.g. a 404 transcript).
    ['a1', { durationMs: 4200, tokens: 1500, toolCount: 9, label: 'research:surface' }],
    ['a2', { tokens: 700, label: 'research:io' }],
  ]);

  const result = expandInstances(
    makeGraph(ids),
    makeOverlay(ids),
    liveRun,
    new Set([TEMPLATE_ID]),
    true, // live
    undefined, // no failure
    liveFill,
  );
  const cardData = (agentId: string): Record<string, unknown> =>
    result.nodes.find((n) => n.type === 'agentCard' && (n.data as { agentId?: string }).agentId === agentId)!
      .data as Record<string, unknown>;

  it('(d) a fan instance WITH a full fill shows the transcript dur/tok/tools/label', () => {
    const d = cardData('a1');
    expect(d.durationMs).toBe(4200);
    expect(d.tokens).toBe(1500);
    expect(d.toolCalls).toBe(9);
    expect(d.label).toBe('research:surface');
  });

  it('(d) a fan instance with a PARTIAL fill fills present fields, leaves the rest starved', () => {
    const d = cardData('a2');
    expect(d.tokens).toBe(700);
    expect(d.label).toBe('research:io');
    expect(d.durationMs).toBeNull(); // not in the fill → stays starved (em-dash)
    expect(d.toolCalls).toBeNull();
  });

  it('(d) a fan instance ABSENT from the fill keeps its journal/em-dash values', () => {
    const d = cardData('a3');
    expect(d.durationMs).toBeNull();
    expect(d.tokens).toBeNull();
    expect(d.toolCalls).toBeNull();
    expect(d.label).toBe('a3'); // bare-id fallback (no fill entry)
  });

  it('a finished run is byte-unchanged whether or not a fill is passed (journal wins)', () => {
    // makeRun() agents already carry journal metrics (tokens:100, tools:1, dur:1000) → the fill
    // is a no-op. The card data must be identical with and without a fill map.
    const finished = makeRun(ids);
    const noFill = expandInstances(makeGraph(ids), makeOverlay(ids), finished, new Set([TEMPLATE_ID]), false);
    const withFill = expandInstances(
      makeGraph(ids),
      makeOverlay(ids),
      finished,
      new Set([TEMPLATE_ID]),
      false,
      undefined,
      liveFill, // a fill that would otherwise change a1/a2 — but the journal wins
    );
    for (const id of ids) {
      const a = noFill.nodes.find((n) => n.type === 'agentCard' && (n.data as { agentId?: string }).agentId === id)!;
      const b = withFill.nodes.find((n) => n.type === 'agentCard' && (n.data as { agentId?: string }).agentId === id)!;
      expect(b.data).toEqual(a.data);
    }
  });
});
