// @argus/web — map a normalized RunModel onto @xyflow/react nodes + edges, behind
// the swappable layout seam (boundaries.md §6). Pure function of (RunModel, engine);
// no I/O, no React. Emits:
//   - one PhaseLane group node per phase (top→down by 1-based index)
//   - one AgentCard child node per agent (parented to its lane, grid-wrapped)
//   - ONLY the synthesized phase_i→phase_i+1 spine edges (no agent edges)

import type { Edge, Node } from '@xyflow/react';
import type { RunModel } from '@argus/contract';
import type { AgentCardData } from './nodes/AgentCard.tsx';
import type { PhaseLaneData } from './nodes/PhaseLane.tsx';
import { defaultLayout, type LayoutEngine, type LayoutInput } from './layout/index.ts';

export interface GraphResult {
  nodes: Node[];
  edges: Edge[];
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
    const data: AgentCardData = {
      label: agent.label || agent.agentId || 'agent',
      state: agent.state,
      model: agent.model,
      cached: agent.cached,
      failedInLogs: agent.failedInLogs,
      tokens: agent.tokens,
      toolCalls: agent.toolCalls,
      durationMs: agent.durationMs,
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
