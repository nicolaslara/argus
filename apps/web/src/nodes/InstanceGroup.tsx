// @argus/web — the InstanceGroup drawer node for the merged Run view
// (run-view-merge-plan.md §2 "Visual grammar" + §6 Phase 1).
//
// A dashed "instances (N)" drawer that grows DOWNWARD inside a phase lane when a fanned
// plan template is expanded. It MIRRORS LoopContainer's shell (a dashed compound container
// with a header band), but stays NEUTRAL (a `--line-2`-equivalent dashed border, subtle
// bg) — saturated accent is reserved for run STATUS (the status dots on the instance cards
// + the aggregate chip), never for the drawer chrome.
//
// The body is intentionally EMPTY: React Flow renders the child `agentCard` instances as
// real nodes positioned (drawer-relative) OVER this group, so the drawer is just the framed
// backdrop + header. Size is read from `node.style` (set by expandInstances — group nodes
// carry their size in style, per mapping.ts / plan-model-mapping.ts), so this component
// never computes geometry.
//
// The header `[▴]` collapse caret carries its own onClick (e.stopPropagation() +
// ExpandContext.toggle(templateId)) so the global onNodeClick (body → DetailPanel) never
// fires for the caret — React Flow's onNodeClick can't distinguish sub-targets.
//
// ALL text is React text nodes (no dangerouslySetInnerHTML): the label / chip can echo the
// user's own workflow source + run content (boundaries.md §4).

import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { useExpand } from '../expand-context.ts';
import { aggregateChipText, type PaintedBindingFields } from './PlanNodes.tsx';

const hidden = { opacity: 0, pointerEvents: 'none' as const };

/** The drawer's data: the host template's painted binding fields (so the header renders the
 *  same `aggregateChipText` verbatim) + the host template id + the resolved instance count. */
export interface InstanceGroupData extends PaintedBindingFields {
  /** The host plan template node id — the caret toggles THIS id (not the drawer's own id). */
  templateId: string;
  /** Resolved (bound) instance count — the drawer's `(N)` count. */
  instanceCount: number;
  /** The host template's label (e.g. `research:${r.key}`) — the drawer identity. */
  title?: string;
  /**
   * OPTION 2 (lane-drawer inside the loop): set TRUE by `expandLoopDrawer` so the header caret
   * collapses the LOOP drawer (via `selectRound(loopId, round)`, mirroring the round pill) instead
   * of the flat fan (via `toggle(templateId)`). A flat-fan drawer leaves this absent → the caret
   * keeps its original `toggle` path. `loopId`/`round` are the (loop node id, open round) the
   * caret re-clicks to toggle the in-loop drawer closed.
   */
  loopDrawer?: boolean;
  /** OPTION 2 only: the LOOP container node id whose round drawer this is (paired with `round`). */
  loopId?: string;
  /** OPTION 2 only: the open round this drawer expands (the caret re-selects it to collapse). */
  round?: number;
  [key: string]: unknown;
}

export const InstanceGroup = memo(function InstanceGroup({ data }: { data: InstanceGroupData }) {
  const { toggle, selectRound } = useExpand();
  const chip = aggregateChipText(data);
  const label = data.title ?? 'instances';
  // A LOOP drawer (OPTION 2) collapses by re-selecting its open round — `selectRound(loopId, round)`
  // toggles `loopDrawerRound` off for that loop, exactly as re-clicking the round pill does. A
  // flat-fan drawer (no `loopDrawer` flag) keeps its original `toggle(templateId)` collapse path.
  const collapse =
    data.loopDrawer === true && typeof data.loopId === 'string' && typeof data.round === 'number'
      ? () => selectRound?.(data.loopId!, data.round!)
      : () => toggle(data.templateId);
  return (
    <div className="instance-group">
      <Handle type="target" position={Position.Left} style={hidden} />
      <Handle type="source" position={Position.Right} style={hidden} />
      <div className="instance-group-header">
        <span className="instance-group-title" title={label}>
          {label}
        </span>
        <span className="instance-group-count" aria-hidden="true">
          ({data.instanceCount})
        </span>
        {chip ? (
          <span className={`agent-chip plan-bind-chip plan-bind-${data.bindStatus}`} title={chip}>
            {chip}
          </span>
        ) : null}
        <button
          type="button"
          className="instance-group-caret"
          aria-label="collapse instances"
          title="collapse instances"
          onClick={(e) => {
            e.stopPropagation();
            collapse();
          }}
        >
          ▴
        </button>
      </div>
      {/* Body is empty — React Flow renders the child agent cards positioned over the drawer. */}
    </div>
  );
});
