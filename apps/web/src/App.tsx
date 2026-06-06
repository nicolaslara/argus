import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import type { ProjectRef, RunSummary, WorkflowMeta } from '@argus/contract';
import {
  fetchProjects,
  fetchProjectRuns,
  fetchProjectWorkflows,
  fetchProjectPlan,
  fetchRunModel,
  fetchRunLive,
  fetchRunPlan,
} from './api.ts';
import { pickPlanSource } from './plan-correspondence.ts';
import { ExpandContext, type LoopDrillMode } from './expand-context.ts';
import { readLoopDrillMode, writeLoopDrillMode } from './loop-drill-setting.ts';
import { migrateLoopDrill } from './loop-drill-migrate.ts';
// The run/plan graph-build pipeline (elk layout, the morph paint+expand, the live-fill fetch,
// the LLM caption polls) lives in ./hooks/useRunGraph.ts so App stays chrome + state. App owns
// the run query + selection state; the hook turns those into the rendered graph.
import { useRunGraph } from './hooks/useRunGraph.ts';
import { computeFitSignature } from './fit-signature.ts';
import {
  warningCountLabel,
  summarizeWarningCodes,
  isDegraded,
  planCoverageLabel,
  planCoverageTitle,
} from './degradation-signal.ts';
import { AgentCardNode } from './nodes/AgentCard.tsx';
import { PhaseLaneNode } from './nodes/PhaseLane.tsx';
import {
  PlanAgentNode,
  PlanProcessNode,
  FanMarkerNode,
  DecisionDiamond,
  LoopContainer,
  OutputTerminal,
  UnparsedPlaceholder,
} from './nodes/PlanNodes.tsx';
import { InstanceGroup } from './nodes/InstanceGroup.tsx';
import { AgentChip } from './nodes/AgentChip.tsx';
import { Rail, type RailSection } from './shell/Rail.tsx';
import { formatElapsed, formatRelativeTime } from './shell/format.ts';
import { DetailPanel } from './nodes/DetailPanel.tsx';
import { RunOverviewPanel } from './nodes/RunOverviewPanel.tsx';
import { RunHistory } from './nodes/RunHistory.tsx';
import { AgentTablePanel } from './tables/AgentTablePanel.tsx';
import { deriveFailureInfo } from './failure-info.ts';
import { defaultProject, defaultRun, defaultWorkflow } from './defaults.ts';
import { chromeAwareFitOptions } from './fit/chrome-fit.ts';
import { FailureBanner } from './run-view/FailureBanner.tsx';
import { RunObjective } from './run-view/RunObjective.tsx';
import { useLiveStream } from './hooks/useLiveStream.ts';
import { useChromeFit } from './hooks/useChromeFit.ts';

// Stable identity (a fresh object each render would make React Flow warn + re-mount).
// Execution-view types (M3, unchanged) + the P1b Plan-AST types — one shared registry.
const nodeTypes: NodeTypes = {
  phaseLane: PhaseLaneNode,
  agentCard: AgentCardNode,
  planAgent: PlanAgentNode,
  planProcess: PlanProcessNode,
  planMarker: FanMarkerNode,
  planDecision: DecisionDiamond,
  planLoop: LoopContainer,
  planOutput: OutputTerminal,
  planUnparsed: UnparsedPlaceholder,
  // The merged Run view's expand drawer (run-view-merge-plan.md §2). expandInstances emits
  // these as `type:'instanceGroup'` parented to the host phase lane.
  instanceGroup: InstanceGroup,
  // Ship #6 density degrade: above the threshold a degraded drawer's cells are compact
  // `agentChip` nodes (+ a `+N more` tile) instead of full agentCards.
  agentChip: AgentChip,
};

// The merged Run view (run-view-merge-plan.md §1): TWO top-level views. `plan` is the
// run-free template (the design); `run` paints a selected run's STATUS onto that plan
// template (the canonical shared layout) AND expands a clicked fan-out into its instance
// cards in-place (expandInstances). The old `overlay`/`execution` split is gone — Progress
// and Execution were the same run at two zoom levels, joined now by a click, not a tab.
type ViewMode = 'plan' | 'run';

// STEP 3 (inline-expand): the readability budget for the one-time auto-expand seed. On a
// run change we default-expand every fanned step so each subagent is visible — but bounded:
// once the running total of auto-expanded INSTANCES would exceed this cap, we stop opening
// further (larger) fans and leave them collapsed (aggregate chips). Keeps a 50-agent fan
// from exploding the canvas while still surfacing the small/medium fans by default.
const EXPAND_BUDGET = 24;

// The chrome-aware fitView options (the no-overlap invariant: reserve the floating chrome's
// MEASURED footprint as per-side fitView padding so a fit-viewed graph never lands underneath
// it) live in ./fit/chrome-fit.ts. App only calls it (from the Controls fit button + the
// useChromeFit effects); the inset → React-Flow-Padding math lives in ./pad-from-insets.ts.

