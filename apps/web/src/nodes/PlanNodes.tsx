// @argus/web — the Plan-AST view's custom node components (plan-view-design.md §3.1).
//
// Node kind → component:
//   agent     → PlanAgentNode   (a compact card; reuses the AgentCard visual language)
//   process   → PlanProcessNode (a small box; fan-out split / merge barrier)
//   decision  → DecisionDiamond (FIXED-SIZE custom SVG diamond, Left/Right/Bottom
//               handles at the rotated vertices, an UNROTATED centered label — NOT a
//               CSS-rotated square, per the §3.1 visual fix)
//   loop      → LoopContainer   (an xyflow group container with a header band)
//   output    → OutputTerminal  (a terminal pill)
//   unparsed  → UnparsedPlaceholder (dashed box + source-span tooltip)
//   pipeline/subworkflow → PlanProcessNode (opaque-container stub styling)
//
// Confidence is ONE visual axis via a border style (solid=declared, solid+tick=static,
// dashed=heuristic) — never opacity/saturation (reserved for run state). The single
// multiplicity glyph is a field-driven decoration (MultiplicityChip), not a kind.
//
// ALL text is React text nodes (no dangerouslySetInnerHTML): labels/conditions can echo
// the user's own workflow source (boundaries.md §4).

import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { Confidence, Multiplicity } from '@argus/contract';
import { MultiplicityChip, isFanned } from './MultiplicityChip.tsx';

// --- shared node geometry (kept in sync with plan-model-mapping.ts) -----------
export const PLAN_AGENT_W = 220;
export const PLAN_AGENT_H = 76;
export const PLAN_PROCESS_W = 132;
export const PLAN_PROCESS_H = 48;
export const PLAN_DECISION_SIZE = 116; // the diamond's bounding box (square)
export const PLAN_OUTPUT_W = 120;
export const PLAN_OUTPUT_H = 44;
export const PLAN_UNPARSED_W = 200;
export const PLAN_UNPARSED_H = 60;

/** Map per-node confidence to the single border-style axis (never color/opacity). */
function confidenceClass(c: Confidence): string {
  return `plan-conf-${c}`; // .plan-conf-declared | .plan-conf-static | .plan-conf-heuristic
}

const hidden = { opacity: 0, pointerEvents: 'none' as const };

// ============================================================================
// agent
// ============================================================================
export interface PlanAgentData {
  title: string;
  /** The structured label raw (e.g. `research:${r.key}`) — hover detail only. */
  labelRaw: string | null;
  subtitle: string | null;
  agentType: string | null;
  typed: boolean;
  optional: boolean;
  multiplicity: Multiplicity;
  confidence: Confidence;
  [key: string]: unknown;
}

export const PlanAgentNode = memo(function PlanAgentNode({ data }: { data: PlanAgentData }) {
  const fanned = isFanned(data.multiplicity);
  return (
    <div
      className={`plan-node plan-agent ${confidenceClass(data.confidence)}${data.optional ? ' is-optional' : ''}${fanned ? ' is-fanned' : ''}`}
    >
      <Handle type="target" position={Position.Left} style={hidden} />
      <Handle type="source" position={Position.Right} style={hidden} />
      {fanned ? <span className="plan-stack-silhouette" aria-hidden="true" /> : null}
      <MultiplicityChip multiplicity={data.multiplicity} />
      <div className="plan-agent-head">
        <span className="plan-agent-label" title={data.labelRaw ?? data.title}>
          {data.title}
          {data.labelRaw && data.labelRaw !== data.title ? (
            <span className="plan-agent-hole">{data.labelRaw.slice(data.title.length)}</span>
          ) : null}
        </span>
        {data.typed ? (
          <span className="plan-chip plan-chip-typed" title="StructuredOutput schema declared">
            typed
          </span>
        ) : null}
      </div>
      {data.subtitle ? <div className="plan-agent-sub">{data.subtitle}</div> : null}
    </div>
  );
});

// ============================================================================
// process — fan-out split / merge barrier / opaque container stub
// ============================================================================
export interface PlanProcessData {
  title: string;
  /** 'split' (fan-out) | 'merge' (barrier) | 'op' (generic). */
  role: 'split' | 'merge' | 'op';
  multiplicity: Multiplicity;
  confidence: Confidence;
  optional: boolean;
  [key: string]: unknown;
}

