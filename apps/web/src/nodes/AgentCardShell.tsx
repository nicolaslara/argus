// @argus/web — the ONE shared agent-card shell (U1: unify Plan & Execution).
//
// A plan agent (template) and an execution agent (instance) are the SAME component:
// one presentational shell with a fixed shape, a kind-or-state-colored left rail, a
// mono label with ellipsis, a 2-line caption slot, and a VIEW-SPECIFIC footer slot.
//   - Execution footer  = state + dur/tok/tools pills          (AgentCard wraps this)
//   - Plan footer        = ×N multiplicity + typed/optional chips (PlanAgentNode wraps)
// Both wrappers render this shell, so the two views read as one graph (template vs
// instance). Geometry (width/height) is the single source of truth shared by the
// layout engines (the execution lanes + the plan elk pass both size to these numbers).
//
// ALL text is rendered as React text nodes (never dangerouslySetInnerHTML) — labels,
// captions, and footer values can echo secret-bearing run/source content
// (boundaries.md §4). The shell takes only already-structured props.

import type { ReactNode } from 'react';

// --- shared card geometry (the single source of truth for BOTH layout engines) -----
// One width keeps plan/execution cards visually identical side-by-side. The plan card
// is slightly shorter (no metric pill row), but shares width, radius, bg, rail, type.
export const CARD_SHELL_WIDTH = 248;
// M5 density pass: the exec card was 124px tall with the footer pinned to the bottom
// (margin-top:auto), so a caption-less card carried a dead gap between the label and the
// pills. Tightened to 110 — the 4 content rows (label / caption / state-meta / pills) now
// sit close together and the card reads at a glance. Plan stays a touch shorter (no pills).
//
// INLINE-EXPAND: the exec card now also carries a 1-line RESULT PREVIEW row (a calm caption
// of WHAT the agent produced — first line of resultPreview, ellipsised) between the label
// and the footer. That adds one ~15px text row + its 6px gap, so the shell grew 110→128.
// 128 stays UNDER the layout engines' per-cell CARD_HEIGHT (132 in {horizontal,vertical}-
// lanes.ts), so lane sizing is unaffected; the fan-out drawer in overlay-expand.ts sizes its
// grid cells to THIS constant (CARD_H = CARD_SHELL_HEIGHT_EXEC), so it grows in lockstep and
// every instance card still fits. Plan stays a touch shorter (no pills, no preview).
export const CARD_SHELL_HEIGHT_EXEC = 128;
export const CARD_SHELL_HEIGHT_PLAN = 88;

export interface AgentCardShellProps {
  /** The mono primary label (ellipsised). */
  label: string;
  /** Optional hover title for the label (the raw/full form). */
  labelTitle?: string;
  /** Optional decoration after the label text (e.g. the plan label-hole, a typed chip). */
  labelAfter?: ReactNode;
  /** Left-rail accent: state color (execution) or kind/accent color (plan). */
  railColor: string;
  /** Optional status dot before the label (execution shows a state dot; plan omits it). */
  dot?: ReactNode;
  /** The 2-line caption slot (PX subtitle / execution caption). Rendered text-only. */
  caption?: ReactNode;
  /** The view-specific footer (pills for execution, chips for plan). */
  footer?: ReactNode;
  /** Extra class names (confidence/optional/fanned/state hooks). */
  className?: string;
  /** Card height — exec vs plan differ only by the footer row height. */
  height: number;
  /** Handles (xyflow target/source) — view supplies them so docking ports stay correct. */
  handles?: ReactNode;
  /** Behind-card silhouette for a fanned (×N) plan template. */
  silhouette?: ReactNode;
  /** Optional trailing element pinned to the end of the head row (e.g. the expand caret). */
  headEnd?: ReactNode;
}

export function AgentCardShell({
  label,
  labelTitle,
  labelAfter,
  railColor,
  dot,
  caption,
  footer,
  className,
  height,
  handles,
  silhouette,
  headEnd,
}: AgentCardShellProps) {
  return (
    <div
      className={`agent-shell${className ? ` ${className}` : ''}`}
      style={{ borderLeftColor: railColor, height }}
    >
      {handles}
      {silhouette}
      <div className="agent-shell-head">
        {dot}
        <span className="agent-shell-label" title={labelTitle ?? label}>
          {label}
          {labelAfter}
        </span>
        {headEnd}
      </div>
      {caption ? <div className="agent-shell-caption-row">{caption}</div> : null}
      {footer ? <div className="agent-shell-footer">{footer}</div> : null}
    </div>
  );
}
