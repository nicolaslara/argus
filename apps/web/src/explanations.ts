// @argus/web — PX client glue. A TanStack Query poll for per-node LLM captions and a
// PURE overlay that swaps the enriched caption into the existing node subtitle slots.
//
// ANNOTATION-ONLY: the overlay touches ONLY the `subtitle`/`caption` text on node.data;
// it never adds, removes, or reorders nodes/edges. The deterministic graph (from
// mapping/plan-mapping/plan-model-mapping) is the topology source of truth; this layer
// only enriches text. Captions render as text nodes only (no dangerouslySetInnerHTML).

import { useQuery } from '@tanstack/react-query';
import type { Node } from '@xyflow/react';
import type { ExplanationBatch, NodeExplanation } from '@argus/contract';
import { fetchPlanExplanations, fetchRunExplanations } from './api.ts';
import type { GraphResult } from './mapping.ts';

/** Map of nodeId -> the explanation (only 'ready'/'llm' entries are kept for overlay). */
export type ExplanationMap = Map<string, NodeExplanation>;

const POLL_INTERVAL_MS = 1500;

function toMap(batch: ExplanationBatch | undefined): ExplanationMap {
  const m: ExplanationMap = new Map();
  if (!batch) return m;
  for (const e of batch.explanations) {
    if (e.status === 'ready' && e.source === 'llm') m.set(e.id, e);
  }
  return m;
}

/**
 * Poll a plan's explanations. Re-fetches every POLL_INTERVAL_MS while the engine reports
 * `pending`; stops polling once everything is ready/error (refetchInterval → false).
 */
export function usePlanExplanations(
  slug: string | undefined,
  file: string | undefined,
  enabled: boolean,
): ExplanationMap {
  const q = useQuery({
    queryKey: ['plan-explanations', slug, file],
    queryFn: () => fetchPlanExplanations(slug!, file!),
    enabled: enabled && !!slug && !!file,
    refetchInterval: (query) => (query.state.data?.pending ? POLL_INTERVAL_MS : false),
  });
  return toMap(q.data);
}

/** Poll a run's explanations (same posture as the plan poll). */
export function useRunExplanations(
  ref: { slug: string; sessionId: string; runId: string } | undefined,
  enabled: boolean,
): ExplanationMap {
  const q = useQuery({
    queryKey: ['run-explanations', ref?.slug, ref?.sessionId, ref?.runId],
    queryFn: () => fetchRunExplanations(ref!),
    enabled: enabled && !!ref,
    refetchInterval: (query) => (query.state.data?.pending ? POLL_INTERVAL_MS : false),
  });
  return toMap(q.data);
}

/**
 * Overlay enriched captions onto a graph. PURE: returns a NEW node array with the
 * `subtitle` (plan nodes) / `caption` (agent cards) text patched for any node whose id
 * has a ready LLM explanation. Topology (ids, types, positions, edges, parents) is
 * UNTOUCHED. If there is nothing to enrich, the original `graph` reference is returned
 * (so React Flow does not see a new identity needlessly).
 */
export function overlayExplanations(graph: GraphResult, explanations: ExplanationMap): GraphResult {
  if (explanations.size === 0) return graph;
  let changed = false;
  const nodes: Node[] = graph.nodes.map((n) => {
    // Match on the engine's id: plan nodes use node.id (== PlanNode.id); execution
    // AgentCards carry data.agentId (the node.id is `agent-<id>-<index>`).
    const joinId =
      typeof (n.data as { agentId?: unknown }).agentId === 'string'
        ? (n.data as { agentId: string }).agentId
        : n.id;
    const e = explanations.get(joinId);
    if (!e) return n;
    changed = true;
    // Patch ONLY the text-carrying field; everything else (type/position/parent) is kept.
    return {
      ...n,
      data: {
        ...n.data,
        subtitle: e.caption, // plan agent/process subtitle slot
        caption: e.caption, // execution AgentCard caption slot
        captionSource: 'llm',
        captionPattern: e.pattern ?? null,
      },
    };
  });
  return changed ? { nodes, edges: graph.edges } : graph;
}