export const PlanProcessNode = memo(function PlanProcessNode({ data }: { data: PlanProcessData }) {
  return (
    <div
      className={`plan-node plan-process plan-process-${data.role} ${confidenceClass(data.confidence)}${data.optional ? ' is-optional' : ''}`}
    >
      <Handle type="target" position={Position.Left} style={hidden} />
      <Handle type="source" position={Position.Right} style={hidden} />
      <MultiplicityChip multiplicity={data.multiplicity} />
      <span className="plan-process-label">{data.title}</span>
    </div>
  );
});

// ============================================================================
// decision — fixed-size custom SVG diamond (NOT a CSS-rotated square)
// ============================================================================
export interface PlanDecisionData {
  conditionLabel: string;
  conditionKind: 'regex-verdict' | 'schema-field' | 'expr';
  confidence: Confidence;
  optional: boolean;
  [key: string]: unknown;
}

export const DecisionDiamond = memo(function DecisionDiamond({ data }: { data: PlanDecisionData }) {
  const s = PLAN_DECISION_SIZE;
  const half = s / 2;
  // The diamond is drawn as an SVG <polygon> filling the square bounding box; handles
  // dock at the rotated VERTICES (left/right/bottom), and the label is an UNROTATED,
  // centered HTML overlay — so it stays upright and edges attach at true vertices.
  return (
    <div className={`plan-node plan-decision ${confidenceClass(data.confidence)}${data.optional ? ' is-optional' : ''}`} style={{ width: s, height: s }}>
      {/* Handles at the rotated vertices: in (top), out true (right), out false (bottom). */}
      <Handle type="target" position={Position.Left} style={{ ...hidden, top: half }} />
      <Handle id="true" type="source" position={Position.Right} style={{ ...hidden, top: half }} />
      <Handle id="false" type="source" position={Position.Bottom} style={{ ...hidden, left: half }} />
      <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} className="plan-decision-svg" aria-hidden="true">
        <polygon points={`${half},2 ${s - 2},${half} ${half},${s - 2} 2,${half}`} />
      </svg>
      <span className="plan-decision-label" title={`${data.conditionKind}: ${data.conditionLabel}`}>
        {data.conditionLabel}
      </span>
    </div>
  );
});

// ============================================================================
// loop — xyflow group container (header band + body)
// ============================================================================
export interface PlanLoopData {
  title: string;
  stopCondition: string;
  maxRounds: number | null;
  confidence: Confidence;
  [key: string]: unknown;
}

export const LoopContainer = memo(function LoopContainer({ data }: { data: PlanLoopData }) {
  return (
    <div className={`plan-loop ${confidenceClass(data.confidence)}`}>
      <Handle type="target" position={Position.Left} style={hidden} />
      <Handle type="source" position={Position.Right} style={hidden} />
      <div className="plan-loop-header">
        <span className="plan-loop-glyph" aria-hidden="true">
          ↻
        </span>
        <span className="plan-loop-title">{data.title}</span>
        <span className="plan-loop-stop">{data.stopCondition}</span>
      </div>
    </div>
  );
});

// ============================================================================
// output — terminal pill (the return sink)
// ============================================================================
export interface PlanOutputData {
  title: string;
  confidence: Confidence;
  [key: string]: unknown;
}

export const OutputTerminal = memo(function OutputTerminal({ data }: { data: PlanOutputData }) {
  return (
    <div className={`plan-node plan-output ${confidenceClass(data.confidence)}`}>
      <Handle type="target" position={Position.Left} style={hidden} />
      <span className="plan-output-label">{data.title}</span>
    </div>
  );
});

// ============================================================================
// unparsed — dashed placeholder (graceful-degrade; source-span tooltip)
// ============================================================================
export interface PlanUnparsedData {
  title: string;
  /** Byte span into the workflow source — view-source hover only. */
  span: { start: number; end: number } | null;
  [key: string]: unknown;
}

export const UnparsedPlaceholder = memo(function UnparsedPlaceholder({ data }: { data: PlanUnparsedData }) {
  const spanText = data.span ? `source bytes ${data.span.start}–${data.span.end}` : 'unparsed construct';
  return (
    <div className="plan-node plan-unparsed" title={spanText}>
      <Handle type="target" position={Position.Left} style={hidden} />
      <Handle type="source" position={Position.Right} style={hidden} />
      <span className="plan-unparsed-label">{data.title}</span>
    </div>
  );
});
