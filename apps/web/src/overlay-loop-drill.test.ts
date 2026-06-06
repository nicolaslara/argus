import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Node } from '@xyflow/react';
import { parsePlan, parseFinalizedRun } from '@argus/adapter';
import type {
  AgentNode,
  LoopRoundBinding,
  Overlay,
  PlanModel,
  RunModel,
} from '@argus/contract';
import type { GraphResult } from './mapping.ts';
import { buildOverlay } from './overlay.ts';
import { paintOverlay } from './overlay-paint.ts';
import { expandInstances } from './overlay-expand.ts';

// STEP 3(b) — a 2-round loop-body fan's per-round agents are REACHABLE through the chosen
// drill: the loop's ROUND AXIS → DetailPanel (run-view-merge-plan.md §5, §3). The loop body's
// subagents are NOT lane-drawn; they are reached via the round axis, so "reachable" means:
//   1. buildOverlay splits the loop body's bound agents BY ROUND, keyed by the loop container
//      id (overlay.loopRounds[loopId]) — the data the round axis renders.
//   2. paintOverlay paints that split onto the planLoop node as `roundBindings` — exactly what
//      LoopContainer's round pills read and what `selectRound(loopId, round)` hands to the
//      DetailPanel.
//   3. Every loop-body bound instance is reachable from SOME round (the per-round agentIds
//      union == the folded whole-body binding) — no instance is stranded by the round split.
// This exercises the PRODUCTION path (real fixture) end-to-end, and a crafted 2-round model
// for an isolated, signal-precise check.

const here = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(here, '../../../.argus/fixtures');

function loadPlan(js: string): PlanModel {
  return parsePlan(readFileSync(resolve(FIX, 'named-workflows', js), 'utf8'), js);
}
function loadRun(wf: string, runId: string): RunModel {
  const raw = JSON.parse(readFileSync(resolve(FIX, 'finished', wf), 'utf8')) as unknown;
  return parseFinalizedRun(raw, { ref: { projectPath: '', slug: 's', sessionId: 'x', runId } });
}

/** The painted planLoop node's data, as LoopContainer reads it (round axis source of truth). */
interface PaintedLoopData {
  observedRounds?: number | null;
  roundBindings?: LoopRoundBinding[];
  unrolled?: boolean;
  painted?: boolean;
}

/** Read the painted planLoop node for a given loop container id from a painted graph. */
function paintedLoop(graph: GraphResult, loopId: string): Node & { data: PaintedLoopData } {
  const n = graph.nodes.find((x) => x.id === loopId && x.type === 'planLoop');
  expect(n, `painted planLoop ${loopId}`).toBeDefined();
  return n as Node & { data: PaintedLoopData };
}

// A minimal painted plan graph carrying ONE loop container node, so paintOverlay has a
// planLoop node to project overlay.loopRounds onto (mirrors planModelToGraph's loop-container
// node: type 'planLoop', the loop body's per-round split lives in overlay, NOT on the lane).
function loopGraph(loopId: string): GraphResult {
  const nodes: Node[] = [
    {
      id: 'lane-1',
      type: 'phaseLane',
      position: { x: 0, y: 0 },
      data: { index: 1, title: 'Critique', agentCount: 0 },
      style: { width: 600, height: 400 },
    },
    {
      id: loopId,
      type: 'planLoop',
      parentId: 'lane-1',
      extent: 'parent',
      position: { x: 30, y: 40 },
      data: { title: 'refine', stopCondition: 'until done', maxRounds: 3, confidence: 'static' },
      style: { width: 400, height: 220 },
    },
  ];
  return { nodes, edges: [] };
}

