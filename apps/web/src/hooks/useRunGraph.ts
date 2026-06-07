// @argus/web — useRunGraph: the run/plan GRAPH-BUILD PIPELINE, lifted out of App.tsx so the
// component shrinks to chrome + state and the (heaviest, most-interdependent) layout logic
// lives in one focused, separately-readable file. BEHAVIOR-PRESERVING: every memo/effect below
// is moved verbatim from App — same inputs, same dependency arrays, same outputs — so the graph
// it returns is byte-identical to the inline version.
//
// WHAT IT OWNS (all internal, none leaks to App):
//   - the Plan-AST elk layout (astGraph) + the Run-view morph elk layout (overlayBaseGraph),
//     each a lazily-loaded elk pass guarded by view + a "is this plan rich enough" flag;
//   - the per-agent LIVE FILL fetch (useLiveAgentFill) that fills a running run's instance
//     cards with transcript metrics the journal lacks — internal here because it ONLY feeds
//     the pipeline (overlayGraph + the synthetic table-selected card);
//   - the paint+expand morph (paintOverlay → expandInstances → expandLoopDrawer) that turns
//     the laid-out plan into the painted, drawer-expanded Run graph;
//   - the LLM caption polls (usePlanExplanations / useRunExplanations) + their overlay.
//
// WHAT IT RETURNS (the only surface App consumes):
//   - graph         : the final GraphResult React Flow renders;
//   - selectedNode  : the open detail node (a table-row's synthetic card wins over a canvas id);
//   - overlay       : the Plan⟷Execution join — App reads its binding counts for the header and
//                     re-seeds the expand set on run-change from it;
//   - planIsAst     : whether the Plan view is showing the rich AST plan (drives the header tag
//                     + the caption poll enable);
//   - overlayError  : the Run-view layout fell back (elk threw) — drives the empty-state copy.
//
// WHAT STAYS IN App: `run = runQ.data` (App owns the query), the run-change reset/seed effect
// (it mutates App-owned selection state and reads `overlay` from here), and `failureInfo` for
// the banner. The seed effect setting `expandedNodeIds` → App re-renders → this hook recomputes
// with the new set: identical to the previous single-component cross-render flow.

import { useEffect, useMemo, useState } from 'react';
import type { Node as FlowNode } from '@xyflow/react';
import type {
  Overlay,
  PlanModel,
  ProjectRef,
  RunModel,
  RunSummary,
  WorkflowMeta,
} from '@argus/contract';
import type { GraphResult } from '../mapping.ts';
import { agentToCardData, runModelToGraph } from '../mapping.ts';
import { planMetaToGraph } from '../plan-mapping.ts';
import { planModelToGraph } from '../plan-model-mapping.ts';
import { buildOverlay } from '../overlay.ts';
import { paintOverlay } from '../overlay-paint.ts';
import { expandInstances } from '../overlay-expand.ts';
import { expandLoopDrawer } from '../overlay-loop-expand.ts';
import { useLiveAgentFill } from '../live-agent-fill.ts';
import { overlayExplanations, usePlanExplanations, useRunExplanations } from '../explanations.ts';
import { loadElkLayout } from '../layout/index.ts';
import { deriveFailureInfo } from '../failure-info.ts';
import type { LoopDrillMode } from '../expand-context.ts';

const EMPTY_GRAPH: GraphResult = { nodes: [], edges: [] };

