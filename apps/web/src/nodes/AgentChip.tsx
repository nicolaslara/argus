// @argus/web — the compact AgentChip node for a DENSITY-DEGRADED expand drawer
// (run-view-merge-plan.md Ship #6 "Density degrade"). Above CHIP_DEGRADE_THRESHOLD instances
// the drawer's full `agentCard` cells collapse to these chips (+ a trailing `+N more` tile), so
// the drawer height stays bounded instead of growing to ~ceil(N/5) card rows.
//
// A chip is a TINY at-a-glance row: a state dot (the shared run-state hue; a failure point
// reads RED, consistent with the card's failure ring + the Run-view failure banner), a mono
// label (ellipsised), and a small dur. The `+N more` variant (data.more) renders a muted
// overflow tile (no dot / dur) — an honest "this many instances are hidden" marker.
//
// Clicking a chip opens the DetailPanel through the SAME global onNodeClick path as agentCard
// (App's handler keys on data.agentId, which a real chip carries; the `+N more` tile carries
// none, so it is inert under the panel — there is no single agent to open).
//
// The cell is sized to the SAME CHIP_W × CHIP_H box overlay-expand reserves for it (one source
// of truth — imported, not re-declared), so the node fills its cell and never overflows.
//
// ALL text is rendered as React text nodes (never dangerouslySetInnerHTML) — the label can echo
// secret-bearing run/source content (boundaries.md §4).

import { memo } from 'react';
import { CHIP_W, CHIP_H, type AgentChipData } from '../overlay-expand.ts';
import { STATE_COLOR } from './AgentCard.tsx';

const EM_DASH = '—';

/** Compact duration string — mirrors AgentCard's formatDuration so a chip's dur reads the same. */
function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return EM_DASH;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m${rem.toString().padStart(2, '0')}s`;
}

export const AgentChip = memo(function AgentChip({ data }: { data: AgentChipData }) {
  // The trailing `+N more` overflow tile: a muted count, no dot / dur (no single agent to open).
  if (data.more != null) {
    return (
      <div
        className="agent-chip-node agent-chip-more"
        style={{ width: CHIP_W, height: CHIP_H }}
        title={`${data.more} more instance${data.more === 1 ? '' : 's'} not shown`}
      >
        +{data.more} more
      </div>
    );
  }

  // A real instance chip: state dot (failure point → red) + ellipsised mono label + small dur.
  const color = data.failurePoint
    ? STATE_COLOR.error
    : STATE_COLOR[data.state ?? 'unknown'] ?? STATE_COLOR.unknown;
  const label = data.label || data.agentId || 'agent';
  const dur = formatDuration(data.durationMs);
  // Table cross-highlight (data-only, chip parity with the full card): a persistent ring when
  // SELECTED, a soft glow when HOVERED. Same class hooks as .agent-shell so the styling matches.
  const highlightClass = `${data.highlighted ? ' is-highlighted' : ''}${data.hovered ? ' is-hovered' : ''}`;

  return (
    <div
      className={`agent-chip-node${highlightClass}`}
      style={{ width: CHIP_W, height: CHIP_H }}
      title={label}
    >
      <span className="agent-chip-dot" style={{ backgroundColor: color }} aria-hidden="true" />
      <span className="agent-chip-label">{label}</span>
      <span className="agent-chip-dur" data-dim={dur === EM_DASH ? 'true' : 'false'}>
        {dur}
      </span>
    </div>
  );
});
