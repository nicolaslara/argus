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
import type { Confidence, Multiplicity, PlanBinding } from '@argus/contract';
import { MultiplicityChip, isFanned } from './MultiplicityChip.tsx';
import {
  AgentCardShell,
  CARD_SHELL_WIDTH,
  CARD_SHELL_HEIGHT_PLAN,
} from './AgentCardShell.tsx';

// P2 overlay: the run-status palette painted onto the plan template. Reuses the shared
// state hues (saturation reserved for run state) — complete=green, partial=amber,
// not-run=neutral (ghosted). The plan template's own rail (no run) stays the accent.
export const BIND_STATUS_COLOR: Record<PlanBinding['status'], string> = {
  complete: '#3fb950',
  partial: '#d29922',
  'not-run': '#3a414c',
};

/** P2 binding fields painted onto a plan node's data by paintOverlay (all optional). */
export interface PaintedBindingFields {
  bindStatus?: PlanBinding['status'];
  bindSucceeded?: number;
  bindFailed?: number;
  bindTotal?: number | 'N';
  bindConfidence?: PlanBinding['confidence'];
  bindAmbiguous?: boolean;
  /** I1: bound run agentIds (Morph detail panel reads these; the card render ignores them). */
  bindAgentIds?: string[];
  painted?: boolean;
}

/** The fan-out / instance aggregate chip text: '7/7 done' | '3/4 done · 1 failed'. */
export function aggregateChipText(b: PaintedBindingFields): string | null {
  if (!b.painted || b.bindStatus === undefined) return null;
  if (b.bindStatus === 'not-run') return 'planned · not run';
  const total = b.bindTotal === 'N' ? 'N' : String(b.bindTotal);
  const done = `${b.bindSucceeded ?? 0}/${total} done`;
  return (b.bindFailed ?? 0) > 0 ? `${done} · ${b.bindFailed} failed` : done;
}

// --- shared node geometry (kept in sync with plan-model-mapping.ts) -----------
// The plan agent IS the shared card shell (U1) — same width as the execution card,
// a slightly shorter height (no metric-pill row).
export const PLAN_AGENT_W = CARD_SHELL_WIDTH;
export const PLAN_AGENT_H = CARD_SHELL_HEIGHT_PLAN;
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
export interface PlanAgentData extends PaintedBindingFields {
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
  const chip = aggregateChipText(data);
  // P2: when a run is painted, the rail color carries run STATUS (saturation reserved for
  // state); the un-painted plan template keeps the neutral accent rail.
  const railColor =
    data.painted && data.bindStatus ? BIND_STATUS_COLOR[data.bindStatus] : 'var(--argus-accent)';
  // The PLAN footer: ×N multiplicity + typed / optional chips. When painted, the aggregate
  // status chip leads (one chip, never a per-member explosion — folded mode).
  const footer = (
    <div className="agent-shell-chips">
      {chip ? (
        <span className={`agent-chip plan-bind-chip plan-bind-${data.bindStatus}`} title={chip}>
          {chip}
        </span>
      ) : (
        <MultiplicityChip multiplicity={data.multiplicity} variant="inline" />
      )}
      {data.bindAmbiguous ? (
        <span
          className="agent-chip plan-bind-ambiguous"
          title="one run agent matched more than one plan node — not auto-resolved"
        >
          ambiguous
        </span>
      ) : null}
      {data.typed ? (
        <span className="agent-chip agent-chip-typed" title="StructuredOutput schema declared">
          typed
        </span>
      ) : null}
      {data.optional ? (
        <span className="agent-chip agent-chip-optional" title="conditional (inside a decision branch)">
          optional
        </span>
      ) : null}
    </div>
  );
  const ghost = data.painted && data.bindStatus === 'not-run' ? ' plan-bind-ghost' : '';
  return (
    <AgentCardShell
      label={data.title}
      labelTitle={data.labelRaw ?? data.title}
      labelAfter={
        data.labelRaw && data.labelRaw !== data.title ? (
          <span className="plan-agent-hole">{data.labelRaw.slice(data.title.length)}</span>
        ) : null
      }
      railColor={railColor}
      height={CARD_SHELL_HEIGHT_PLAN}
      className={`agent-shell-plan plan-node plan-agent ${confidenceClass(data.confidence)}${data.optional ? ' is-optional' : ''}${fanned ? ' is-fanned' : ''}${ghost}`}
      handles={
        <>
          <Handle type="target" position={Position.Left} style={hidden} />
          <Handle type="source" position={Position.Right} style={hidden} />
        </>
      }
      silhouette={<MultiplicityChip multiplicity={data.multiplicity} variant="corner" />}
      caption={
        data.subtitle ? (
          // M5 caption-fit: 2-line clamped (CSS) AND a native title so the full text is
          // reachable on hover and never overflows the card (the popover stays PX-fit).
          <div className="agent-caption" data-source="baseline" title={data.subtitle}>
            {data.subtitle}
          </div>
        ) : null
      }
      footer={footer}
    />
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
  /** PX (annotation-only): an LLM-enriched caption, text node, swapped in when ready. */
  subtitle?: string | null;
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
      {/* M5 caption-fit: 2-line clamp + native title for the full text (PX caption). */}
      {data.subtitle ? (
        <div className="plan-process-sub" title={data.subtitle}>
          {data.subtitle}
        </div>
      ) : null}
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
  /**
   * P2 folded↔unrolled MODE switch. `observedRounds` = the run's actual round count (from
   * the Overlay); `unrolled` toggles the horizontal round-column axis WITHIN this loop
   * container vs the folded single-body view. The MODE is a switch, never a per-node
   * explosion, and toggling it does NOT relayout the canvas (it re-renders this header).
   */
  observedRounds?: number | null;
  unrolled?: boolean;
  [key: string]: unknown;
}

export const LoopContainer = memo(function LoopContainer({ data }: { data: PlanLoopData }) {
  const rounds = data.observedRounds ?? null;
  // The round count shown: the observed run rounds (painted) else the static cap.
  const roundLabel =
    rounds != null ? `↻ ${rounds} round${rounds === 1 ? '' : 's'}` : data.maxRounds != null ? `↻ max ${data.maxRounds}` : '↻';
  const showAxis = !!data.unrolled && rounds != null && rounds > 1;
  return (
    <div className={`plan-loop ${confidenceClass(data.confidence)}${showAxis ? ' plan-loop-unrolled' : ''}`}>
      <Handle type="target" position={Position.Left} style={hidden} />
      <Handle type="source" position={Position.Right} style={hidden} />
      <div className="plan-loop-header">
        <span className="plan-loop-glyph" aria-hidden="true">
          ↻
        </span>
        <span className="plan-loop-title">{data.title}</span>
        <span className="plan-loop-stop">{data.stopCondition}</span>
        {rounds != null ? (
          <span className="plan-loop-rounds" title={`observed ${rounds} round${rounds === 1 ? '' : 's'} (folded↔unrolled)`}>
            {roundLabel}
          </span>
        ) : null}
      </div>
      {showAxis ? (
        // The HORIZONTAL round-column axis: one column marker per observed round, INSIDE
        // the one loop container. Folded collapses back to a single body (the affordance
        // is the App-level mode toggle). The primary phase axis stays vertical.
        <div className="plan-loop-round-axis" aria-label={`${rounds} rounds`}>
          {Array.from({ length: rounds! }, (_, i) => (
            <span key={i} className="plan-loop-round-col">
              r{i + 1}
            </span>
          ))}
        </div>
      ) : null}
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
