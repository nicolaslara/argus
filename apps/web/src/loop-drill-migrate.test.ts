import { describe, it, expect } from 'vitest';
import { migrateLoopDrill, type LoopDrillState } from './loop-drill-migrate.ts';

// migrateLoopDrill carries an OPEN loop-round across a mode switch so flipping the loop-drill
// setting is RESPONSIVE (the same round stays open in the new mode) instead of stranding the drill.

const empty: LoopDrillState = { selectedNodeId: null, selectedRound: null, loopDrawerRound: new Map() };

describe('migrateLoopDrill — round carries across a loop-drill mode switch', () => {
  it('round-axis → lane-drawer: a panel-scoped round becomes the in-canvas drawer', () => {
    const state: LoopDrillState = { selectedNodeId: 'loop:A', selectedRound: 2, loopDrawerRound: new Map() };
    const next = migrateLoopDrill('round-axis', 'lane-drawer', state);

    expect(next.loopDrawerRound.get('loop:A')).toBe(2); // round now drawn inside the loop box
    expect(next.selectedRound).toBeNull(); // the DetailPanel round scope is cleared
    expect(next.selectedNodeId).toBe('loop:A'); // the loop stays selected
  });

  it('lane-drawer → round-axis: the open drawer becomes the DetailPanel scope', () => {
    const state: LoopDrillState = {
      selectedNodeId: null,
      selectedRound: null,
      loopDrawerRound: new Map([['loop:B', 3]]),
    };
    const next = migrateLoopDrill('lane-drawer', 'round-axis', state);

    expect(next.selectedNodeId).toBe('loop:B');
    expect(next.selectedRound).toBe(3);
    expect(next.loopDrawerRound.size).toBe(0); // the in-canvas drawer is cleared
  });

  it('a no-op switch (same mode) returns the state unchanged', () => {
    const state: LoopDrillState = { selectedNodeId: 'loop:A', selectedRound: 1, loopDrawerRound: new Map() };
    expect(migrateLoopDrill('round-axis', 'round-axis', state)).toBe(state);
  });

  it('round-axis → lane-drawer with NO round scoped carries nothing (empty drawer)', () => {
    const next = migrateLoopDrill('round-axis', 'lane-drawer', empty);
    expect(next.loopDrawerRound.size).toBe(0);
    expect(next.selectedRound).toBeNull();
  });

  it('lane-drawer → round-axis with NO drawer open carries nothing (empty scope)', () => {
    const next = migrateLoopDrill('lane-drawer', 'round-axis', empty);
    expect(next.selectedNodeId).toBeNull();
    expect(next.selectedRound).toBeNull();
    expect(next.loopDrawerRound.size).toBe(0);
  });

  it('lane-drawer → round-axis with several drawers open carries the first (panel shows one)', () => {
    const state: LoopDrillState = {
      selectedNodeId: null,
      selectedRound: null,
      loopDrawerRound: new Map([
        ['loop:first', 1],
        ['loop:second', 4],
      ]),
    };
    const next = migrateLoopDrill('lane-drawer', 'round-axis', state);
    expect(next.selectedNodeId).toBe('loop:first');
    expect(next.selectedRound).toBe(1);
  });

  it('does not mutate the input drawer map', () => {
    const original = new Map([['loop:A', 2]]);
    const state: LoopDrillState = { selectedNodeId: null, selectedRound: null, loopDrawerRound: original };
    migrateLoopDrill('lane-drawer', 'round-axis', state);
    expect(original.get('loop:A')).toBe(2); // untouched
    expect(original.size).toBe(1);
  });
});
