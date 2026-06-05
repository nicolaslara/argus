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
  fetchRunLive,
  fetchRunPlan,
} from './api.ts';
import { runModelToGraph, type GraphResult } from './mapping.ts';
import { planMetaToGraph } from './plan-mapping.ts';
import { planModelToGraph } from './plan-model-mapping.ts';
import { buildOverlay } from './overlay.ts';
import { paintOverlay } from './overlay-paint.ts';
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
import { DetailPanel } from './nodes/DetailPanel.tsx';
import { RunOverviewPanel } from './nodes/RunOverviewPanel.tsx';

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

// P2: a third mode — the Plan⟷Execution MORPH. `overlay` paints a selected run's STATUS
// onto its plan template (the canonical shared layout). `plan` = run-free template;
// `execution` = the M3 phase-lane run view (byte-unchanged).
type ViewMode = 'execution' | 'plan' | 'overlay';

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
  // P2: the folded↔unrolled MODE switch for loop rounds (default folded).
  const [unrolled, setUnrolled] = useState(false);
  // I1: the node whose detail panel is open (by id; null = closed). Resolved against the
  // CURRENT graph, so switching view/run/workflow (a new node set) auto-closes a stale panel.
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // I3: the run-overview panel (logs timeline + run totals), opened from the run-header
  // name. A node selection takes precedence over it (node detail wins).
  const [overviewOpen, setOverviewOpen] = useState(false);

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
    // L1: while ANY run is in-progress, poll the list so a running→completed transition is
    // noticed (which flips the run model from the live snapshot to the finalized one).
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'running') ? 2500 : false),
  });
  const runs = useMemo(() => runsQ.data ?? [], [runsQ.data]);
  // R2: prefer the explicitly-selected run; else a run of the SELECTED WORKFLOW (so
  // Morph/Execution stay coherent with the Plan workflow); else the richest default.
  const summary =
    runs.find((r) => r.ref.runId === selectedRunId) ??
    (selectedWorkflowName ? runs.find((r) => r.workflowName === selectedWorkflowName) : undefined) ??
    defaultRun(runs);

  // L2: a `running` run has no finalized wf_*.json yet — fetch its PARTIAL live snapshot
  // (built from the journal) and POLL it; once it finalizes (summary.status flips via the
  // runsQ poll) we fall back to the authoritative finalized snapshot and stop polling.
  const isLiveRun = summary?.status === 'running';

  // The run model is needed by BOTH the execution view AND the P2 overlay (to build the
  // binding). Gate it on either.
  const runQ = useQuery({
    queryKey: ['run', summary?.ref.slug, summary?.ref.sessionId, summary?.ref.runId, isLiveRun ? 'live' : 'final'],
    queryFn: () => (isLiveRun ? fetchRunLive(summary!.ref) : fetchRunModel(summary!.ref)),
    enabled: !!summary && (view === 'execution' || view === 'overlay'),
    refetchInterval: isLiveRun ? 1500 : false,
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

  // --- P2 MORPH: the selected run's PLAN source via the per-run endpoint
  //     (`/api/runs/:slug/:session/:runId/plan`). The SERVER prefers the EXACT persisted
  //     per-run script (what actually ran) and falls back to the recovered project
  //     workflow `.js` when a run has no persisted script (e.g. the 14-agent plan-research
  //     run) — so the web makes ONE clean request (no client-side 404 probe). ---
  const runPlanQ = useQuery({
    queryKey: ['run-plan', summary?.ref.slug, summary?.ref.sessionId, summary?.ref.runId],
    enabled: !!summary && view === 'overlay',
    queryFn: () => fetchRunPlan(summary!.ref),
  });
  const runPlan = runPlanQ.data;

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

  // --- P2 MORPH layout: lay the run's plan out with the SAME elk pass + planModelToGraph
  //     the Plan view uses (the canonical shared layout), then PAINT the run status onto
  //     it (buildOverlay → paintOverlay). Painting is additive (data-only); toggling the
  //     folded↔unrolled `unrolled` mode re-paints without relaying out. Drilling a node
  //     never relayouts (paint is a data patch). ---
  const overlay = useMemo(
    () => (runPlan && run ? buildOverlay(runPlan, run) : null),
    [runPlan, run],
  );
  const overlayLayoutReady = !!runPlan && runPlan.derivedFrom === 'static-source' && runPlan.nodes.length > 0;
  const [overlayBaseGraph, setOverlayBaseGraph] = useState<GraphResult>(EMPTY_GRAPH);
  const [overlayError, setOverlayError] = useState(false);
  useEffect(() => {
    if (view !== 'overlay' || !overlayLayoutReady || !runPlan) {
      setOverlayBaseGraph(EMPTY_GRAPH);
      setOverlayError(false);
      return;
    }
    let cancelled = false;
    setOverlayError(false);
    (async () => {
      try {
        const elk = await loadElkLayout();
        const graph = await planModelToGraph(runPlan as PlanModel, elk);
        if (!cancelled) setOverlayBaseGraph(graph);
      } catch {
        if (!cancelled) {
          setOverlayBaseGraph(EMPTY_GRAPH);
          setOverlayError(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view, overlayLayoutReady, runPlan]);

  // Paint (data-only) — separate from layout so the folded↔unrolled toggle never relayouts.
  const overlayGraph = useMemo(() => {
    if (view !== 'overlay' || overlayBaseGraph.nodes.length === 0 || !overlay) return EMPTY_GRAPH;
    return paintOverlay(overlayBaseGraph, overlay, unrolled);
  }, [view, overlayBaseGraph, overlay, unrolled]);

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
    view === 'execution'
      ? execGraph
      : view === 'overlay'
        ? overlayGraph
        : planIsAst
          ? astGraph
          : metaGraph;

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
    // overlay (morph) mode: the base graph is already painted with run status; PX captions
    // are not joined here (the painted plan node ids ≠ agentIds). meta-only plan: lanes
    // carry their declared subtitle already.
    return baseGraph;
  }, [view, planIsAst, baseGraph, runExplanations, planExplanations]);

  // I1: resolve the open detail node against the live graph (null if it's no longer present).
  const selectedNode = useMemo(
    () => graph.nodes.find((n) => n.id === selectedNodeId) ?? null,
    [graph.nodes, selectedNodeId],
  );

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
    // M5 empty-band fix: the Plan/Morph DAG is wide-but-short, so a uniform 0.12 padding +
    // the default maxZoom=2 fit it to WIDTH and left a tall empty band. Give those two views
    // a tighter padding AND a higher maxZoom so the graph is allowed to zoom up and FILL the
    // canvas (paired with the taller elk lanes above). Execution keeps the comfortable 0.12.
    const isWideShort = view === 'plan' || view === 'overlay';
    const opts = isWideShort
      ? { padding: 0.06, duration: 240, maxZoom: 2.6 }
      : { padding: 0.12, duration: 240 };
    // Defer one frame so React Flow has measured the new nodes before fitting.
    const raf = requestAnimationFrame(() => inst.fitView(opts));
    return () => cancelAnimationFrame(raf);
  }, [fitSignature, graph.nodes.length, view]);

  // --- M4 selection handlers (mutate the shared state, not the canvas). ---
  // Picking a project re-scopes everything: clear the dependent run + workflow choice
  // so the new project's defaults take over via its (re-keyed) queries.
  function handleSelectProject(p: ProjectRef) {
    setSelectedProjectPath(p.projectPath);
    setSelectedRunId(null);
    setSelectedWorkflowName(null);
  }
  // R2: selection is UNIFIED across the three views. Picking a run drives Execution AND
  // syncs the Plan workflow to the run's workflow, so Plan/Morph/Execution all describe the
  // SAME workflow (no more "Plan shows X while Execution shows Y").
  function handleSelectRun(r: RunSummary) {
    setSelectedRunId(r.ref.runId);
    setSelectedWorkflowName(r.workflowName);
    setView('execution');
  }
  // Picking a workflow drives the Plan view AND selects that workflow's most-recent run (if
  // any) so Morph/Execution follow it too — and so a live run is one click from validation.
  function handleSelectWorkflow(w: WorkflowMeta) {
    setSelectedWorkflowName(w.name);
    const match = runs.find((r) => r.workflowName === w.name);
    setSelectedRunId(match ? match.ref.runId : null);
    setView('plan');
  }

  const error = projectsQ.error ?? runsQ.error ?? runQ.error ?? workflowsQ.error;
  const loading =
    projectsQ.isPending ||
    (!!project && view === 'execution' && runsQ.isPending) ||
    (!!summary && (view === 'execution' || view === 'overlay') && runQ.isPending) ||
    (!!summary && view === 'overlay' && runPlanQ.isPending) ||
    (!!project && view === 'plan' && workflowsQ.isPending);

  const hasContent =
    view === 'plan' ? !!workflow : view === 'overlay' ? !!run && !!runPlan : !!run;

  // Header: in AST mode show the real node/edge counts + coverage + the derivation tag.
  const planNodeCount = plan?.nodes.length ?? 0;
  const planDerived = planIsAst ? 'AST' : 'declared';

  // P2 overlay header summary: bound / partial / planned-not-run / unplanned counts.
  const overlayBound = overlay?.bindings.filter((b) => b.status !== 'not-run').length ?? 0;
  const overlayNotRun = overlay?.bindings.filter((b) => b.status === 'not-run').length ?? 0;
  const overlayPartial = overlay?.bindings.filter((b) => b.status === 'partial').length ?? 0;
  const overlayUnplanned = overlay?.unplannedAgentIds.length ?? 0;
  const overlayRounds = overlay?.rounds ?? null;

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
        maxZoom={3}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        onNodeClick={(_, n) => {
          setSelectedNodeId(n.id);
          setOverviewOpen(false); // node detail takes precedence over the run overview
        }}
        onPaneClick={() => {
          setSelectedNodeId(null);
          setOverviewOpen(false);
        }}
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

      {/* Plan ⟷ Morph ⟷ Execution view toggle. Morph (P2) paints the selected run's
          status onto its plan template — proving plan & execution are one graph. */}
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
          className={`view-toggle-btn${view === 'overlay' ? ' is-active' : ''}`}
          aria-pressed={view === 'overlay'}
          onClick={() => setView('overlay')}
          title="paint this run's status onto its plan template (Plan⟷Execution morph)"
        >
          Morph
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

      {/* P2 folded↔unrolled MODE switch — shown only when the morph observed loop rounds. */}
      {view === 'overlay' && overlayRounds != null && overlayRounds > 1 ? (
        <div className="mode-toggle" role="group" aria-label="loop unroll mode">
          <button
            type="button"
            className={`mode-toggle-btn${!unrolled ? ' is-active' : ''}`}
            aria-pressed={!unrolled}
            onClick={() => setUnrolled(false)}
            title="folded: one aggregate loop body"
          >
            ⊟ folded
          </button>
          <button
            type="button"
            className={`mode-toggle-btn${unrolled ? ' is-active' : ''}`}
            aria-pressed={unrolled}
            onClick={() => setUnrolled(true)}
            title={`unrolled: ${overlayRounds} round-column axis within the loop`}
          >
            ⊞ unrolled · {overlayRounds}r
          </button>
        </div>
      ) : null}

      {view === 'plan' && workflow ? (
        <div className="run-header">
          {workflows.length > 1 ? (
            <select
              className="wf-picker"
              value={workflow.name}
              onChange={(e) => {
                // R2: keep Morph/Execution coherent — switch to a run of the chosen workflow.
                const name = e.target.value;
                setSelectedWorkflowName(name);
                const match = runs.find((r) => r.workflowName === name);
                setSelectedRunId(match ? match.ref.runId : null);
              }}
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
      ) : view === 'overlay' && run ? (
        <div className="run-header">
          <button
            type="button"
            className="run-header-name run-header-name-btn"
            onClick={() => setOverviewOpen((v) => !v)}
            title="run overview — narrator log timeline + totals"
          >
            {run.workflowName}
          </button>
          <span className="run-badge run-badge-plan">morph</span>
          <span className={`run-badge run-badge-${run.status}`}>{run.status}</span>
          <span className="run-header-meta">
            {overlayBound} bound
            {overlayPartial > 0 ? ` · ${overlayPartial} partial` : ''}
            {overlayNotRun > 0 ? ` · ${overlayNotRun} planned-not-run` : ''}
            {overlayUnplanned > 0 ? ` · ${overlayUnplanned} unplanned` : ''}
            {overlayRounds != null ? ` · ${overlayRounds} loop rounds` : ''}
          </span>
          {run.partialFailure.present ? (
            <span className="run-badge run-badge-partial" title={run.partialFailure.lines[0] ?? ''}>
              partial failure
            </span>
          ) : null}
        </div>
      ) : view === 'execution' && run ? (
        <div className="run-header">
          <button
            type="button"
            className="run-header-name run-header-name-btn"
            onClick={() => setOverviewOpen((v) => !v)}
            title="run overview — narrator log timeline + totals"
          >
            {run.workflowName}
          </button>
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

      {/* P2: unplanned agents (label matched no plan node) surfaced honestly. */}
      {view === 'overlay' && overlayUnplanned > 0 ? (
        <div className="overlay-unplanned" role="note" title="run agents whose label matched no plan node">
          <span className="overlay-unplanned-glyph" aria-hidden="true">⚠</span>
          {overlayUnplanned} unplanned agent{overlayUnplanned === 1 ? '' : 's'}
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
                  : view === 'overlay'
                    ? overlayError
                      ? 'could not lay out this run’s plan'
                      : 'no plan source found for this run'
                    : 'no runs found in ~/.claude'}
          </div>
        </div>
      ) : null}

      {/* I1: node detail panel (right side), filled instantly from the clicked node's data. */}
      <DetailPanel
        node={selectedNode}
        runRef={summary ? { slug: summary.ref.slug, sessionId: summary.ref.sessionId, runId: summary.ref.runId } : null}
        onClose={() => setSelectedNodeId(null)}
      />
      {/* I3: run overview (logs timeline) — only when no node is selected (node wins). */}
      {!selectedNode && overviewOpen ? (
        <RunOverviewPanel run={run ?? null} onClose={() => setOverviewOpen(false)} />
      ) : null}
    </div>
  );
}
