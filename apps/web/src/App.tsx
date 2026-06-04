import { useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useQuery } from '@tanstack/react-query';
import type { ProjectRef, RunSummary } from '@argus/contract';
import { fetchProjects, fetchProjectRuns, fetchRunModel } from './api.ts';
import { runModelToGraph } from './mapping.ts';
import { AgentCardNode } from './nodes/AgentCard.tsx';
import { PhaseLaneNode } from './nodes/PhaseLane.tsx';

// Stable identity (a fresh object each render would make React Flow warn + re-mount).
const nodeTypes: NodeTypes = { phaseLane: PhaseLaneNode, agentCard: AgentCardNode };

/** Dogfood: prefer the modal-rust project; otherwise the first discovered project. */
function pickProject(projects: ProjectRef[] | undefined): ProjectRef | undefined {
  if (!projects || projects.length === 0) return undefined;
  return projects.find((p) => p.projectPath.includes('modal-rust')) ?? projects[0];
}

/** M3 auto-selects the richest run (the 14-agent plan-research) for the first render. */
function pickRun(runs: RunSummary[] | undefined): RunSummary | undefined {
  if (!runs || runs.length === 0) return undefined;
  return [...runs].sort((a, b) => b.agentCount - a.agentCount)[0];
}

export function App() {
  const projectsQ = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });
  const project = pickProject(projectsQ.data);

  const runsQ = useQuery({
    queryKey: ['runs', project?.slug],
    queryFn: () => fetchProjectRuns(project!.slug),
    enabled: !!project,
  });
  const summary = pickRun(runsQ.data);

  const runQ = useQuery({
    queryKey: ['run', summary?.ref.slug, summary?.ref.sessionId, summary?.ref.runId],
    queryFn: () => fetchRunModel(summary!.ref),
    enabled: !!summary,
  });

  const graph = useMemo(
    () => (runQ.data ? runModelToGraph(runQ.data) : { nodes: [], edges: [] }),
    [runQ.data],
  );

  const run = runQ.data;
  const error = projectsQ.error ?? runsQ.error ?? runQ.error;
  const loading = projectsQ.isPending || (!!project && runsQ.isPending) || (!!summary && runQ.isPending);

  return (
    <div className="argus-app">
      <ReactFlow
        nodes={graph.nodes}
        edges={graph.edges}
        nodeTypes={nodeTypes}
        colorMode="dark"
        fitView
        fitViewOptions={{ padding: 0.18 }}
        minZoom={0.1}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
        <MiniMap pannable zoomable />
        <Controls showInteractive={false} />
      </ReactFlow>

      {run ? (
        <div className="run-header">
          <span className="run-header-name">{run.workflowName}</span>
          <span className={`run-badge run-badge-${run.status}`}>{run.status}</span>
          <span className="run-header-meta">
            {run.agents.length} {run.agents.length === 1 ? 'agent' : 'agents'} · {run.phases.length}{' '}
            {run.phases.length === 1 ? 'phase' : 'phases'}
          </span>
          {run.partialFailure.present ? (
            <span className="run-badge run-badge-partial" title={run.partialFailure.lines[0] ?? ''}>
              partial failure
            </span>
          ) : null}
        </div>
      ) : (
        <div className="argus-empty" role="status">
          <div className="argus-wordmark">argus</div>
          <div className="argus-tagline">Claude Code workflow visualizer</div>
          <div className="argus-hint">
            {error
              ? 'could not reach the local server — start it with `npm run dev:server`'
              : loading
                ? 'loading…'
                : 'no runs found in ~/.claude'}
          </div>
        </div>
      )}
    </div>
  );
}