describe('loop-body drill — REAL fixture (refine-plan × killed-9agents, rounds=2)', () => {
  const plan = loadPlan('refine-plan.js');
  const run = loadRun('killed-9agents.wf.json', 'wf_refine');
  const overlay = buildOverlay(plan, run);
  const LOOP_ID = 'loop-1'; // the one loop container in refine-plan.js

  it('overlay splits the loop body BY ROUND under the loop container id (the round-axis data)', () => {
    expect(overlay.rounds).toBe(2);
    const rbs = overlay.loopRounds?.[LOOP_ID];
    expect(rbs, 'loopRounds keyed by the loop container id').toBeDefined();
    expect(rbs!.map((r) => r.round)).toEqual([1, 2]); // ascending, one entry per observed round
    // Each round exposes its bound agentIds (what `selectRound(loopId, round)` scopes to).
    for (const rb of rbs!) {
      expect(rb.agentIds.length).toBeGreaterThan(0);
      // Every round instance carries the drill payload a DetailPanel row needs.
      for (const inst of rb.instances) {
        expect(typeof inst.agentId).toBe('string');
        expect(typeof inst.label).toBe('string');
        expect(typeof inst.state).toBe('string');
      }
      // agentIds and instances describe the SAME set (no row missing an id).
      expect(rb.agentIds).toEqual(rb.instances.map((i) => i.agentId));
    }
  });

  it('every loop-body bound instance is reachable from SOME round (union == folded binding)', () => {
    const rbs = overlay.loopRounds![LOOP_ID]!;
    const perRound = new Set(rbs.flatMap((rb) => rb.agentIds));
    // The folded whole-body binding (critique + revise) — every one of these must be drillable.
    const folded = new Set(
      overlay.bindings
        .filter((b) => b.planNodeId.startsWith('agent:critique:') || b.planNodeId.startsWith('agent:revise:'))
        .flatMap((b) => b.agentIds),
    );
    expect(folded.size).toBeGreaterThan(0);
    for (const id of folded) expect(perRound.has(id)).toBe(true);
    // …and the round split invents NOTHING the binding doesn't have.
    for (const id of perRound) expect(folded.has(id)).toBe(true);
  });

  it('round 2 surfaces its instances DESPITE interruptions (a partial round stays drillable)', () => {
    const r2 = overlay.loopRounds![LOOP_ID]!.find((rb) => rb.round === 2)!;
    expect(r2.instances.length).toBeGreaterThan(0);
    // The killed run interrupted some r2 critics — they must STILL be reachable (honest about
    // what ran), not dropped from the drill.
    expect(r2.instances.some((i) => i.state === 'interrupted')).toBe(true);
  });

  it('paintOverlay puts the per-round split on the planLoop node (the round-axis reads it)', () => {
    const graph = loopGraph(LOOP_ID);
    const painted = paintOverlay(graph, overlay, /* unrolled */ true, /* live */ false);
    const loop = paintedLoop(painted, LOOP_ID);
    // observedRounds drives the unrolled round axis; roundBindings drives the CLICKABLE pills.
    expect(loop.data.observedRounds).toBe(2);
    expect(loop.data.roundBindings).toBeDefined();
    expect(loop.data.roundBindings!.map((r) => r.round)).toEqual([1, 2]);
    // The painted split is the SAME data buildOverlay produced — what selectRound→DetailPanel
    // then lists. (Reachability: round axis pill → loop node data → that round's instances.)
    expect(loop.data.roundBindings).toEqual(overlay.loopRounds![LOOP_ID]);
  });
});

// --- crafted minimal 2-round loop (signal-precise: `:rN` label suffix → round split) --------
// Isolated from the real corpus so the round-derivation path is asserted on a tiny shape.
function planNode(over: Partial<PlanModel['nodes'][number]> & { id: string }): PlanModel['nodes'][number] {
  return {
    kind: 'agent',
    title: 'a',
    labelTemplate: null,
    agentType: null,
    phaseRef: 1,
    multiplicity: { kind: 'one' },
    optional: false,
    loopRef: null,
    parentDecisionId: null,
    annotation: { subtitle: null, typed: false, source: 'static' },
    confidence: 'static',
    ...over,
  };
}
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
    durationMs: 1,
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

