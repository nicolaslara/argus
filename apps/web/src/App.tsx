import { useEffect, useMemo, useState } from 'react';
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
import type { PlanModel, ProjectRef, RunSummary, WorkflowMeta } from '@argus/contract';
import {
  fetchProjects,
  fetchProjectRuns,
  fetchProjectWorkflows,
  fetchProjectPlan,
  fetchRunModel,
} from './api.ts';
import { runModelToGraph, type GraphResult } from './mapping.ts';
import { planMetaToGraph } from './plan-mapping.ts';
import { planModelToGraph } from './plan-model-mapping.ts';
import {
  overlayExplanations,
  usePlanExplanations,
  useRunExplanations,
} from './explanations.ts';
import { loadElkLayout } from './layout/index.ts';
import { AgentCardNode } from './nodes/AgentCard.tsx';
import { PhaseLaneNode } from './nodes/PhaseLane.tsx';
import {
  PlanAgentNode,
  PlanProcessNode,
  DecisionDiamond,
  LoopContainer,
  OutputTerminal,
  UnparsedPlaceholder,
} from './nodes/PlanNodes.tsx';

// Stable identity (a fresh object each render would make React Flow warn + re-mount).
// Execution-view types (M3, unchanged) + the P1b Plan-AST types — one shared registry.
const nodeTypes: NodeTypes = {
  phaseLane: PhaseLaneNode,
  agentCard: AgentCardNode,
  planAgent: PlanAgentNode,
  planProcess: PlanProcessNode,
  planDecision: DecisionDiamond,
  planLoop: LoopContainer,
  planOutput: OutputTerminal,
  planUnparsed: UnparsedPlaceholder,
};

type ViewMode = 'execution' | 'plan';

const EMPTY_GRAPH: GraphResult = { nodes: [], edges: [] };

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

  // --- Execution (M3) path — UNCHANGED: list runs, auto-select the 14-agent run. ---
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

  // --- Plan path — run-free: list declared workflows, auto-select plan-research. ---
  const workflowsQ = useQuery({
    queryKey: ['workflows', project?.slug],
    queryFn: () => fetchProjectWorkflows(project!.slug),
    enabled: !!project && view === 'plan',
  });
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null);
  const workflows = workflowsQ.data ?? [];
  const workflow =
    workflows.find((w) => w.name === selectedWorkflow) ?? pickWorkflow(workflowsQ.data);

  // P1b: the rich PlanModel for the selected workflow (the AST plan over /plan).
  const planQ = useQuery({
    queryKey: ['plan', project?.slug, workflow?.file],
    queryFn: () => fetchProjectPlan(project!.slug, workflow!.file),
    enabled: !!project && view === 'plan' && !!workflow,
  });
  const plan = planQ.data;

  // --- AST-mode layout: when the PlanModel is rich (static-source), lay it out with
  //     elkjs (lazily loaded). The P0 meta-only planMetaToGraph is the RUN-FREE FALLBACK
  //     used on derivedFrom==='meta-only' OR any /plan fetch error. ---
  const useAstMode = !!plan && plan.derivedFrom === 'static-source' && plan.nodes.length > 0;

  const [astGraph, setAstGraph] = useState<GraphResult>(EMPTY_GRAPH);
  const [astError, setAstError] = useState(false);
  useEffect(() => {
    if (view !== 'plan' || !useAstMode || !plan) {
      setAstGraph(EMPTY_GRAPH);
      setAstError(false);
      return;
    }
    let cancelled = false;
    setAstError(false);
    (async () => {
      try {
        const elk = await loadElkLayout();
        const graph = await planModelToGraph(plan as PlanModel, elk);
        if (!cancelled) setAstGraph(graph);
      } catch {
        // Layout/elk failure → fall back to the meta-only graph (never a blank canvas).
        if (!cancelled) {
          setAstGraph(EMPTY_GRAPH);
          setAstError(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view, useAstMode, plan]);

  const run = runQ.data;
  const metaGraph = useMemo(() => {
    if (view !== 'plan') return EMPTY_GRAPH;
    return workflow ? planMetaToGraph(workflow) : EMPTY_GRAPH;
  }, [view, workflow]);

  const execGraph = useMemo(() => {
    if (view !== 'execution') return EMPTY_GRAPH;
    return run ? runModelToGraph(run) : EMPTY_GRAPH;
  }, [view, run]);

  // The AST plan is used when available AND elk succeeded; else the meta-only fallback.
  const planIsAst = view === 'plan' && useAstMode && !astError && astGraph.nodes.length > 0;
  const baseGraph: GraphResult =
    view === 'execution' ? execGraph : planIsAst ? astGraph : metaGraph;

  // --- PX: poll per-node LLM captions in the background and swap them into the existing
  //     subtitle/caption slots when ready. Annotation-only: topology is untouched. The
  //     plan poll keys on the selected workflow file; the run poll on the run ref. The
  //     poll only runs for the active view (execution vs plan). When `claude` is absent
  //     the batch is engine-unavailable/all-baseline and the overlay is a no-op. ---
  const planExplanations = usePlanExplanations(
    project?.slug,
    workflow?.file,
    view === 'plan' && planIsAst,
  );
  const runExplanations = useRunExplanations(
    summary ? { slug: summary.ref.slug, sessionId: summary.ref.sessionId, runId: summary.ref.runId } : undefined,
    view === 'execution' && !!run,
  );
  const graph: GraphResult = useMemo(() => {
    if (view === 'execution') return overlayExplanations(baseGraph, runExplanations);
    if (planIsAst) return overlayExplanations(baseGraph, planExplanations);
    return baseGraph; // meta-only plan: lanes carry their declared subtitle already
  }, [view, planIsAst, baseGraph, runExplanations, planExplanations]);

  const error = projectsQ.error ?? runsQ.error ?? runQ.error ?? workflowsQ.error;
  const loading =
    projectsQ.isPending ||
    (!!project && view === 'execution' && runsQ.isPending) ||
    (!!summary && view === 'execution' && runQ.isPending) ||
    (!!project && view === 'plan' && workflowsQ.isPending);

  const hasContent = view === 'plan' ? !!workflow : !!run;

  // Header: in AST mode show the real node/edge counts + coverage + the derivation tag.
  const planNodeCount = plan?.nodes.length ?? 0;
  const planDerived = planIsAst ? 'AST' : 'declared';

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
            {planIsAst
              ? `${planNodeCount} ${planNodeCount === 1 ? 'node' : 'nodes'} · ${planDerived}`
              : `${workflow.phases.length} ${workflow.phases.length === 1 ? 'phase' : 'phases'} · declared`}
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
