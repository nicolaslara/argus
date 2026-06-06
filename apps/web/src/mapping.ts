// @argus/web — map a normalized RunModel onto @xyflow/react nodes + edges, behind
// the swappable layout seam (boundaries.md §6). Pure function of (RunModel, engine);
// no I/O, no React. Emits:
//   - one PhaseLane group node per phase (top→down by 1-based index)
//   - one AgentCard child node per agent (parented to its lane, grid-wrapped)
//   - ONLY the synthesized phase_i→phase_i+1 spine edges (no agent edges)

import type { Edge, Node } from '@xyflow/react';
import type { AgentNode, RunModel } from '@argus/contract';
import type { AgentCardData } from './nodes/AgentCard.tsx';
import type { PhaseLaneData } from './nodes/PhaseLane.tsx';
import type { LiveFill } from './live-agent-fill.ts';
import { defaultLayout, type LayoutEngine, type LayoutInput } from './layout/index.ts';

export interface GraphResult {
  nodes: Node[];
  edges: Edge[];
}

/**
 * STEP 2 fill rule: keep the journal value when it is present AND non-zero; otherwise fall
 * back to the transcript-derived live value (which may itself be undefined → null). This is
 * what makes a finished run byte-unchanged: its journal metric is non-null/non-zero, so the
 * journal always wins and `filled` is ignored. A live agent showing an em-dash (null/0) picks
 * up the transcript number. Returns `number | null` to match AgentCardData's metric fields.
 */
function fillMetric(journal: number | null, filled: number | undefined): number | null {
  if (journal != null && journal !== 0) return journal;
  return filled != null ? filled : journal;
}

/**
 * The per-agent → AgentCardData shape, shared by the plan-less fallback engine
 * (`runModelToGraph`) and the Run-view drawer expand (`overlay-expand.ts`). Pure; carries
 * every AgentNode scalar through so the DetailPanel reads them with no extra fetch (the
 * card render ignores the I1 trailing fields). Extracted verbatim from the inline build —
 * no behavior change.
 */
export function agentToCardData(
  agent: AgentNode,
  failurePoint = false,
  // STEP 2 (live fill): transcript-derived metrics for a RUNNING run's still-incomplete /
  // metric-starved agents (failure-and-live-inspector §4). When present AND the journal value
  // is missing/zero, the filled value wins so the card shows real dur/tok/tools/label instead
  // of em-dashes. Absent for finished runs (the hook returns an empty map) — so a finished
  // run's cards keep their finalized-model values and stay byte-unchanged.
  liveFill?: LiveFill,
): AgentCardData {
  return {
    // The journal label wins when it's a real label; otherwise fall back to the transcript-
    // derived label (the first-user-line task) before the bare agentId.
    label: agent.label || liveFill?.label || agent.agentId || 'agent',
    state: agent.state,
    model: agent.model,
    cached: agent.cached,
    failedInLogs: agent.failedInLogs,
    // STEP 3: the dead agent on a failed run → a red failure-point ring (consistent with the
    // Run-view banner). Off by default; set only for the failure-point instances.
    failurePoint,
    // STEP 2: the journal value wins when present/non-zero; otherwise the live transcript fill.
    tokens: fillMetric(agent.tokens, liveFill?.tokens),
    toolCalls: fillMetric(agent.toolCalls, liveFill?.toolCount),
    durationMs: fillMetric(agent.durationMs, liveFill?.durationMs),
    // I1: the remaining AgentNode scalars ride along on node.data so the detail panel
    // reads them with no extra fetch (the card render ignores them). Already-capped
    // previews come straight from the adapter; nothing new is computed here.
    agentType: agent.agentType,
    attempt: agent.attempt,
    queuedAt: agent.queuedAt,
    startedAt: agent.startedAt,
    lastProgressAt: agent.lastProgressAt,
    lastToolName: agent.lastToolName,
    lastToolSummary: agent.lastToolSummary,
    promptPreview: agent.promptPreview,
    resultPreview: agent.resultPreview,
    // PX: the explanation-overlay join key (the AgentNode.agentId == the engine's id).
    agentId: agent.agentId,
  };
}

export function runModelToGraph(model: RunModel, engine: LayoutEngine = defaultLayout): GraphResult {
  // Group agents by 1-based phaseIndex, preserving the adapter's order (already sorted
  // by phaseIndex then index). Only phases that actually exist in model.phases form lanes.
  const phaseIndices = model.phases.map((p) => p.index);
  const phaseSet = new Set(phaseIndices);
  const agentIdsByPhase = new Map<number, string[]>();
  for (const idx of phaseIndices) agentIdsByPhase.set(idx, []);
  for (const agent of model.agents) {
    if (!phaseSet.has(agent.phaseIndex)) continue; // adapter drops unresolved; belt-and-suspenders
    agentIdsByPhase.get(agent.phaseIndex)!.push(agent.agentId);
  }

  const layoutInput: LayoutInput = {
    phases: model.phases.map((p) => ({
      index: p.index,
      title: p.title,
      agentIds: agentIdsByPhase.get(p.index) ?? [],
    })),
  };
  const placed = engine.layout(layoutInput);

  const nodes: Node[] = [];

  // Phase lane group nodes.
  for (const phase of model.phases) {
    const lane = placed.lanes.get(phase.index);
    if (!lane) continue;
    const laneData: PhaseLaneData = {
      index: phase.index,
      title: phase.title,
      agentCount: (agentIdsByPhase.get(phase.index) ?? []).length,
    };
    nodes.push({
      id: laneNodeId(phase.index),
      type: 'phaseLane',
      position: { x: lane.x, y: lane.y },
      data: laneData,
      draggable: false,
      selectable: false,
      // group node sizing (xyflow reads width/height from style for group nodes).
      style: { width: lane.width, height: lane.height },
    });
  }

  // Agent card child nodes (parented to their lane; positions are lane-relative).
  for (const agent of model.agents) {
    if (!phaseSet.has(agent.phaseIndex)) continue;
    const pos = placed.agents.get(agent.agentId);
    if (!pos) continue;
    const data: AgentCardData = agentToCardData(agent);
    nodes.push({
      id: agentNodeId(agent.agentId, agent.index),
      type: 'agentCard',
      parentId: laneNodeId(agent.phaseIndex),
      extent: 'parent',
      position: { x: pos.x, y: pos.y },
      data,
      draggable: false,
    });
  }

  // Edges: ONLY the synthesized phase_i→phase_i+1 spine (boundaries.md §6).
  const edges: Edge[] = model.edges.map((e) => ({
    id: `spine-${e.from}-${e.to}`,
    source: laneNodeId(e.from),
    target: laneNodeId(e.to),
    type: 'smoothstep',
    animated: false,
    style: { stroke: '#30363d', strokeWidth: 2 },
  }));

  return { nodes, edges };
}

function laneNodeId(phaseIndex: number): string {
  return `phase-${phaseIndex}`;
}

function agentNodeId(agentId: string, index: number): string {
  // agentId may be empty on torn data; the index disambiguates within a phase.
  return `agent-${agentId || 'x'}-${index}`;
}
