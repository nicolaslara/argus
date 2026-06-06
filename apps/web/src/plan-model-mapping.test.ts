import { describe, it, expect } from 'vitest';
import type {
  DecisionNode,
  LoopNode,
  PlanEdge,
  PlanLane,
  PlanModel,
  PlanNode,
} from '@argus/contract';
import { planModelToGraph } from './plan-model-mapping.ts';
import type { ElkPlanLayout, PlanLayoutInput, PlanPlacement } from './layout/index.ts';

// UIBUG-3 regression guard — the FIRST test to drive the REAL planModelToGraph.
//
// The PLAN view's loop is a VERTICAL body stack inside a loop container. React Flow draws
// every edge from the source's default right handle to the target's default left handle, so:
//   (A) the loop-container → first-body-child 'flow' edge swept a SOLID line straight across
//       the body (the user-flagged bug). parentId containment already signals entry, so this
//       edge is now dropped entirely.
//   (B) the dashed 'loop-back' (last-body → loop) ran straight across too. It now docks at the
//       loop's BOTTOM handle (targetHandle 'loop-bottom') and bows around the body.
// Both fixes live in the edge build of planModelToGraph; this file asserts them on its output.

// A minimal PlanNode with sane defaults; `over` supplies the kind-specific bits.
function node(over: Partial<PlanNode> & { id: string; kind: PlanNode['kind'] }): PlanNode {
  return {
    title: over.id,
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

const LANE: PlanLane = { index: 1, title: 'Refine', detail: null, confidence: 'declared' };

/**
 * Build a PlanModel with a loop whose vertical body is [first, ...mid, last], plus a post-loop
 * output sibling. Mirrors plan.ts walkLoop(): an entry 'flow' edge loop→first-body, intra-body
 * 'flow' edges, a 'loop-back' last→loop, and a 'flow' continuation loop→output.
 */
function makeLoopPlan(body: PlanNode[]): PlanModel {
  const loop: LoopNode = {
    ...(node({ id: 'loop-1', kind: 'loop', title: 'while' }) as LoopNode),
    stopCondition: 'until done · max 3',
    maxRounds: 3,
  };
  const output = node({ id: 'spec', kind: 'output', title: 'spec' });
  const bodyInLoop = body.map((b) => ({ ...b, loopRef: 'loop-1' }));
  const first = bodyInLoop[0]!;
  const last = bodyInLoop[bodyInLoop.length - 1]!;

  const edges: PlanEdge[] = [
    // entry: loop container → first body child (THE bug edge — must be dropped).
    { id: 'e-flow-entry', from: 'loop-1', to: first.id, kind: 'flow' },
    // intra-body flow.
    ...bodyInLoop.slice(1).map((b, i) => ({
      id: `e-flow-body-${i}`,
      from: bodyInLoop[i]!.id,
      to: b.id,
      kind: 'flow' as const,
    })),
    // back-edge: last body node → loop container.
    { id: 'e-loopback-14', from: last.id, to: 'loop-1', kind: 'loop-back', label: 'until condition' },
    // continuation: loop container → post-loop output (must be KEPT — proves filter precision).
    { id: 'e-flow-cont', from: 'loop-1', to: 'spec', kind: 'flow' },
  ];

  return {
    workflowFile: 'wf.js',
    workflowName: 'wf',
    lanes: [LANE],
    nodes: [loop, ...bodyInLoop, output],
    edges,
    containers: [],
    warnings: [],
    derivedFrom: 'static-source',
    coverageRatio: 1,
    format: 'test',
  };
}

/** A fake elk: place every input node on a vertical stack so the body reads as a column. */
function fakeElk(): ElkPlanLayout {
  return async (input: PlanLayoutInput) => {
    const placements = new Map<string, PlanPlacement>();
    let y = 0;
    for (const n of input.nodes) {
      placements.set(n.id, { x: 100, y, width: n.width, height: n.height });
      y += n.height + 40;
    }
    return { placements };
  };
}

describe('planModelToGraph — UIBUG-3 loop edge routing', () => {
  it('drops the loop-container → first-body-child entry edge (no solid line across the body)', async () => {
    const critique = node({ id: 'critique', kind: 'agent' });
    const decision = node({ id: 'cond', kind: 'decision' }) as DecisionNode;
    decision.conditionKind = 'expr';
    decision.conditionLabel = 'sound?';
    const revise = node({ id: 'revise', kind: 'agent' });
    const { edges } = await planModelToGraph(makeLoopPlan([critique, decision, revise]), fakeElk());

    // GENERAL invariant: no rendered edge runs from a loop CONTAINER to one of its OWN children.
    const loopChildren = new Set(['critique', 'cond', 'revise']);
    const crossBody = edges.find((e) => e.source === 'loop-1' && loopChildren.has(e.target as string));
    expect(crossBody, 'a loop→own-child edge (the cross-body line)').toBeUndefined();

    // The specific entry edge is gone…
    expect(edges.find((e) => e.id === 'e-flow-entry')).toBeUndefined();
    // …but the post-loop continuation (loop→output) is KEPT — the filter is precise.
    const cont = edges.find((e) => e.id === 'e-flow-cont');
    expect(cont, 'the loop→output continuation').toBeDefined();
    expect(cont!.source).toBe('loop-1');
    expect(cont!.target).toBe('spec');
  });

  it('docks the loop-back at the loop bottom handle (body ends in an agent)', async () => {
    const critique = node({ id: 'critique', kind: 'agent' });
    const decision = node({ id: 'cond', kind: 'decision' }) as DecisionNode;
    decision.conditionKind = 'expr';
    decision.conditionLabel = 'sound?';
    const revise = node({ id: 'revise', kind: 'agent' });
    // body ends in the agent `revise` (this bug's exact shape).
    const { edges } = await planModelToGraph(makeLoopPlan([critique, decision, revise]), fakeElk());

    const back = edges.find((e) => e.id === 'e-loopback-14');
    expect(back, 'the loop-back edge').toBeDefined();
    // Still VISIBLE: smoothstep + dashed + arrowed + labeled (the cycle reads as closing).
    expect(back!.type).toBe('smoothstep');
    expect(back!.label).toBe('until condition');
    // Routed to the loop's bottom handle, bowed around the body.
    expect(back!.targetHandle).toBe('loop-bottom');
    expect((back as { pathOptions?: { offset?: number } }).pathOptions?.offset).toBe(24);
    // Non-decision source keeps its default right handle (no override).
    expect(back!.sourceHandle).toBeUndefined();
  });

  it('docks the loop-back at the loop bottom handle (body ends in a decision)', async () => {
    // argus-refine-plan shape: the body ENDS in a decision diamond.
    const critique = node({ id: 'critique', kind: 'agent' });
    const decision = node({ id: 'cond', kind: 'decision' }) as DecisionNode;
    decision.conditionKind = 'expr';
    decision.conditionLabel = 'sound?';
    const { edges } = await planModelToGraph(makeLoopPlan([critique, decision]), fakeElk());

    const back = edges.find((e) => e.id === 'e-loopback-14');
    expect(back, 'the loop-back edge').toBeDefined();
    expect(back!.type).toBe('smoothstep');
    expect(back!.targetHandle).toBe('loop-bottom');
    // Decision source leaves its BOTTOM (`false`) vertex and bows wider (mirrors the overlay).
    expect(back!.sourceHandle).toBe('false');
    expect((back as { pathOptions?: { offset?: number } }).pathOptions?.offset).toBe(34);
  });

  it('does not add loop-back handles to non-loop edges (decisions outside loops unaffected)', async () => {
    // A decision OUTSIDE any loop with true/false optional branches.
    const dec = node({ id: 'gate', kind: 'decision' }) as DecisionNode;
    dec.conditionKind = 'expr';
    dec.conditionLabel = 'ok?';
    const yes = node({ id: 'yes', kind: 'agent' });
    const no = node({ id: 'no', kind: 'agent' });
    const plan: PlanModel = {
      workflowFile: 'wf.js',
      workflowName: 'wf',
      lanes: [LANE],
      nodes: [dec, yes, no],
      edges: [
        { id: 'e-opt-t', from: 'gate', to: 'yes', kind: 'optional', label: 'true' },
        { id: 'e-opt-f', from: 'gate', to: 'no', kind: 'optional', label: 'false' },
      ],
      containers: [],
      warnings: [],
      derivedFrom: 'static-source',
      coverageRatio: 1,
      format: 'test',
    };
    const { edges } = await planModelToGraph(plan, fakeElk());

    const t = edges.find((e) => e.id === 'e-opt-t');
    const f = edges.find((e) => e.id === 'e-opt-f');
    // optional branches keep their decision sourceHandle and gain NO loop-back targetHandle.
    expect(t!.sourceHandle).toBe('true');
    expect(f!.sourceHandle).toBe('false');
    expect(t!.targetHandle).toBeUndefined();
    expect(f!.targetHandle).toBeUndefined();
    expect((t as { pathOptions?: unknown }).pathOptions).toBeUndefined();
  });
});
