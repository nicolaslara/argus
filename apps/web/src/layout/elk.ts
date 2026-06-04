// @argus/web — the elkjs-backed layout engine for the PLAN-AST view ONLY
// (boundaries.md §6 / plan-view-design.md §5). The hand-rolled vertical/horizontal
// lane engines stay the execution-view default; elk is loaded LAZILY (a dynamic
// import in loadElkLayout) so its bundle weight never reaches the execution view.
//
// This engine is NOT a LayoutEngine (that seam is RunModel-phase shaped); it is a
// pure async planLayout(graph) -> placed coordinates for the rich Plan DAG: layered
// direction DOWN, the loop modeled as a NESTED compound node (its body children laid
// out inside it), and every edge routed (flow/fanout/merge/optional/loop-back). All
// elkjs knowledge stays in this file; nothing here imports the adapter or node:*.

// elk.bundled runs synchronously in the main thread (no Web Worker / no worker-bundling
// config needed under Vite). It is the documented browser-without-worker entry point.
import ElkConstructor from 'elkjs/lib/elk.bundled.js';
import type { ElkNode, ElkExtendedEdge } from 'elkjs/lib/elk-api';

export interface PlanLayoutNodeInput {
  id: string;
  width: number;
  height: number;
  /** Compound parent id (the enclosing loop container), or null for top level. */
  parentId: string | null;
  /** True for the loop container node (a compound node with children). */
  isContainer: boolean;
}

export interface PlanLayoutEdgeInput {
  id: string;
  from: string;
  to: string;
}

export interface PlanLayoutInput {
  nodes: PlanLayoutNodeInput[];
  edges: PlanLayoutEdgeInput[];
}

/** Absolute placement (already flattened from elk's per-parent-relative coords). */
export interface PlanPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlanLayoutResult {
  /** Keyed by node id. Container nodes carry their computed size; children are absolute. */
  placements: Map<string, PlanPlacement>;
}

/** Padding reserved inside a loop container for its header band. */
const CONTAINER_HEADER = 44;

const elk = new ElkConstructor();

/**
 * Lay out a Plan DAG with elkjs (layered, top→down, nested loop container). Pure async;
 * resolves to absolute placements. Never throws past elk — the caller falls back to the
 * meta-only graph on rejection.
 */
export async function planLayout(input: PlanLayoutInput): Promise<PlanLayoutResult> {
  // Index nodes by parent so we can build elk's nested `children` arrays.
  const byParent = new Map<string | null, PlanLayoutNodeInput[]>();
  for (const n of input.nodes) {
    const key = n.parentId;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(n);
  }

  const toElk = (n: PlanLayoutNodeInput): ElkNode => {
    const children = byParent.get(n.id);
    const elkNode: ElkNode = { id: n.id, width: n.width, height: n.height };
    if (n.isContainer && children && children.length > 0) {
      elkNode.children = children.map(toElk);
      // A nested compound node gets its own layered pass + a header band on top.
      elkNode.layoutOptions = {
        'elk.padding': `[top=${CONTAINER_HEADER},left=20,bottom=20,right=20]`,
        'elk.direction': 'RIGHT',
      };
    }
    return elkNode;
  };

  const topLevel = (byParent.get(null) ?? []).map(toElk);

  const edges: ElkExtendedEdge[] = input.edges.map((e) => ({
    id: e.id,
    sources: [e.from],
    targets: [e.to],
  }));

  const root: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      // M5 empty-band fix: the Plan/Morph DAG is intrinsically WIDE (4 sequential phase
      // lanes laid out left→right) but SHORT, so fitView (which fits the limiting — width —
      // dimension) used to leave ~60% of the canvas as an empty vertical band. Counter it by
      // pushing the aspect ratio back toward the canvas: keep inter-LAYER spacing tight
      // (narrow lanes) AND open the intra-layer (nodeNode) gap WIDE so parallel fan-out arms
      // spread vertically — the 7-arm research fan now stacks tall enough that the laid-out
      // graph is much closer to 16:9, and fitView fills the height far better. U1 set 44/52;
      // M5 widens nodeNode to 88 (taller lanes) which, combined with the App's tuned fitView
      // padding + raised maxZoom, fills the canvas without clipping at the 1- or 14-agent ends.
      'elk.layered.spacing.nodeNodeBetweenLayers': '40',
      'elk.spacing.nodeNode': '88',
      'elk.layered.spacing.edgeNodeBetweenLayers': '24',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.layered.mergeEdges': 'true',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      // Pack node layers compactly toward the top so lanes share a common baseline.
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    },
    children: topLevel,
    edges,
  };

  const laid = await elk.layout(root);

  const placements = new Map<string, PlanPlacement>();
  // Flatten elk's per-parent-relative coordinates into absolute canvas coordinates.
  const visit = (node: ElkNode, offsetX: number, offsetY: number): void => {
    const x = (node.x ?? 0) + offsetX;
    const y = (node.y ?? 0) + offsetY;
    if (node.id !== 'root') {
      placements.set(node.id, {
        x,
        y,
        width: node.width ?? 0,
        height: node.height ?? 0,
      });
    }
    for (const child of node.children ?? []) visit(child, x, y);
  };
  visit(laid, 0, 0);

  return { placements };
}
