// @argus/web — the PURE, React-free seam that MIGRATES an open loop-round drill across a
// loop-drill MODE switch (loop-drill-gallery.html opt1 ⟷ opt2).
//
// Why this exists: the two modes present the SAME drill — "show round N of loop L" — in two
// different places:
//   - 'round-axis' (option 1): the DetailPanel is scoped to (selectedNodeId = L, selectedRound = N).
//   - 'lane-drawer' (option 2): the in-canvas drawer map holds L → N (cards inside the loop box).
// Before this seam, flipping the setting while a round was open simply STRANDED that drill: the
// old mode's representation kept its state but stopped rendering (the overlay gates lane-drawer on
// mode === 'lane-drawer'), and the new mode opened NOTHING — so the toggle read as a dead no-op.
//
// This helper translates the currently-open round from the OLD mode's representation into the NEW
// mode's, so the same round stays open across the switch (and the stale representation is cleared
// so it can't reappear on a later flip back). It is pure (no React, no DOM) so App.tsx can call it
// from the setter and a unit test can exercise the round-carrying directly.

import type { LoopDrillMode } from './expand-context.ts';

/** The drill state that differs between modes — the two representations of "round N of loop L". */
export interface LoopDrillState {
  /** round-axis: the DetailPanel-scoped loop node id (also set by a plain node click). */
  selectedNodeId: string | null;
  /** round-axis: the DetailPanel-scoped round, or null when no round axis is in scope. */
  selectedRound: number | null;
  /** lane-drawer: loopNodeId → the open round drawn in-canvas (empty in round-axis mode). */
  loopDrawerRound: ReadonlyMap<string, number>;
}

/**
 * Given the mode we're leaving (`from`) and entering (`to`) plus the current drill state, return
 * the migrated drill state so the open round survives the switch. A no-op switch (same mode, or no
 * open round to carry) returns the inputs unchanged in shape.
 *
 *  - round-axis → lane-drawer: if a round is scoped in the DetailPanel (selectedRound != null and a
 *    loop node is selected), seed the in-canvas drawer with {selectedNodeId → selectedRound} and
 *    clear the DetailPanel round scope (the round now lives in the loop box, not the panel).
 *  - lane-drawer → round-axis: if exactly one drawer is open, scope the DetailPanel to it
 *    (selectedNodeId/selectedRound) and clear the drawer map. With several open we carry the FIRST
 *    (insertion order) — the DetailPanel can only show one round at a time.
 */
export function migrateLoopDrill(
  from: LoopDrillMode,
  to: LoopDrillMode,
  state: LoopDrillState,
): LoopDrillState {
  if (from === to) return state;

  if (from === 'round-axis' && to === 'lane-drawer') {
    // Carry a DetailPanel-scoped round into the in-canvas drawer.
    if (state.selectedNodeId != null && state.selectedRound != null) {
      return {
        selectedNodeId: state.selectedNodeId, // keep the node selected; just drop the round scope
        selectedRound: null,
        loopDrawerRound: new Map([[state.selectedNodeId, state.selectedRound]]),
      };
    }
    // Nothing scoped → nothing to carry; just make sure no stale drawer lingers.
    return { ...state, loopDrawerRound: new Map() };
  }

  // lane-drawer → round-axis: carry the (first) open drawer into the DetailPanel scope.
  const first = firstEntry(state.loopDrawerRound);
  if (first) {
    return {
      selectedNodeId: first[0],
      selectedRound: first[1],
      loopDrawerRound: new Map(),
    };
  }
  // No drawer open → nothing to carry; ensure the map is empty for round-axis mode.
  return { ...state, loopDrawerRound: new Map() };
}

/** First entry (insertion order) of a map, or null when empty. */
function firstEntry(m: ReadonlyMap<string, number>): [string, number] | null {
  for (const e of m) return e;
  return null;
}
