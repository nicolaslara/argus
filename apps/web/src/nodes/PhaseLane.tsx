// @argus/web — the phase-lane container node. A non-interactive group that frames
// a phase's agents; the synthesized phase_i→phase_i+1 spine edges connect lanes.
// Title + 1-based index are rendered as text nodes only (boundaries.md §4/§7).

import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';

export interface PhaseLaneData {
  index: number;
  title: string;
  agentCount: number;
  /**
   * Optional per-phase subtitle (P0 Plan view: meta.phases[].detail). Rendered as a
   * text node only, 2-line clamped. The M3 run render passes NO subtitle, so its
   * markup is byte-unaffected (the block is gated on subtitle presence).
   */
  subtitle?: string | null;
  /** P0: hide the agent-count chip in the run-free Plan view (no run, no agents). */
  hideAgentCount?: boolean;
  [key: string]: unknown;
}

export const PhaseLaneNode = memo(function PhaseLaneNode({ data }: { data: PhaseLaneData }) {
  return (
    <div className="phase-lane">
      <Handle type="target" position={Position.Top} className="lane-handle" />
      <Handle type="source" position={Position.Bottom} className="lane-handle" />
      <div className="phase-lane-header">
        <span className="phase-lane-index">{data.index}</span>
        <span className="phase-lane-title">{data.title}</span>
        {data.hideAgentCount ? null : (
          <span className="phase-lane-count">
            {data.agentCount} {data.agentCount === 1 ? 'agent' : 'agents'}
          </span>
        )}
      </div>
      {data.subtitle ? <div className="phase-lane-subtitle">{data.subtitle}</div> : null}
    </div>
  );
});
