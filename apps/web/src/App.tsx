import { useMemo, useState } from 'react';
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
import type { ProjectRef, RunSummary, WorkflowMeta } from '@argus/contract';
import {
  fetchProjects,
  fetchProjectRuns,
  fetchProjectWorkflows,
  fetchRunModel,
} from './api.ts';
import { runModelToGraph } from './mapping.ts';
import { planMetaToGraph } from './plan-mapping.ts';
import { AgentCardNode } from './nodes/AgentCard.tsx';
import { PhaseLaneNode } from './nodes/PhaseLane.tsx';

// Stable identity (a fresh object each render would make React Flow warn + re-mount).
const nodeTypes: NodeTypes = { phaseLane: PhaseLaneNode, agentCard: AgentCardNode };

type ViewMode = 'execution' | 'plan';

/** Dogfood: prefer the modal-rust project; otherwise the first discovered project. */
function pickProject(projects: ProjectRef[] | undefined): ProjectRef | undefined {
  if (!projects || projects.length === 0) return undefined;
  return projects.find((p) => p.projectPath.includes('modal-rust')) ?? projects[0];
}

/** Execution mode auto-selects the richest run (the 14-agent plan-research run). */
function pickRun(runs: RunSummary[] | undefined): RunSummary | undefined {
  if (!runs || runs.length === 0) return undefined;
  return [...runs].sort((a, b) => b.agentCount - a.agentCount)[0];
}

/** Plan mode auto-selects plan-research; otherwise the first declared workflow. */
function pickWorkflow(workflows: WorkflowMeta[] | undefined): WorkflowMeta | undefined {
  if (!workflows || workflows.length === 0) return undefined;
  return workflows.find((w) => w.name.includes('plan-research')) ?? workflows[0];
}

export function App() {
  const [view, setView] = useState<ViewMode>('execution');

  const projectsQ = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });
  const project = pickProject(projectsQ.data);

  // --- Execution (M3) path — unchanged: list runs, auto-select the 14-agent run. ---
  const runsQ = useQuery({
    queryKey: ['runs', project?.slug],
    queryFn: () => fetchProjectRuns(project!.slug),
    enabled: !!project,
  });
  const summary = pickRun(runsQ.data);

  const runQ = useQuery({
    queryKey: ['run', summary?.ref.slug, summary?.ref.sessionId, summary?.ref.runId],
    queryFn: () => fetchRunModel(summary!.ref),
    enabled: !!summary && view === 'execution',
  });

  // --- Plan (P0) path — run-free: list declared workflows, auto-select plan-research. ---
  const workflowsQ = useQuery({
    queryKey: ['workflows', project?.slug],
    queryFn: () => fetchProjectWorkflows(project!.slug),
    enabled: !!project && view === 'plan',
  });
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null);
  const workflows = workflowsQ.data ?? [];
  const workflow =
    workflows.find((w) => w.name === selectedWorkflow) ?? pickWorkflow(workflowsQ.data);

  const run = runQ.data;
  const graph = useMemo(() => {
    if (view === 'plan') {
      return workflow ? planMetaToGraph(workflow) : { nodes: [], edges: [] };
    }
    return run ? runModelToGraph(run) : { nodes: [], edges: [] };
  }, [view, run, workflow]);

  const error =
    projectsQ.error ?? runsQ.error ?? runQ.error ?? workflowsQ.error;
  const loading =
    projectsQ.isPending ||
    (!!project && view === 'execution' && runsQ.isPending) ||
    (!!summary && view === 'execution' && runQ.isPending) ||
    (!!project && view === 'plan' && workflowsQ.isPending);

  const hasContent = view === 'plan' ? !!workflow : !!run;

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

      {/* Minimal Plan ⟷ Execution view toggle (this view IS review-the-workflow mode). */}
      <div className="view-toggle" role="group" aria-label="view mode">
        <button
          type="button"
          className={`view-toggle-btn${view === 'plan' ? ' is-active' : ''}`}
          aria-pressed={view === 'plan'}
          onClick={() => setView('plan')}
        >
          Plan
        </button>
        <button
          type="button"
          className={`view-toggle-btn${view === 'execution' ? ' is-active' : ''}`}
          aria-pressed={view === 'execution'}
          onClick={() => setView('execution')}
        >
          Execution
        </button>
      </div>

      {view === 'plan' && workflow ? (
        <div className="run-header">
          {workflows.length > 1 ? (
            <select
              className="wf-picker"
              value={workflow.name}
              onChange={(e) => setSelectedWorkflow(e.target.value)}
              aria-label="workflow"
            >
              {workflows.map((w) => (
                <option key={w.name} value={w.name}>
                  {w.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="run-header-name">{workflow.name}</span>
          )}
          <span className="run-badge run-badge-plan">plan</span>
          <span className="run-header-meta">
            {workflow.phases.length} {workflow.phases.length === 1 ? 'phase' : 'phases'} · declared
          </span>
        </div>
      ) : view === 'execution' && run ? (
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
      ) : null}

      {!hasContent ? (
        <div className="argus-empty" role="status">
          <div className="argus-wordmark">argus</div>
          <div className="argus-tagline">Claude Code workflow visualizer</div>
          <div className="argus-hint">
            {error
              ? 'could not reach the local server — start it with `npm run dev:server`'
              : loading
                ? 'loading…'
                : view === 'plan'
                  ? 'no declared workflows found for this project'
                  : 'no runs found in ~/.claude'}
          </div>
        </div>
      ) : null}
    </div>
  );
}