export interface UseRunGraphArgs {
  /** The active canvas view. */
  view: 'plan' | 'run';
  /** The PlanModel the Plan view should render (per-run for ad-hoc runs, else declared). */
  effectivePlan: PlanModel | null | undefined;
  /** The selected run's per-run PlanModel (the Run-view morph template). */
  runPlan: PlanModel | null | undefined;
  /** True while the per-run plan query is still in flight — gates the plan-less fallback so a
   *  scripted run doesn't flash the agents-by-phase fallback before its plan resolves. */
  runPlanPending: boolean;
  /** The selected run model (App owns the query; undefined while it loads). */
  run: RunModel | undefined;
  /** The focused run summary (carries the ref used for the live-fill + caption fetches). */
  summary: RunSummary | null | undefined;
  /** True iff the Plan view is substituting the per-run plan for an ad-hoc run. */
  usePerRunPlanForPlanView: boolean;
  /** The selected workflow (Plan-view meta-graph source + caption poll join key). */
  workflow: WorkflowMeta | undefined;
  /** The selected project (caption poll slug). */
  project: ProjectRef | undefined;
  /** The folded↔unrolled loop-round mode. */
  unrolled: boolean;
  /** The host template node ids whose instance drawer is open. */
  expandedNodeIds: Set<string>;
  /** The loop-drill display mode (round-axis vs in-canvas lane-drawer). */
  loopDrillMode: LoopDrillMode;
  /** OPTION 2: loopNodeId → open round, for the in-loop lane-drawer. */
  loopDrawerRound: Map<string, number>;
  /** The SELECTED table-row agent (persistent; opens the synthetic detail card). */
  tableAgentId: string | null;
  /** The HOVERED table-row agent (transient cross-highlight only). */
  hoveredAgentId: string | null;
  /** The open canvas detail node id (resolved against the live graph). */
  selectedNodeId: string | null;
}

export interface UseRunGraphResult {
  /** The final graph React Flow renders. */
  graph: GraphResult;
  /** The open detail node (table-row synthetic card wins over a canvas-node id). */
  selectedNode: FlowNode | null;
  /** The Plan⟷Execution join (null when no run/plan) — App reads binding counts + reseeds from it. */
  overlay: Overlay | null;
  /** Whether the rich AST plan is showing (drives header tag + caption poll enable). */
  planIsAst: boolean;
  /** The Run-view layout fell back (elk threw) — drives the empty-state copy. */
  overlayError: boolean;
}

/**
 * Build the run/plan graph. See the file header for the full ownership contract. Every memo and
 * effect below is moved verbatim from App.tsx with identical dependency arrays.
 */
