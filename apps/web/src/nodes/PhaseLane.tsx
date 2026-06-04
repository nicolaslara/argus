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
  /**
   * P2 overlay: a coarse run status rolled up from this lane's painted members. When
   * 'not-run' the whole lane is ghosted (a gate-skipped / planned-not-executed phase);
   * else it tints the lane's left edge. Absent on the M3 run + run-free plan renders.
   */
  laneStatus?: 'not-run' | 'partial' | 'complete';
  [key: string]: unknown;
}

const LANE_STATUS_COLOR: Record<NonNullable<PhaseLaneData['laneStatus']>, string> = {
  complete: '#3fb950',
  partial: '#d29922',
  'not-run': '#3a414c',
};

export const PhaseLaneNode = memo(function PhaseLaneNode({ data }: { data: PhaseLaneData }) {
  const ghost = data.laneStatus === 'not-run' ? ' phase-lane-ghost' : '';
  const style = data.laneStatus
    ? { borderLeftColor: LANE_STATUS_COLOR[data.laneStatus], borderLeftWidth: 3 }
    : undefined;
  return (
    <div className={`phase-lane${ghost}`} style={style}>
      {/* Left→right flow: the phase spine docks Right(of i) → Left(of i+1). */}
      <Handle type="target" position={Position.Left} className="lane-handle" />
      <Handle type="source" position={Position.Right} className="lane-handle" />
      <div className="phase-lane-header">
        <span className="phase-lane-index">{data.index}</span>
        <span className="phase-lane-title">{data.title}</span>
        {data.laneStatus === 'not-run' ? (
          <span className="phase-lane-count plan-lane-skipped" title="gate-skipped — planned but not executed">
            not run
          </span>
        ) : data.hideAgentCount ? null : (
          <span className="phase-lane-count">
            {data.agentCount} {data.agentCount === 1 ? 'agent' : 'agents'}
          </span>
        )}
      </div>
      {data.subtitle ? <div className="phase-lane-subtitle">{data.subtitle}</div> : null}
    </div>
  );
});