// The persisted loop-drill MODE setting (loop-drill-gallery.html opt1 vs opt2) is held in App
// state and mirrored to localStorage so the choice sticks across reloads. 'round-axis' (option 1)
// is the default + the fully-working baseline; 'lane-drawer' (option 2) is the recursive in-loop
// drawer. The pure read/write/normalize seam lives in ./loop-drill-setting.ts (so it is unit-
// testable without the React app); a missing/unknown/unavailable store degrades to the default.
//
// The dogfood DEFAULT pickers (defaultProject/defaultRun/defaultWorkflow) live in ./defaults.ts;
// the Run-view chrome components (FailureBanner, RunObjective) live in ./run-view/.

export function App() {
  const [view, setView] = useState<ViewMode>('run');

  // --- M4: selection lifted into shared app state. Each is null until the user
  //     picks; while null we fall back to the dogfood default for that scope. So the
  //     app opens on the same modal-rust / richest-run / plan-research picks as before
  //     but ANY discovered project / run / workflow can override them, and the choice
  //     survives the Plan⟷Execution toggle (state lives here, above the view). ---
  const [railCollapsed, setRailCollapsed] = useState(false); // open-by-default (per UX: sidebar starts expanded)
  const [railSection, setRailSection] = useState<RailSection>('explorer');
  // Loop-drill MODE (settings toggle): how a loop step's body subagents are drilled —
  // 'round-axis' (option 1, default) vs 'lane-drawer' (option 2). Initialized from
  // localStorage so a reload restores the choice; the setter persists every change.
  const [loopDrillMode, setLoopDrillModeState] = useState<LoopDrillMode>(() => readLoopDrillMode());
  // The MIGRATING setter (setLoopDrillMode) is defined below, AFTER the loop-drill state it has to
  // carry across the switch (selectedRound / loopDrawerRound) is declared.
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
  // "Table panel" (roadmap · M): the collapsible bottom AGENT TABLE — the at-scale scanning
  // surface for the selected run (sort/filter by cost/time/tools/status to find the outlier).
  // Run-view + run-loaded only; toggled from the run-header. A row click selects that agent.
  const [tableOpen, setTableOpen] = useState(false);
  // A row click selects an agent that may NOT exist as a graph node (its fan can be collapsed),
  // so we hold the clicked AgentNode here and synthesize a transient `agentCard` node for the
  // DetailPanel (the panel's exec-agent path reads from node.data). It takes precedence over a
  // canvas node selection; cleared on run/view change and on close.
  const [tableAgentId, setTableAgentId] = useState<string | null>(null);
  // Graph cross-highlight: the agent currently HOVERED in the table (transient, cleared on
  // mouse-out). Distinct from `tableAgentId` (the SELECTED row, persistent + opens the panel):
  // hover is PURELY visual — a soft glow on the matching graph node, no panel, no refit. Both
  // thread data-only into the overlay graph (mirroring the failure-ring), so a change just
  // re-paints node.data — no ELK relayout (gated by overlayLayoutReady, never re-run here).
  const [hoveredAgentId, setHoveredAgentId] = useState<string | null>(null);
  // run-detail-plan §1.1: the run SELECTOR drawer in the Run-view header. The current run is a
  // compact chip with a caret; clicking it opens a small dropdown holding <RunHistory> of THIS
  // workflow's runs so the user can switch. Closes on pick / outside click.
  const [runSelectorOpen, setRunSelectorOpen] = useState(false);
  const runSelectorRef = useRef<HTMLDivElement | null>(null);
  // Merged Run view (run-view-merge-plan.md §2): the host template node ids whose instance
  // drawer is open. RESET on run/workflow change and SEEDED ONCE from the live flag on
  // run-change (running → active fans auto-expanded; finished → empty); user-owned
  // thereafter via `toggleExpanded` (add/delete). Drives expandInstances.
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(() => new Set());
  const toggleExpanded = useCallback((nodeId: string) => {
    setExpandedNodeIds((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);
  // Loop-body drill: a clickable round-axis pill selects the loop CONTAINER node + a specific
  // ROUND. How that drill is shown depends on the loop-drill MODE setting:
  //  - 'round-axis' (option 1, default): the DetailPanel surfaces that round's bound instances
  //    (each a clickable drill into one agent's transcript). The loop box stays compact.
  //  - 'lane-drawer' (option 2): the round's agents expand AS CARDS inside the loop compound (a
  //    recursive drawer via expandLoopDrawer); the back-edge re-routes around the grown drawer.
  // `selectedRound` (the DetailPanel scope) is used by option 1; `loopDrawerRound` (loopId →
  // open round) drives option 2's in-loop drawer.
  const [selectedRound, setSelectedRound] = useState<number | null>(null);
  // OPTION 2: which loop's round drawer is open in-canvas (loopNodeId → round). A second click
  // on the SAME open round toggles it closed; a different round swaps. Reset on run change.
  const [loopDrawerRound, setLoopDrawerRound] = useState<Map<string, number>>(() => new Map());
  // `loopDrillMode` is read inside selectRound, so keep the latest in a ref to avoid re-creating
  // the callback (and the ExpandContext value) on every mode change while staying current.
  const loopDrillModeRef = useRef(loopDrillMode);
  loopDrillModeRef.current = loopDrillMode;
  const selectRound = useCallback((loopNodeId: string, round: number) => {
    if (loopDrillModeRef.current === 'lane-drawer') {
      // OPTION 2: toggle the in-loop round drawer (a recursive lane-drawer inside the loop).
      // Clicking the OPEN round again closes it; a different round swaps. No DetailPanel scope.
      setLoopDrawerRound((prev) => {
        const next = new Map(prev);
        if (next.get(loopNodeId) === round) next.delete(loopNodeId);
        else next.set(loopNodeId, round);
        return next;
      });
      return;
    }
    // OPTION 1 (default): scope the DetailPanel to (loop node, round).
    setSelectedNodeId(loopNodeId);
    setSelectedRound(round);
    setOverviewOpen(false); // the loop's round detail takes precedence over the run overview
  }, []);

  // The MODE setter, made RESPONSIVE: flipping the loop-drill setting while a round is open carries
  // that open round into the new mode's presentation (round-axis DetailPanel scope ⟷ lane-drawer
  // in-canvas drawer) instead of stranding it. The pure migration lives in ./loop-drill-migrate.ts;
  // here we just feed it the current drill state (via refs, so the setter stays stable) and apply
  // the result. Always persists the new mode (a missing/disabled store is non-fatal).
  const drillStateRef = useRef({ selectedNodeId, selectedRound, loopDrawerRound });
  drillStateRef.current = { selectedNodeId, selectedRound, loopDrawerRound };
  const setLoopDrillMode = useCallback((mode: LoopDrillMode) => {
    const from = loopDrillModeRef.current;
    if (from !== mode) {
      const next = migrateLoopDrill(from, mode, drillStateRef.current);
      setSelectedNodeId(next.selectedNodeId);
      setSelectedRound(next.selectedRound);
      setLoopDrawerRound(new Map(next.loopDrawerRound));
      // A round carried into the in-canvas drawer (or panel) takes precedence over the run overview.
      if (next.selectedRound != null || next.loopDrawerRound.size > 0) setOverviewOpen(false);
    }
    setLoopDrillModeState(mode);
    writeLoopDrillMode(mode);
  }, []);

  // Stable provider value (new only when the expanded set / mode / open drawer changes) so
  // PlanAgentNode carets read a fresh `expanded` but a stable `toggle` / `selectRound`.
  const expandContextValue = useMemo(
    () => ({
      expanded: expandedNodeIds,
      toggle: toggleExpanded,
      selectRound,
      loopDrillMode,
      openLoopRound: loopDrawerRound,
    }),
    [expandedNodeIds, toggleExpanded, selectRound, loopDrillMode, loopDrawerRound],
  );

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
  // Live & inspection #2 (SUB-TASK C): the query key is STABLE across a live→finalized
  // transition (no 'live'/'final' suffix). The queryFn still switches fetchers on liveness, so
  // when a run finalizes the SAME cache slot is updated in-place — no new cache entry, so the
  // overlay's structural fitSignature (which already excludes instance/drawer ids) doesn't see
  // a fresh query and yank the viewport. The finalized model uses the SAME plan template as the
  // live snapshot, so the in-place swap is structurally safe. The runId is still in the key, so
  // switching runs (and the initial empty→populated fit) still re-fit correctly.
  const runQ = useQuery({
    queryKey: ['run', summary?.ref.slug, summary?.ref.sessionId, summary?.ref.runId],
    queryFn: () => (isLiveRun ? fetchRunLive(summary!.ref) : fetchRunModel(summary!.ref)),
    enabled: !!summary && view === 'run',
    // L3: SSE pushes a refetch on every journal append; this slow poll is a safety net for
    // a dropped stream (and a hard backstop on macOS fs.watch, which can miss appends).
    refetchInterval: isLiveRun ? 4000 : false,
  });

  // L3: subscribe to the run's SSE stream while it's live — a journal append pushes a
  // `changed` event → invalidate the live model immediately (no poll lag). EventSource
  // auto-reconnects (the server sends `retry:`), giving the gate's "clean reconnect".
  const liveSlug = summary?.ref.slug;
  const liveSession = summary?.ref.sessionId;
  const liveRunId = summary?.ref.runId;
  // Live & inspection #2 (SUB-TASK A): the live-stream connection state, surfaced as a small
  // status chip so a dropped stream is never silent. 'connecting' is the brief pre-open gap;
  // 'open' is healthy (no chip shown — the 4s poll backstop also covers it); 'reconnecting'
  // is a transient drop where EventSource is retrying (amber); 'lost' is a prolonged outage
  // where we've given up auto-recovering this socket (red — the poll backstop still runs).
  // The chip is gated on isLiveRun, so a finished run never shows one.
  // The EventSource + the 10s lost-escalation TIMER + the React state cell are owned by the
  // ./hooks/useLiveStream.ts hook (the pure (prev, event) → next reducer lives in
  // ./live-connection.ts, unit-tested without a browser); App just reads the connection state.
  const liveConnectionState = useLiveStream({
    isLiveRun,
    slug: liveSlug,
    session: liveSession,
    runId: liveRunId,
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
    // UIBUG-2: available in BOTH views when a run is focused (the Plan view reuses it as the
    // blueprint for an ad-hoc run whose workflow is not a declared `.js`).
    enabled: !!summary,
    queryFn: () => fetchRunPlan(summary!.ref),
  });
  const runPlan = runPlanQ.data;

  // UIBUG-2: when the focused run's workflow is NOT a declared .js (an inline `script`
  // workflow), the Plan toggle would fall back to a DIFFERENT workflow. Show the run's OWN
  // plan (the per-run PlanModel, already fetched for the morph) as the Plan blueprint so
  // Plan and Run correspond.
  const { plan: effectivePlan, usePerRun: usePerRunPlanForPlanView, focusedHasDeclaredWorkflow } =
    pickPlanSource({ view, summary, workflows, runPlan, declaredPlan: plan });

  const run = runQ.data;

  // The run/plan graph-build pipeline lives in ./hooks/useRunGraph.ts: the Plan-AST + Run-morph
  // elk layouts, the live-fill transcript fetch, the morph paint+expand, and the LLM caption
  // polls. App owns the run query + selection state and passes them in; the hook returns the
  // rendered graph, the open detail node (a table-row's synthetic card wins over a canvas id),
  // the Plan⟷Execution `overlay` (App reads its binding counts for the header + reseeds the
  // expand set from it on run-change, below), the planIsAst flag, and the layout-error flag.
  const { graph, selectedNode, overlay, planIsAst, overlayError } = useRunGraph({
    view,
    effectivePlan,
    runPlan,
    run,
    summary,
    usePerRunPlanForPlanView,
    workflow,
    project,
    unrolled,
    expandedNodeIds,
    loopDrillMode,
    loopDrawerRound,
    tableAgentId,
    hoveredAgentId,
    selectedNodeId,
  });

  // --- Merged Run view: RESET + SEED expandedNodeIds on run change (run-view-merge-plan.md
  //     §2 + STEP 3 inline-expand). The expand set is reset whenever the selected run identity
  //     changes, then seeded ONCE so every subagent is visible by default: we default-expand
  //     ALL fanned steps (bindings that bound >1 agent) for BOTH running and finished runs.
  //     This is bounded by EXPAND_BUDGET — fans are opened SMALLEST-first and we stop once the
  //     running instance total would exceed the cap, so a single huge fan (e.g. 50 agents)
  //     stays collapsed (aggregate chip) instead of exploding the canvas. Seeded only ONCE per
  //     run (keyed on a ref), so live SSE re-paints never re-derive it and fight a user who
  //     manually collapsed a drawer (Risk 1). User-owned thereafter via toggle. ---
  const runIdentityKey = summary
    ? `${summary.ref.slug}/${summary.ref.sessionId}/${summary.ref.runId}`
    : null;
  const seededRunKey = useRef<string | null>(null);
  useEffect(() => {
    // A different run is now selected → drop any open drawers immediately (then re-seed once
    // the overlay for the new run is ready, below).
    if (seededRunKey.current !== runIdentityKey) {
      setExpandedNodeIds(new Set());
      setSelectedRound(null); // a loop round scope never carries across runs
      setLoopDrawerRound(new Map()); // nor does an open in-loop round drawer (option 2)
      setTableAgentId(null); // nor does a table-row selection from the previous run
      setHoveredAgentId(null); // nor a stale table-row hover highlight
      seededRunKey.current = null;
    }
    if (runIdentityKey == null || !overlay) return; // wait until the overlay is built
    if (seededRunKey.current === runIdentityKey) return; // already seeded for this run
    // Seed: expand every fanned step (agentIds.length > 1), running or finished, but bounded
    // by EXPAND_BUDGET. Open the SMALLEST fans first so the budget surfaces the most fans; once
    // adding the next fan would blow the cap, stop and leave the remaining (larger) fans
    // collapsed. (A 0/1-instance binding is not a fan and is never seeded.)
    const fans = overlay.bindings
      .filter((b) => b.agentIds.length > 1)
      .sort((a, b) => a.agentIds.length - b.agentIds.length);
    const seed = new Set<string>();
    let used = 0;
    for (const b of fans) {
      if (used + b.agentIds.length > EXPAND_BUDGET) break; // budget hit → leave bigger fans collapsed
      seed.add(b.planNodeId);
      used += b.agentIds.length;
    }
    setExpandedNodeIds(seed);
    seededRunKey.current = runIdentityKey;
  }, [runIdentityKey, overlay]);

  // fitView (U1 cosmetic fix): the `fitView` PROP only fits on mount, so the async
  // Plan-AST graph (which replaces the meta-only graph after elk resolves) was never
  // refit — leaving it off-center with the rightmost phase lane clipped. Capture the
  // instance and refit whenever the graph's node SET changes (a topology swap), keyed by
  // a cheap signature so caption-only (PX) overlays — which never change ids — do NOT
  // refit and yank the viewport.
  const rfRef = useRef<ReactFlowInstance | null>(null);
  // FREEZE the structural fit to the PLAN node set only (run-view-merge-plan.md §2 "Refit on
  // a live tick: NEVER"): exclude the merged Run view's drawer (`instanceGroup`) + instance
  // (`agentCard`) ids, so a live instance spawning / a ghost vanishing / a drawer
  // opening never re-triggers the structural fit and yanks the viewport. Expand churn is
  // handled by the SEPARATE one-shot fitBounds effect below.
  // SUB-TASK C: the structural signature is computed by the pure `computeFitSignature` helper
  // (unit-tested in fit-signature.test.ts). It includes the selected runId so switching runs
  // re-fits (the chrome — objective/failure — changes per run); runId is stable DURING a run AND
  // across a live→finalized swap (the run query key is now suffix-free), so neither a live tick
  // nor finalize re-fits and yanks the viewport.
  const fitSignature = useMemo(
    () => computeFitSignature(view, summary?.ref.runId, graph.nodes),
    [view, summary?.ref.runId, graph.nodes],
  );
  // The four canvas FIT effects (the structural plan-id refit + the one-shot expand / loop-drawer
  // / table-toggle fits) live in ./hooks/useChromeFit.ts. Each stays an INDEPENDENT effect keyed
  // on its OWN distinct trigger (fitSignature → expandedNodeIds → loopDrawerRound → tableOpen), so
  // a live re-paint (which churns graph.nodes) never re-fits and yanks the viewport. Deps threaded
  // in explicitly; the hook reads only graph.nodes.length as the guard.
  useChromeFit({
    rfRef,
    fitSignature,
    expandedNodeIds,
    loopDrawerRound,
    tableOpen,
    graphNodes: graph.nodes,
  });

  // --- M4 selection handlers (mutate the shared state, not the canvas). ---
  // Picking a project re-scopes everything: clear the dependent run + workflow choice
  // so the new project's defaults take over via its (re-keyed) queries.
  function handleSelectProject(p: ProjectRef) {
    setSelectedProjectPath(p.projectPath);
    setSelectedRunId(null);
    setSelectedWorkflowName(null);
  }
  // R2: selection is UNIFIED across both views. Picking a run drives the Run view AND syncs
  // the Plan workflow to the run's workflow, so Plan/Run both describe the SAME workflow
  // (no more "Plan shows X while Run shows Y").
  function handleSelectRun(r: RunSummary) {
    setSelectedRunId(r.ref.runId);
    setSelectedWorkflowName(r.workflowName);
    // run-view-merge-plan.md §1/§2: BOTH running and finished runs land on the merged `run`
    // view. A running run auto-expands its active fan(s); a finished run rests collapsed
    // (aggregate chips). The old running→overlay / finished→execution split WAS the bug the
    // merge removes. The reset+seed of expandedNodeIds is handled by the run-change effect.
    setView('run');
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
    (!!project && view === 'run' && runsQ.isPending) ||
    (!!summary && view === 'run' && runQ.isPending) ||
    (!!summary && view === 'run' && runPlanQ.isPending) ||
    (!!project && view === 'plan' && workflowsQ.isPending) ||
    // UIBUG-2: in the Plan view with a focused UNDECLARED-workflow run, the per-run plan is the
    // blueprint — wait for it rather than briefly flashing the wrong (default) workflow's plan.
    (view === 'plan' && !!summary && !focusedHasDeclaredWorkflow && runPlanQ.isPending);

  const hasContent =
    view === 'plan'
      ? usePerRunPlanForPlanView
        ? !!runPlan
        : !!workflow
      : !!run && !!runPlan;

  // Header: in AST mode show the real node/edge counts + coverage + the derivation tag.
  // UIBUG-2: read the EFFECTIVE plan so the header count matches what the Plan view renders
  // (the per-run plan for an ad-hoc run, else the declared-workflow plan).
  const planNodeCount = effectivePlan?.nodes.length ?? 0;
  const planDerived = planIsAst ? 'AST' : 'declared';
  // Honest plan-parse signal (boundaries §honesty): the adapter reports how much of the plan
  // SOURCE it actually parsed (coverageRatio) + any parse warnings; surface a calm badge when
  // an AST plan came back degraded so a partial/meta-only parse is VISIBLE, not silent.
  const planWarnings = effectivePlan?.warnings ?? [];
  const planCoverage = effectivePlan?.coverageRatio;
  const planDegraded = planIsAst && isDegraded(planCoverage, planWarnings);
  const planCoverageBadgeLabel = planCoverageLabel(planCoverage, planWarnings);
  const planCoverageBadgeTitle = planCoverageTitle(planCoverage, planWarnings);

  // P2 overlay header summary: bound / partial / planned-not-run / unplanned counts.
  const overlayBound = overlay?.bindings.filter((b) => b.status !== 'not-run').length ?? 0;
  const overlayNotRun = overlay?.bindings.filter((b) => b.status === 'not-run').length ?? 0;
  const overlayPartial = overlay?.bindings.filter((b) => b.status === 'partial').length ?? 0;
  const overlayUnplanned = overlay?.unplannedAgentIds.length ?? 0;
  const overlayRounds = overlay?.rounds ?? null;

  // STEP 3: the failure banner content (null unless the selected run failed). Drives both the
  // Run-view banner and the per-instance failure-point ring (the dead agentIds).
  const failureInfo = useMemo(() => (view === 'run' ? deriveFailureInfo(run) : null), [view, run]);
  // Canvas-views chrome: the project-wide "what's alive" count (NOW strip) + the selected run's
  // human-readable objective (the workflow's stated purpose) for the objective band.
  const nowRunning = useMemo(() => runs.filter((r) => r.status === 'running').length, [runs]);
  const runObjective = useMemo(
    () => (run ? workflows.find((w) => w.name === run.workflowName)?.description ?? null : null),
    [run, workflows],
  );

  // The runs that belong to the CURRENT workflow — newest-first. SAME data + rows feed BOTH
  // placements of <RunHistory>: the Run-view selector drawer AND the Plan-view run-history band
  // (run-view-merge-plan §7b: a plan has many runs, so the Plan view is the workflow overview).
  // The "current workflow" is the selected run's workflow in the Run view, else the selected
  // workflow's name in the Plan view. RunHistory re-sorts newest-first internally, but we sort
  // here too so the surrounding component always sees a stable, newest-first list.
  const currentWorkflowName =
    view === 'run'
      ? run?.workflowName ?? null
      : usePerRunPlanForPlanView
        ? summary?.workflowName ?? null
        : workflow?.name ?? null;
  const workflowRuns = useMemo(() => {
    if (!currentWorkflowName) return [];
    return runs
      .filter((r) => r.workflowName === currentWorkflowName)
      .sort((a, b) => (b.startTime ?? -Infinity) - (a.startTime ?? -Infinity));
  }, [runs, currentWorkflowName]);

  // run-detail-plan §1.1: close the run SELECTOR drawer on an outside click (a pick already
  // closes it via the handler). Bound only while open so the listener is cheap.
  useEffect(() => {
    if (!runSelectorOpen) return;
    const onDown = (e: MouseEvent) => {
      if (runSelectorRef.current && !runSelectorRef.current.contains(e.target as Node)) {
        setRunSelectorOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [runSelectorOpen]);

  return (
    <div className="argus-app">
      {/* M4: collapsible left rail — in-flow so it PUSHES the canvas aside (not an overlay). */}
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
        loopDrillMode={loopDrillMode}
        onSelectLoopDrillMode={setLoopDrillMode}
        // The loop-drill mode only has a visible effect when the active RUN view has a loop that
        // ran >1 round (→ a round axis to unroll + drill). Tell the Rail so it can flag the
        // setting as inert (rather than reading as broken) when there's nothing to drill.
        loopDrillable={view === 'run' && overlayRounds != null && overlayRounds > 1}
      />
      {/* everything right of the rail lives here so overlays center on the CANVAS, not the viewport */}
      <div className="argus-main">
      {/* Merged Run view: the expand caret on a fanned PlanAgentNode reaches `toggle(id)`
          through this provider (NOT a fn on node.data, which would break memo). */}
      <ExpandContext.Provider value={expandContextValue}>
      <ReactFlow
        onInit={(inst) => {
          rfRef.current = inst;
        }}
        nodes={graph.nodes}
        edges={graph.edges}
        nodeTypes={nodeTypes}
        colorMode="dark"
        fitView
        fitViewOptions={{ padding: { top: '110px', left: '88px', right: '40px', bottom: '40px' }, maxZoom: 2.6 }}
        minZoom={0.1}
        maxZoom={3}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        onNodeClick={(_, n) => {
          setSelectedNodeId(n.id);
          setSelectedRound(null); // a plain node click clears any loop round-axis scope
          setOverviewOpen(false); // node detail takes precedence over the run overview
        }}
        onPaneClick={() => {
          setSelectedNodeId(null);
          setSelectedRound(null);
          setOverviewOpen(false);
          setTableAgentId(null);
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
        <MiniMap pannable zoomable />
        <Controls
          showInteractive={false}
          onFitView={() => rfRef.current?.fitView(chromeAwareFitOptions())}
        />
      </ReactFlow>
      </ExpandContext.Provider>

      {/* Plan ⟷ Run. TWO views, one graph (run-view-merge-plan.md §1): Plan = the design;
          Run = the SAME plan painted with this run's status, where clicking a fanned step
          expands it in-place into its agent instance cards. Progress + Execution merged into
          one Run view, joining the aggregate↔instance view by a click instead of a tab. */}
      <div className="view-toggle" role="group" aria-label="view mode">
        <button
          type="button"
          className={`view-toggle-btn${view === 'plan' ? ' is-active' : ''}`}
          aria-pressed={view === 'plan'}
          onClick={() => setView('plan')}
          title="The design — what this workflow is built to do (parsed from the code). No run."
        >
          Plan
        </button>
        <button
          type="button"
          className={`view-toggle-btn${view === 'run' ? ' is-active' : ''}`}
          aria-pressed={view === 'run'}
          onClick={() => setView('run')}
          title="The plan painted with this run — done · running · upcoming · failed. Click a fanned step to see its agents."
        >
          Run
        </button>
      </div>
      {/* The always-visible one-liner that says what the current view IS. */}
      <div className="view-caption" role="note">
        {view === 'plan'
          ? 'the design — what this workflow is built to do'
          : 'the plan, painted with this run — done · running · upcoming · failed · click a fanned step to see its agents'}
      </div>

      {/* P2 folded↔unrolled MODE switch — shown only when the run observed loop rounds. */}
      {view === 'run' && overlayRounds != null && overlayRounds > 1 ? (
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

      {view === 'plan' && (workflow || usePerRunPlanForPlanView) ? (
        <>
        <div className="run-header">
          {/* UIBUG-2: an ad-hoc run's plan has no declared workflow to pick — show its OWN name
              (currentWorkflowName) and hide the workflow picker (switching would leave the per-run
              plan). The normal declared-workflow path keeps the picker. */}
          {usePerRunPlanForPlanView ? (
            <span className="run-header-name">{currentWorkflowName ?? 'plan'}</span>
          ) : workflows.length > 1 ? (
            <select
              className="wf-picker"
              value={workflow!.name}
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
            <span className="run-header-name">{workflow!.name}</span>
          )}
          <span className="run-badge run-badge-plan">plan</span>
          <span className="run-header-meta">
            {planIsAst
              ? `${planNodeCount} ${planNodeCount === 1 ? 'node' : 'nodes'} · ${planDerived}`
              : `${workflow?.phases.length ?? 0} ${(workflow?.phases.length ?? 0) === 1 ? 'phase' : 'phases'} · declared`}
          </span>
          {/* Honest plan-parse signal: only an AST plan that came back degraded (partial source
              coverage or a parse warning) shows this calm badge; a clean parse stays silent. */}
          {planDegraded ? (
            <span className="run-badge run-badge-warning" title={planCoverageBadgeTitle}>
              ⚠ {planCoverageBadgeLabel}
            </span>
          ) : null}
        </div>
        {/* Plan = the workflow OVERVIEW (run-view-merge-plan §7b): the design + its run
            history. Clicking a run selects it (handleSelectRun also switches to the Run view). */}
        <div className="plan-run-history">
          {workflowRuns.length > 0 ? (
            <RunHistory
              runs={workflowRuns}
              selectedRunId={summary?.ref.runId}
              onSelectRun={handleSelectRun}
              title={`${workflowRuns.length} ${workflowRuns.length === 1 ? 'run' : 'runs'}`}
            />
          ) : (
            <div className="plan-run-history-empty">no runs yet for this workflow</div>
          )}
        </div>
        </>
      ) : view === 'run' && run ? (
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
          {/* run-detail-plan §1.1: the run SELECTOR — a compact chip (this run's relative time
              + a caret) that opens a dropdown of THIS workflow's runs (<RunHistory>) so the user
              can switch between runs of the same plan without leaving the Run view. Only shown
              when this workflow has more than one run (otherwise there's nothing to pick). */}
          {workflowRuns.length > 1 ? (
            <div className="run-selector" ref={runSelectorRef}>
              <button
                type="button"
                className={`run-selector-chip${runSelectorOpen ? ' is-open' : ''}`}
                aria-haspopup="listbox"
                aria-expanded={runSelectorOpen}
                onClick={() => setRunSelectorOpen((v) => !v)}
                title="switch to another run of this workflow"
              >
                <span className="run-selector-time">{formatRelativeTime(run.startTime) || 'this run'}</span>
                <span className="run-selector-caret" aria-hidden="true">{runSelectorOpen ? '▴' : '▾'}</span>
              </button>
              {runSelectorOpen ? (
                <div className="run-selector-drawer" role="listbox">
                  <RunHistory
                    runs={workflowRuns}
                    selectedRunId={summary?.ref.runId}
                    onSelectRun={(r) => {
                      handleSelectRun(r);
                      setRunSelectorOpen(false);
                    }}
                    title={currentWorkflowName ?? 'runs'}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
          <span className="run-header-meta">
            {overlayBound} bound
            {overlayPartial > 0 ? ` · ${overlayPartial} partial` : ''}
            {overlayNotRun > 0 ? ` · ${overlayNotRun} planned-not-run` : ''}
            {overlayUnplanned > 0 ? ` · ${overlayUnplanned} unplanned` : ''}
            {overlayRounds != null ? ` · ${overlayRounds} loop rounds` : ''}
          </span>
          {/* Honest run-degradation signal (boundaries §honesty): the adapter records WHY a run
              read back degraded (a dropped phase, an unresolved binding, a torn journal, …) as
              coded warnings. Surface a calm chip so the degradation is VISIBLE; the full list +
              codes live in the RunOverviewPanel (opened from the run name). Silent when clean. */}
          {run.warnings.length > 0 ? (
            <span
              className="run-badge run-badge-warning"
              title={summarizeWarningCodes(run.warnings)}
            >
              ⚠ {warningCountLabel(run.warnings)}
            </span>
          ) : null}
          {run.partialFailure.present ? (
            <span className="run-badge run-badge-partial" title={run.partialFailure.lines[0] ?? ''}>
              partial failure
            </span>
          ) : null}
          {/* NOW strip: the project-wide "what's alive" signal (chrome, not a mode). */}
          {nowRunning > 0 ? (
            <span className="run-now" title={`${nowRunning} run${nowRunning === 1 ? '' : 's'} in progress in this project`}>
              <span className="run-now-dot" aria-hidden="true" />
              {nowRunning} running
            </span>
          ) : null}
          {/* Live & inspection #2 (SUB-TASK A): the live-stream connection chip. Only shown for
              a LIVE run AND only when the stream is NOT healthy — a healthy 'open' (or the
              brief 'connecting' gap) stays silent, so the chip is a pure alert: amber while
              EventSource retries, red once a long outage means the live feed is paused. */}
          {isLiveRun && (liveConnectionState === 'reconnecting' || liveConnectionState === 'lost') ? (
            <span
              className={`live-conn live-conn-${liveConnectionState}`}
              role="status"
              title={
                liveConnectionState === 'reconnecting'
                  ? 'the live stream dropped — reconnecting; the view still polls as a backstop'
                  : 'the live stream is paused — the view falls back to a slow poll for updates'
              }
            >
              <span className="live-conn-dot" aria-hidden="true" />
              {liveConnectionState === 'reconnecting' ? 'reconnecting' : 'live paused'}
            </span>
          ) : null}
          {formatElapsed(run.durationMs) ? (
            <span className="run-header-elapsed" title="run duration">
              {formatElapsed(run.durationMs)}
            </span>
          ) : null}
          {/* "Table panel" toggle: open the collapsible bottom AGENT TABLE — the at-scale
              scanning surface (sort/filter by cost/time/tools/status to find the outlier).
              Run-view + run-loaded only (this header only renders then). */}
          {run.agents.length > 0 ? (
            <button
              type="button"
              className={`run-header-table-btn${tableOpen ? ' is-active' : ''}`}
              aria-pressed={tableOpen}
              onClick={() => setTableOpen((v) => !v)}
              title="agent table — sort/filter this run's agents by cost, time, tools, or status"
            >
              ▦ table
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Run-view chrome below the run-header (stacks via flex): the run's human-readable
          OBJECTIVE + what data it ran on (run.args), then the failure banner when it failed. */}
      {view === 'run' && run ? (
        <div className="run-chrome">
          <RunObjective objective={runObjective} args={run.args} />
          {failureInfo ? <FailureBanner info={failureInfo} /> : null}
        </div>
      ) : null}

      {/* P2: unplanned agents (label matched no plan node) surfaced honestly. */}
      {view === 'run' && overlayUnplanned > 0 ? (
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
                  : !summary
                    ? 'no runs found in ~/.claude'
                    : overlayError
                      ? 'could not lay out this run’s plan'
                      : 'no plan source found for this run'}
          </div>
        </div>
      ) : null}

      {/* "Table panel" (roadmap · M): the collapsible bottom AGENT TABLE. Run-view + run-loaded
          only; clicking a row selects that agent (synthetic node → DetailPanel). Sort/filter is
          local to the panel (pure view lens) — it never relayouts the canvas. */}
      {view === 'run' ? (
        <AgentTablePanel
          open={tableOpen}
          run={run ?? null}
          selectedAgentId={tableAgentId}
          hoveredAgentId={hoveredAgentId}
          onHoverAgent={setHoveredAgentId}
          onClose={() => {
            setTableOpen(false);
            setHoveredAgentId(null); // drop any lingering hover glow when the table collapses
          }}
          onSelectAgent={(agent) => {
            setTableAgentId(agent.agentId);
            setSelectedNodeId(null); // the synthetic table node wins; drop any canvas node id
            setSelectedRound(null);
            setOverviewOpen(false); // node detail takes precedence over the run overview
          }}
        />
      ) : null}

      {/* I1: node detail panel (right side), filled instantly from the clicked node's data. */}
      <DetailPanel
        node={selectedNode}
        runRef={summary ? { slug: summary.ref.slug, sessionId: summary.ref.sessionId, runId: summary.ref.runId } : null}
        selectedRound={selectedRound}
        onClose={() => {
          setSelectedNodeId(null);
          setSelectedRound(null);
          setTableAgentId(null); // also clear a table-row selection
        }}
      />
      {/* I3: run overview (logs timeline) — only when no node is selected (node wins). */}
      {!selectedNode && overviewOpen ? (
        <RunOverviewPanel
          run={run ?? null}
          runRef={summary ? { slug: summary.ref.slug, sessionId: summary.ref.sessionId, runId: summary.ref.runId } : null}
          onClose={() => setOverviewOpen(false)}
        />
      ) : null}
      </div>
    </div>
  );
}
