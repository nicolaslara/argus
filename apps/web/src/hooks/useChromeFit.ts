import { useEffect, useRef, type RefObject } from 'react';
import type { Node as FlowNode, ReactFlowInstance } from '@xyflow/react';
import { chromeAwareFitOptions } from '../fit/chrome-fit.ts';

/** Everything the four fitView effects need from App. Threaded in explicitly (no hidden deps)
 *  so the dependency arrays below stay byte-identical to the inline effects they replaced. */
export interface ChromeFitArgs {
  /** The captured React Flow instance (App owns the ref; the hook only reads `.current`). */
  rfRef: RefObject<ReactFlowInstance | null>;
  /** The frozen structural plan-id signature (computeFitSignature); re-fit on change. */
  fitSignature: string;
  /** The open instance-drawer host ids; a growth fires the one-shot expand fit. */
  expandedNodeIds: Set<string>;
  /** loopNodeId → open round; a growth fires the one-shot loop-drawer fit. */
  loopDrawerRound: Map<string, number>;
  /** The bottom agent-table toggle; either edge re-fits the clear region. */
  tableOpen: boolean;
  /** The live graph nodes — only `.length` is read (the guard); never a re-fit trigger. */
  graphNodes: FlowNode[];
}

/**
 * The Run/Plan canvas FIT effects, extracted verbatim from App.tsx (behavior-preserving). Four
 * INDEPENDENT effects, each keyed on its OWN distinct trigger and each deferring one frame so
 * React Flow has measured the new nodes + chrome before fitting (then reserving the chrome
 * footprint via chromeAwareFitOptions so the graph never lands under it — the no-overlap
 * invariant). The four are kept SEPARATE (not consolidated into one RAF) because each fires on a
 * different transition; the per-side padding is re-measured from the live DOM on every fit.
 *
 * Order + dependency arrays preserved exactly: fitSignature → expand → loopDrawer → tableOpen.
 */
export function useChromeFit({
  rfRef,
  fitSignature,
  expandedNodeIds,
  loopDrawerRound,
  tableOpen,
  graphNodes,
}: ChromeFitArgs): void {
  // fitView (U1 cosmetic fix): the `fitView` PROP only fits on mount, so the async Plan-AST
  // graph (which replaces the meta-only graph after elk resolves) was never refit — leaving it
  // off-center with the rightmost phase lane clipped. Refit whenever the graph's node SET
  // changes (a topology swap), keyed by the cheap structural signature so caption-only (PX)
  // overlays — which never change ids — do NOT refit and yank the viewport.
  useEffect(() => {
    if (graphNodes.length === 0) return;
    const inst = rfRef.current;
    if (!inst) return;
    // M5 empty-band fix: the Plan/Run DAG is wide-but-short, so a uniform 0.12 padding +
    // the default maxZoom=2 fit it to WIDTH and left a tall empty band. Give both views a
    // tighter padding AND a higher maxZoom so the graph is allowed to zoom up and FILL the
    // canvas (paired with the taller elk lanes above).
    // Defer one frame so React Flow has measured the new nodes AND the chrome before fitting,
    // then reserve the chrome footprint so the graph never lands under it (no overlap).
    const raf = requestAnimationFrame(() => inst.fitView(chromeAwareFitOptions()));
    return () => cancelAnimationFrame(raf);
    // Intentionally keyed ONLY on the frozen plan-id signature (which encodes `view`); a
    // graph.nodes churn from instance/ghost/drawer changes must NOT re-fit (see the
    // one-shot expand fitBounds effect below).
  }, [fitSignature]);

  // One-shot EXPAND fit: when a node id ENTERS expandedNodeIds (a membership transition, not
  // a per-paint tick), gently fit the freshly-grown graph ONCE so the new drawer is brought
  // into view — never on subsequent live re-paints (run-view-merge-plan.md §2). Keyed on a
  // size-only signature of the expanded set so toggling open fires it; collapsing does not
  // need a special fit (the structural plan-id signature is unchanged across expand/collapse).
  const prevExpandCount = useRef(0);
  useEffect(() => {
    const inst = rfRef.current;
    const count = expandedNodeIds.size;
    const grew = count > prevExpandCount.current;
    prevExpandCount.current = count;
    if (!grew || !inst || graphNodes.length === 0) return;
    const raf = requestAnimationFrame(() => inst.fitView(chromeAwareFitOptions()));
    return () => cancelAnimationFrame(raf);
    // Fire only on the expand-set transition (graph.nodes intentionally excluded so a live
    // re-paint never re-fits).
  }, [expandedNodeIds]);

  // OPTION 2 one-shot fit: when a loop's round drawer OPENS (its size grows), gently fit the
  // grown loop region into view once — the loop container just got taller, so the back-edge +
  // the new cards should be brought into frame. Keyed on the open-drawer count so opening fires
  // it and closing does not (the structural plan-id signature is unchanged across the toggle).
  const prevLoopDrawerCount = useRef(0);
  useEffect(() => {
    const inst = rfRef.current;
    const count = loopDrawerRound.size;
    const grew = count > prevLoopDrawerCount.current;
    prevLoopDrawerCount.current = count;
    if (!grew || !inst || graphNodes.length === 0) return;
    const raf = requestAnimationFrame(() => inst.fitView(chromeAwareFitOptions()));
    return () => cancelAnimationFrame(raf);
  }, [loopDrawerRound]);

  // "Table panel" one-shot fit: opening/closing the bottom AGENT TABLE changes the clear region
  // (its footprint is reserved as fitView bottom padding), so re-fit ONCE on the toggle so the
  // graph reflows above it (never lands underneath). Defer a frame so the panel has mounted/
  // unmounted and is measurable before we read its top edge in chromeAwareFitOptions.
  useEffect(() => {
    const inst = rfRef.current;
    if (!inst || graphNodes.length === 0) return;
    const raf = requestAnimationFrame(() => inst.fitView(chromeAwareFitOptions()));
    return () => cancelAnimationFrame(raf);
    // Keyed only on the toggle (not graph.nodes) so a live re-paint never re-fits.
  }, [tableOpen]);
}