describe('loop-body drill — crafted 2-round fan (`:rN` suffix → per-round reachability)', () => {
  const LOOP_ID = 'loop-A';
  // A loop body plan node (loopRef → the loop container) with a fanned multiplicity. Its run
  // instances ran across TWO rounds (`:r1` / `:r2` label suffix — the signal observeRounds &
  // roundOf read), N per round.
  const plan: PlanModel = {
    workflowFile: 'x.js',
    workflowName: 'x',
    lanes: [{ index: 1, title: 'P1', detail: null, confidence: 'declared' }],
    nodes: [
      planNode({ id: LOOP_ID, kind: 'loop', phaseRef: 1 }),
      planNode({
        id: 'body',
        loopRef: LOOP_ID,
        multiplicity: { kind: 'fixed', n: 2 },
        labelTemplate: { literalPrefix: 'judge:', holes: ['k'], raw: 'judge:${k}' },
      }),
    ],
    edges: [{ id: 'e-back', from: 'body', to: LOOP_ID, kind: 'loop-back', label: 'until pass' }],
    containers: [],
    warnings: [],
    derivedFrom: 'static-source',
    coverageRatio: 1,
    format: 'cc-workflow/observed-2026-06-04',
  };
  const run: RunModel = {
    ref: { projectPath: '', slug: 's', sessionId: 'x', runId: 'wf_x' },
    workflowName: 'x',
    status: 'completed',
    incomplete: false,
    startTime: null,
    durationMs: null,
    defaultModel: null,
    summary: '',
    phases: [{ index: 1, title: 'P1', detail: null }],
    agents: [
      agentNode({ agentId: 'j1', label: 'judge:a:r1' }),
      agentNode({ agentId: 'j2', label: 'judge:b:r1' }),
      agentNode({ agentId: 'j3', label: 'judge:a:r2' }),
      agentNode({ agentId: 'j4', label: 'judge:b:r2', state: 'interrupted' }),
    ],
    edges: [],
    logs: [],
    partialFailure: { present: false, lines: [] },
    error: null,
    args: null,
    warnings: [],
    format: 'cc-workflow/observed-2026-06-04',
  };
  const overlay: Overlay = buildOverlay(plan, run);

  it('splits the 2-round fan into r1/r2 buckets keyed by the loop container id', () => {
    const rbs = overlay.loopRounds?.[LOOP_ID];
    expect(rbs).toBeDefined();
    expect(rbs!.map((r) => r.round)).toEqual([1, 2]);
    expect(rbs!.find((r) => r.round === 1)!.agentIds.sort()).toEqual(['j1', 'j2']);
    expect(rbs!.find((r) => r.round === 2)!.agentIds.sort()).toEqual(['j3', 'j4']);
  });

  it('all 4 instances are reachable across the two rounds (none stranded)', () => {
    const reachable = new Set(overlay.loopRounds![LOOP_ID]!.flatMap((rb) => rb.agentIds));
    expect(reachable).toEqual(new Set(['j1', 'j2', 'j3', 'j4']));
  });

  it('the painted planLoop node carries the round axis pills (round → instances)', () => {
    const painted = paintOverlay(loopGraph(LOOP_ID), overlay, true, false);
    const loop = paintedLoop(painted, LOOP_ID);
    expect(loop.data.observedRounds).toBe(2);
    expect(loop.data.roundBindings).toEqual(overlay.loopRounds![LOOP_ID]);
    // The picked-round scope (what `selectRound(LOOP_ID, 2)` → DetailPanel lists) is non-empty
    // and labelled, i.e. a round pill drill surfaces real, identifiable instances.
    const r2 = loop.data.roundBindings!.find((r) => r.round === 2)!;
    expect(r2.instances.map((i) => i.label).sort()).toEqual(['judge:a:r2', 'judge:b:r2']);
  });

  it('a loop-body fan is NOT lane-drawn — expandInstances leaves the loop graph untouched', () => {
    // The drill is the round axis, NOT a lane drawer inside the loop. Even if the loop body id
    // is (wrongly) handed to expandInstances, it must emit no drawer/cards and return the graph
    // by reference (loop bodies are parented to the loop container, never a phaseLane).
    const graph = loopGraph(LOOP_ID);
    const same = expandInstances(graph, overlay, run, new Set(['body', LOOP_ID]), false);
    expect(same).toBe(graph); // identity preserved — no lane-drawer side effect
    expect(same.nodes.some((n) => n.type === 'instanceGroup')).toBe(false);
    expect(same.nodes.some((n) => n.type === 'agentCard' || n.type === 'agentChip')).toBe(false);
  });
});
