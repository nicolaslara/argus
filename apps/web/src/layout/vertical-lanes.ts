// @argus/web — the DEFAULT layout engine: a deterministic hand-rolled vertical
// phase-lane layout (boundaries.md §6). Phases stack top→down by 1-based index;
// agents wrap into a grid inside their lane. Pure arithmetic, jitter-free — no
// physics, no async, no heavy bundle. At ≤14 strictly-layered nodes this reads as
// crisp vertical lanes, which is the M3 acceptance bar.

import type { LayoutEngine, LayoutInput, LayoutResult, Placement } from './types.ts';

// Geometry constants (4 px grid, per the design-system note in boundaries.md §7).
export const CARD_WIDTH = 260;
export const CARD_HEIGHT = 132;
const CARD_GAP_X = 20;
const CARD_GAP_Y = 20;

const LANE_PAD_X = 24;
const LANE_HEADER_H = 56; // room for the phase title + index inside the lane header
const LANE_PAD_BOTTOM = 24;
const LANE_GAP_Y = 64; // vertical gap between stacked phase lanes
const LANE_TOP = 0;
const LANE_LEFT = 0;

/** Columns per lane: cap the grid width so a wide phase wraps instead of sprawling. */
const MAX_COLS = 4;

function columnsFor(count: number): number {
  if (count <= 0) return 1;
  return Math.min(MAX_COLS, count);
}

export const verticalLaneLayout: LayoutEngine = {
  id: 'vertical-lanes',
  layout(input: LayoutInput): LayoutResult {
    const lanes = new Map<number, Placement>();
    const agents = new Map<string, Placement>();

    // Lane width is driven by the widest phase (so every lane shares one width →
    // clean left-aligned vertical spine). Compute the max column count first.
    let maxCols = 1;
    for (const phase of input.phases) {
      maxCols = Math.max(maxCols, columnsFor(phase.agentIds.length));
    }
    const laneWidth = LANE_PAD_X * 2 + maxCols * CARD_WIDTH + (maxCols - 1) * CARD_GAP_X;

    let cursorY = LANE_TOP;
    // Phases stacked top→down by 1-based index (sorted ascending for determinism).
    const ordered = [...input.phases].sort((a, b) => a.index - b.index);

    for (const phase of ordered) {
      const cols = columnsFor(phase.agentIds.length);
      const rows = Math.max(1, Math.ceil(phase.agentIds.length / cols));
      const gridH = rows * CARD_HEIGHT + (rows - 1) * CARD_GAP_Y;
      const laneHeight = LANE_HEADER_H + gridH + LANE_PAD_BOTTOM;

      lanes.set(phase.index, {
        x: LANE_LEFT,
        y: cursorY,
        width: laneWidth,
        height: laneHeight,
      });

      // Agents wrapped into a grid; coordinates RELATIVE to the lane (xyflow parent).
      phase.agentIds.forEach((agentId, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        agents.set(agentId, {
          x: LANE_PAD_X + col * (CARD_WIDTH + CARD_GAP_X),
          y: LANE_HEADER_H + row * (CARD_HEIGHT + CARD_GAP_Y),
          width: CARD_WIDTH,
          height: CARD_HEIGHT,
        });
      });

      cursorY += laneHeight + LANE_GAP_Y;
    }

    return { lanes, agents };
  },
};
