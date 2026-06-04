import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  type NodeTypes,
  type ReactFlowInstance,
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
import { Rail, type RailSection } from './shell/Rail.tsx';

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

/** Dogfood DEFAULT (M4: overridable): prefer modal-rust; else the first project. */
function defaultProject(projects: ProjectRef[] | undefined): ProjectRef | undefined {
  if (!projects || projects.length === 0) return undefined;
  return projects.find((p) => p.projectPath.includes('modal-rust')) ?? projects[0];
}

/** Execution DEFAULT (M4: overridable): the richest run (the 14-agent plan-research run). */
function defaultRun(runs: RunSummary[] | undefined): RunSummary | undefined {
  if (!runs || runs.length === 0) return undefined;
  return [...runs].sort((a, b) => b.agentCount - a.agentCount)[0];
}

/** Plan DEFAULT (M4: overridable): plan-research; else the first declared workflow. */
function defaultWorkflow(workflows: WorkflowMeta[] | undefined): WorkflowMeta | undefined {
  if (!workflows || workflows.length === 0) return undefined;
  return workflows.find((w) => w.name.includes('plan-research')) ?? workflows[0];
}

export function App() {
  const [view, setView] = useState<ViewMode>('execution');

  // --- M4: selection lifted into shared app state. Each is null until the user
  //     picks; while null we fall back to the dogfood default for that scope. So the
  //     app opens on the same modal-rust / richest-run / plan-research picks as before
  //     but ANY discovered project / run / workflow can override them, and the choice
  //     survives the Plan⟷Execution toggle (state lives here, above the view). ---
  const [railCollapsed, setRailCollapsed] = useState(true); // collapsed-by-default
  const [railSection, setRailSection] = useState<RailSection>('projects');
  const [selectedProjectPath, setSelectedProjectPath] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedWorkflowName, setSelectedWorkflowName] = useState<string | null>(null);

  const projectsQ = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });
  const projects = projectsQ.data;
  const project =
    projects?.find((p) => p.projectPath === selectedProjectPath) ?? defaultProject(projects);

  // --- Runs for the SELECTED project (queries already key on project.slug, so a new
  //     project re-scopes its runs/workflows automatically). ---
  const runsQ = useQuery({
    queryKey: ['runs', project?.slug],
    queryFn: () => fetchProjectRuns(project!.slug),
    enabled: !!project,
  });
  const runs = useMemo(() => runsQ.data ?? [], [runsQ.data]);
  const summary =
    runs.find((r) => r.ref.runId === selectedRunId) ?? defaultRun(runs);

  const runQ = useQuery({
    queryKey: ['run', summary?.ref.slug, summary?.ref.sessionId, summary?.ref.runId],
    queryFn: () => fetchRunModel(summary!.ref),
    enabled: !!summary && view === 'execution',
  });

  // --- Workflows for the selected project (run-free Plan source). Loaded whenever a
  //     project is known so the rail's Plan-workflow list is reachable from BOTH views;
  //     the heavier /plan AST fetch stays gated on the Plan view. ---
  const workflowsQ = useQuery({
    queryKey: ['workflows', project?.slug],
    queryFn: () => fetchProjectWorkflows(project!.slug),
    enabled: !!project,
  });
  const workflows = useMemo(() => workflowsQ.data ?? [], [workflowsQ.data]);
  const workflow =
    workflows.find((w) => w.name === selectedWorkflowName) ?? defaultWorkflow(workflows);

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

  // fitView (U1 cosmetic fix): the `fitView` PROP only fits on mount, so the async
  // Plan-AST graph (which replaces the meta-only graph after elk resolves) was never
  // refit — leaving it off-center with the rightmost phase lane clipped. Capture the
  // instance and refit whenever the graph's node SET changes (a topology swap), keyed by
  // a cheap signature so caption-only (PX) overlays — which never change ids — do NOT
  // refit and yank the viewport.
  const rfRef = useRef<ReactFlowInstance | null>(null);
  const fitSignature = useMemo(
    () => `${view}:${graph.nodes.length}:${graph.nodes.map((n) => n.id).join(',')}`,
    [view, graph.nodes],
  );
  useEffect(() => {
    if (graph.nodes.length === 0) return;
    const inst = rfRef.current;
    if (!inst) return;
    // Defer one frame so React Flow has measured the new nodes before fitting.
    const raf = requestAnimationFrame(() => inst.fitView({ padding: 0.12, duration: 240 }));
    return () => cancelAnimationFrame(raf);
  }, [fitSignature, graph.nodes.length]);

  // --- M4 selection handlers (mutate the shared state, not the canvas). ---
  // Picking a project re-scopes everything: clear the dependent run + workflow choice
  // so the new project's defaults take over via its (re-keyed) queries.
  function handleSelectProject(p: ProjectRef) {
    setSelectedProjectPath(p.projectPath);
    setSelectedRunId(null);
    setSelectedWorkflowName(null);
  }
  // Picking a run lands it in the Execution view (today's view auto-picks the richest
  // run; M4 lets you choose ANY of them).
  function handleSelectRun(r: RunSummary) {
    setSelectedRunId(r.ref.runId);
    setView('execution');
  }
  // Picking a workflow lands it in the Plan view.
  function handleSelectWorkflow(w: WorkflowMeta) {
    setSelectedWorkflowName(w.name);
    setView('plan');
  }

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
        onInit={(inst) => {
          rfRef.current = inst;
        }}
        nodes={graph.nodes}
        edges={graph.edges}
        nodeTypes={nodeTypes}
        colorMode="dark"
        fitView
        fitViewOptions={{ padding: 0.12 }}
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

      {/* M4: the collapsible left icon-rail (project switcher + run picker + settings). */}
      <Rail
        collapsed={railCollapsed}
        onToggleCollapsed={() => setRailCollapsed((c) => !c)}
        section={railSection}
        onSelectSection={setRailSection}
        projects={projects ?? []}
        selectedProjectPath={project?.projectPath}
        onSelectProject={handleSelectProject}
        projectsLoading={projectsQ.isPending}
        runs={runs}
        selectedRunId={summary?.ref.runId}
        onSelectRun={handleSelectRun}
        runsLoading={!!project && runsQ.isPending}
        workflows={workflows}
        selectedWorkflowName={workflow?.name}
        onSelectWorkflow={handleSelectWorkflow}
      />

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
              onChange={(e) => setSelectedWorkflowName(e.target.value)}
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