export function useRunGraph({
  view,
  effectivePlan,
  runPlan,
  runPlanPending,
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
}: UseRunGraphArgs): UseRunGraphResult {
  // --- AST-mode layout: when the PlanModel is rich (static-source), lay it out with
  //     elkjs (lazily loaded). The P0 meta-only planMetaToGraph is the RUN-FREE FALLBACK
  //     used on derivedFrom==='meta-only' OR any /plan fetch error. ---
  const useAstMode = !!effectivePlan && effectivePlan.derivedFrom === 'static-source' && effectivePlan.nodes.length > 0;

  const [astGraph, setAstGraph] = useState<GraphResult>(EMPTY_GRAPH);
  const [astError, setAstError] = useState(false);
  useEffect(() => {
    if (view !== 'plan' || !useAstMode || !effectivePlan) {
      setAstGraph(EMPTY_GRAPH);
      setAstError(false);
      return;
    }
    let cancelled = false;
    setAstError(false);
    (async () => {
      try {
        const elk = await loadElkLayout();
        const graph = await planModelToGraph(effectivePlan as PlanModel, elk);
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
  }, [view, useAstMode, effectivePlan]);

  // --- STEP 2 (live fill): eagerly fetch the per-agent transcript metrics a LIVE run's
  //     journal lacks (dur/tok/tools/label), polled on the live tick, so the instance cards
  //     show real numbers instead of em-dashes BEFORE you click each one. Returns a STABLE
  //     empty map (and fetches nothing) for a finished run — their cards fill from the
  //     finalized model and must stay byte-unchanged. Merged into the card build below
  //     (expandInstances → agentToCardData); the layout arithmetic is unaffected. ---
  const liveFill = useLiveAgentFill(
    summary ? { slug: summary.ref.slug, sessionId: summary.ref.sessionId, runId: summary.ref.runId } : null,
    run,
  );

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
    if (view !== 'run' || !overlayLayoutReady || !runPlan) {
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

  // Paint (data-only), THEN expand any open fan-out drawers in-place. paintOverlay stays
  // pure (no relayout); expandInstances is the ELK-free arithmetic re-flow layered on top
  // (run-view-merge-plan.md §2). The folded↔unrolled toggle still only re-paints; a drawer
  // open/close re-runs expandInstances off the same `expandedNodeIds` Set.
  const overlayGraph = useMemo(() => {
    if (view !== 'run' || overlayBaseGraph.nodes.length === 0 || !overlay || !run) return EMPTY_GRAPH;
    // R8b: a live (incomplete) run paints "upcoming"/"running" instead of "planned·not-run".
    const live = run.incomplete;
    // Table cross-highlight (data-only): a COLLAPSED fan's template is marked here if its
    // bindAgentIds aggregates the selected/hovered table agent (an EXPANDED fan marks the
    // instance card in expandInstances instead). No relayout — just a node.data patch.
    const painted = paintOverlay(
      overlayBaseGraph,
      overlay,
      unrolled,
      live,
      tableAgentId,
      hoveredAgentId,
    );
    // STEP 3: the dead/last-started agentIds → the failing INSTANCE card (in an expanded drawer)
    // reads as the failure point; and a single-agent (non-fanned) step is marked on its painted
    // PLAN node here, so a failed run never shows the failing step as a clean "done".
    const failureAgentIds = deriveFailureInfo(run)?.failureAgentIds;
    // STEP 2: thread the live transcript fill into the instance-card build. Empty for a finished
    // run (so its cards stay byte-unchanged); for a live run it replaces a running agent's
    // em-dashed dur/tok/tools/label with the real transcript-derived values.
    let expanded = expandInstances(
      painted,
      overlay,
      run,
      expandedNodeIds,
      live,
      failureAgentIds,
      liveFill,
      tableAgentId,
      hoveredAgentId,
    );
    // OPTION 2 (lane-drawer inside the loop): when the loop-drill setting is 'lane-drawer' AND a
    // round drawer is open AND the loop is unrolled, draw that round's agents as cards inside the
    // loop compound (the back-edge re-routes around them). In 'round-axis' mode (the default) this
    // is a no-op — option 1's round-axis → DetailPanel drill is unchanged. The flat-fan
    // lane-drawer above (expandInstances) is untouched in both modes.
    if (loopDrillMode === 'lane-drawer' && unrolled && loopDrawerRound.size > 0) {
      expanded = expandLoopDrawer(expanded, overlay, run, loopDrawerRound, failureAgentIds);
    }
    if (!failureAgentIds || failureAgentIds.size === 0) return expanded;
    return {
      ...expanded,
      nodes: expanded.nodes.map((n) => {
        const ids = (n.data as { bindAgentIds?: string[] } | undefined)?.bindAgentIds;
        return Array.isArray(ids) && ids.some((id) => failureAgentIds.has(id))
          ? { ...n, data: { ...n.data, failurePoint: true } }
          : n;
      }),
    };
  }, [view, overlayBaseGraph, overlay, unrolled, run, expandedNodeIds, loopDrillMode, loopDrawerRound, liveFill, tableAgentId, hoveredAgentId]);

  const metaGraph = useMemo(() => {
    if (view !== 'plan') return EMPTY_GRAPH;
    // UIBUG-2: for an ad-hoc run's per-run plan there is NO declared workflow to fall back to —
    // `workflow` here is the WRONG (default) workflow, so never meta-graph it.
    if (usePerRunPlanForPlanView) return EMPTY_GRAPH;
    return workflow ? planMetaToGraph(workflow) : EMPTY_GRAPH;
  }, [view, workflow, usePerRunPlanForPlanView]);

  // Plan-less RUN fallback (AV4): a run whose per-run plan resolved to nothing the morph can paint
  // — a SCRIPTLESS run (no persisted `.js`, so no static-source plan), a meta-only plan, or an elk
  // failure — has no template to morph onto. Render its agents grouped by phase straight from the
  // RunModel (runModelToGraph, hand-rolled jitter-free layout, NO elk) so the Run view shows the run
  // instead of a blank canvas. Gated on the plan query having SETTLED (!runPlanPending) so a scripted
  // run never flashes this fallback while its plan loads; while elk is merely PENDING for a real plan
  // (overlayLayoutReady && !overlayError) we wait rather than fall back.
  const runFallbackGraph = useMemo(() => {
    if (view !== 'run' || !run || runPlanPending) return EMPTY_GRAPH;
    if (overlayLayoutReady && !overlayError) return EMPTY_GRAPH; // a real plan is laying out — wait for it
    return runModelToGraph(run);
  }, [view, run, runPlanPending, overlayLayoutReady, overlayError]);

  // The AST plan is used when available AND elk succeeded; else the meta-only fallback.
  const planIsAst = view === 'plan' && useAstMode && !astError && astGraph.nodes.length > 0;
  const baseGraph: GraphResult =
    view === 'run'
      ? overlayGraph.nodes.length > 0
        ? overlayGraph
        : runFallbackGraph
      : planIsAst
        ? astGraph
        : metaGraph;

  // --- PX: poll per-node LLM captions in the background and swap them into the existing
  //     subtitle/caption slots when ready. Annotation-only: topology is untouched. The
  //     plan poll keys on the selected workflow file. The poll only runs in the Plan view;
  //     the merged Run view paints onto the PLAN node ids (≠ agentIds), so run captions have
  //     no join target there (the prior `overlay` mode never joined them either). When
  //     `claude` is absent the batch is engine-unavailable/all-baseline and the overlay is a
  //     no-op. ---
  const planExplanations = usePlanExplanations(
    project?.slug,
    workflow?.file,
    // UIBUG-2: an ad-hoc run's per-run plan has no `workflow.file` join key (the LLM caption
    // poll keys on the declared workflow file) — disable the poll for it.
    view === 'plan' && planIsAst && !usePerRunPlanForPlanView,
  );
  // Run-view PX captions are not joined (painted plan node ids ≠ agentIds); keep the hook
  // call present (hooks must be unconditional) but inert.
  useRunExplanations(
    summary ? { slug: summary.ref.slug, sessionId: summary.ref.sessionId, runId: summary.ref.runId } : undefined,
    false,
  );
  const graph: GraphResult = useMemo(() => {
    if (planIsAst) return overlayExplanations(baseGraph, planExplanations);
    // Run view: the base graph is already painted with run status + any expanded drawers;
    // PX captions are not joined here (the painted plan node ids ≠ agentIds). meta-only
    // plan: lanes carry their declared subtitle already.
    return baseGraph;
  }, [planIsAst, baseGraph, planExplanations]);

  // "Table panel": a table-row selection resolves to a SYNTHETIC `agentCard` node built from the
  // run's AgentNode (the same shape the canvas instance cards carry, via agentToCardData) so the
  // DetailPanel's exec-agent path lights up — even when the agent's fan is collapsed on the
  // canvas (so there is no graph node to click). It carries the failure-point flag so a dead
  // agent reads consistently. Takes precedence over a canvas node selection below.
  const tableSelectedNode = useMemo(() => {
    if (!tableAgentId || !run) return null;
    const agent = run.agents.find((a) => a.agentId === tableAgentId);
    if (!agent) return null;
    const failureAgentIds = deriveFailureInfo(run)?.failureAgentIds;
    return {
      id: `table-agent-${agent.agentId}`,
      type: 'agentCard',
      position: { x: 0, y: 0 },
      data: agentToCardData(agent, failureAgentIds?.has(agent.agentId) === true, liveFill?.get(agent.agentId)),
    } as FlowNode;
  }, [tableAgentId, run, liveFill]);

  // I1: resolve the open detail node against the live graph (null if it's no longer present).
  // A table-row selection (synthetic node) wins over a stale/absent canvas node selection.
  const selectedNode = useMemo(
    () => tableSelectedNode ?? graph.nodes.find((n) => n.id === selectedNodeId) ?? null,
    [tableSelectedNode, graph.nodes, selectedNodeId],
  );

  return { graph, selectedNode, overlay, planIsAst, overlayError };
}
