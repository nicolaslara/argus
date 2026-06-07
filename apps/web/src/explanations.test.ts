import { describe, it, expect } from 'vitest';
import type { Node, Edge } from '@xyflow/react';
import type { NodeExplanation } from '@argus/contract';
import { overlayExplanations, type ExplanationMap } from './explanations.ts';
import type { GraphResult } from './mapping.ts';

// overlayExplanations is the PURE LLM-caption → graph-node join. It joins on data.agentId
// (execution AgentCards) when that is a string, otherwise on node.id (plan nodes), and patches
// ONLY the text-carrying fields (subtitle/caption + captionSource/captionPattern). Topology
// (ids, types, positions, parents, edges) is left UNTOUCHED, and when nothing matches the
// ORIGINAL graph reference is returned so React Flow does not see a new identity.

function explanation(over: Partial<NodeExplanation> & Pick<NodeExplanation, 'id' | 'caption'>): NodeExplanation {
  return { status: 'ready', source: 'llm', ...over };
}

function mapOf(...es: NodeExplanation[]): ExplanationMap {
  return new Map(es.map((e) => [e.id, e]));
}

// A plan node (joins on node.id) and an execution AgentCard (joins on data.agentId).
function makeGraph(): GraphResult {
  const planNode: Node = {
    id: 'plan-1',
    type: 'planNode',
    position: { x: 10, y: 20 },
    parentId: 'lane-a',
    data: { subtitle: 'baseline plan subtitle', label: 'Plan One' },
  };
  const agentCard: Node = {
    id: 'agent-research-0',
    type: 'agentCard',
    position: { x: 30, y: 40 },
    parentId: 'lane-b',
    data: { agentId: 'research', caption: 'baseline caption' },
  };
  const edges: Edge[] = [{ id: 'phase_1->phase_2', source: 'phase_1', target: 'phase_2' }];
  return { nodes: [planNode, agentCard], edges };
}

describe('overlayExplanations', () => {
  it('returns the ORIGINAL graph reference (identity) for an empty explanations map', () => {
    const graph = makeGraph();
    const out = overlayExplanations(graph, new Map());
    expect(out).toBe(graph);
    expect(out.nodes).toBe(graph.nodes);
    expect(out.edges).toBe(graph.edges);
  });

  it('returns the ORIGINAL graph reference when no id matches (no mutation, no new array)', () => {
    const graph = makeGraph();
    const before = structuredClone(graph.nodes.map((n) => n.data));
    const out = overlayExplanations(graph, mapOf(explanation({ id: 'nobody', caption: 'x' })));
    expect(out).toBe(graph);
    expect(out.nodes).toBe(graph.nodes);
    // original node data is untouched
    expect(graph.nodes.map((n) => n.data)).toEqual(before);
  });

  it('patches an AGENT card matched by data.agentId with caption + captionSource + pattern', () => {
    const graph = makeGraph();
    const out = overlayExplanations(
      graph,
      mapOf(explanation({ id: 'research', caption: 'enriched agent caption', pattern: 'fan-out verifier' })),
    );
    expect(out).not.toBe(graph);
    const agent = out.nodes.find((n) => n.id === 'agent-research-0')!;
    expect(agent.data.caption).toBe('enriched agent caption');
    // the function writes subtitle too (it patches both text slots unconditionally)
    expect(agent.data.subtitle).toBe('enriched agent caption');
    expect(agent.data.captionSource).toBe('llm');
    expect(agent.data.captionPattern).toBe('fan-out verifier');
  });

  it('patches a PLAN node matched by node.id (subtitle slot), defaulting pattern to null', () => {
    const graph = makeGraph();
    const out = overlayExplanations(graph, mapOf(explanation({ id: 'plan-1', caption: 'enriched plan subtitle' })));
    const plan = out.nodes.find((n) => n.id === 'plan-1')!;
    expect(plan.data.subtitle).toBe('enriched plan subtitle');
    expect(plan.data.caption).toBe('enriched plan subtitle');
    expect(plan.data.captionSource).toBe('llm');
    // pattern omitted on the explanation → null (not undefined)
    expect(plan.data.captionPattern).toBeNull();
  });

  it('preserves topology exactly (id, type, position, parentId, edges) and only swaps a new node identity for matched nodes', () => {
    const graph = makeGraph();
    const originalAgent = graph.nodes[1]!;
    const out = overlayExplanations(graph, mapOf(explanation({ id: 'research', caption: 'c' })));

    const agent = out.nodes.find((n) => n.id === 'agent-research-0')!;
    expect(agent.id).toBe('agent-research-0');
    expect(agent.type).toBe('agentCard');
    expect(agent.position).toEqual({ x: 30, y: 40 });
    expect(agent.parentId).toBe('lane-b');
    expect(agent.data.agentId).toBe('research'); // join key carried through untouched
    // a matched node is a NEW object (immutability), the original is not mutated
    expect(agent).not.toBe(originalAgent);
    expect(originalAgent.data.caption).toBe('baseline caption');

    // edges array is carried through by reference (topology untouched)
    expect(out.edges).toBe(graph.edges);
  });

  it('leaves NON-matching nodes as the SAME object reference (only matched nodes are rebuilt)', () => {
    const graph = makeGraph();
    const originalPlan = graph.nodes[0];
    // only the agent matches; the plan node must be passed through unchanged
    const out = overlayExplanations(graph, mapOf(explanation({ id: 'research', caption: 'c' })));
    const plan = out.nodes.find((n) => n.id === 'plan-1')!;
    expect(plan).toBe(originalPlan);
    expect(plan.data.subtitle).toBe('baseline plan subtitle');
    expect(plan.data.captionSource).toBeUndefined();
  });

  it('patches multiple matching nodes in one pass', () => {
    const graph = makeGraph();
    const out = overlayExplanations(
      graph,
      mapOf(
        explanation({ id: 'plan-1', caption: 'plan cap' }),
        explanation({ id: 'research', caption: 'agent cap' }),
      ),
    );
    expect(out).not.toBe(graph);
    expect(out.nodes.find((n) => n.id === 'plan-1')!.data.subtitle).toBe('plan cap');
    expect(out.nodes.find((n) => n.id === 'agent-research-0')!.data.caption).toBe('agent cap');
  });
});
