// @argus/web — DEFAULT layout: horizontal phase COLUMNS (left→right), matching the
// article's left-to-right flow (Report → extractor → fan-out → merge; ROUND 1 → 2 →
// FINAL). Phases are columns; agents stack DOWN then wrap into the next sub-column.
// A run-free phase (0 agents, Plan view) collapses to a short header+subtitle box
// instead of reserving a phantom agent row (the P0 over-tall-lane fix).
//
// Same LayoutEngine contract as vertical-lanes (the swappable seam); only the axis
// differs, so mapping.ts / plan-mapping.ts consume it unchanged.

import type { LayoutEngine, LayoutInput, LayoutResult, Placement } from './types.ts';

export const CARD_WIDTH = 260;
export const CARD_HEIGHT = 132;
const CARD_GAP_X = 20;
const CARD_GAP_Y = 20;

const COL_PAD_X = 24;
const HEADER_H = 56; // phase index + title + count
const SUBTITLE_H = 60; // extra room for a 2-line subtitle (agent-free / Plan phases)
const COL_PAD_BOTTOM = 24;
const COL_GAP_X = 96; // gap between phase columns — room for the horizontal spine arrow
const COL_TOP = 0;
const COL_LEFT = 0;

/** Agents stack DOWN to MAX_ROWS, then wrap into the next sub-column (column-major). */
const MAX_ROWS = 4;

export const horizontalLaneLayout: LayoutEngine = {
  id: 'horizontal-lanes',
  layout(input: LayoutInput): LayoutResult {
    const lanes = new Map<number, Placement>();
    const agents = new Map<string, Placement>();

    let cursorX = COL_LEFT;
    // Phases as columns left→right, ordered by 1-based index (deterministic).
    const ordered = [...input.phases].sort((a, b) => a.index - b.index);

    for (const phase of ordered) {
      const n = phase.agentIds.length;
      const cols = n <= 0 ? 0 : Math.ceil(n / MAX_ROWS);
      const rows = n <= 0 ? 0 : Math.min(MAX_ROWS, n);
      // Agent-free phase → reserve subtitle room, NOT a phantom agent grid row.
      const headerH = HEADER_H + (n === 0 ? SUBTITLE_H : 0);
      const gridW = cols === 0 ? CARD_WIDTH : cols * CARD_WIDTH + (cols - 1) * CARD_GAP_X;
      const gridH = rows === 0 ? 0 : rows * CARD_HEIGHT + (rows - 1) * CARD_GAP_Y;
      const colW = COL_PAD_X * 2 + gridW;
      const colH = headerH + gridH + COL_PAD_BOTTOM;

      lanes.set(phase.index, { x: cursorX, y: COL_TOP, width: colW, height: colH });

      // Agents fill DOWN then RIGHT, coordinates RELATIVE to the lane (xyflow parent).
      phase.agentIds.forEach((agentId, i) => {
        const col = Math.floor(i / MAX_ROWS);
        const row = i % MAX_ROWS;
        agents.set(agentId, {
          x: COL_PAD_X + col * (CARD_WIDTH + CARD_GAP_X),
          y: headerH + row * (CARD_HEIGHT + CARD_GAP_Y),
          width: CARD_WIDTH,
          height: CARD_HEIGHT,
        });
      });

      cursorX += colW + COL_GAP_X;
    }

    return { lanes, agents };
  },
};
