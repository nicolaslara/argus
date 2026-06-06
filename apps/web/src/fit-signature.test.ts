import { describe, it, expect } from 'vitest';
import { computeFitSignature, type FitSignatureNode } from './fit-signature.ts';

// Live & inspection #2 (SUB-TASK C) — the structural fit signature gates the one-shot
// structural fitView. The no-jump-finalize invariant rests on TWO properties this pins:
//   (1) instance/drawer churn (agentCard / instanceGroup) NEVER changes the signature → a live
//       tick or an opened drawer doesn't re-fit/yank the viewport;
//   (2) the signature keys on view + runId + the PLAN node-id set, all stable across a
//       live→finalized swap (same run, same plan template) → finalize doesn't re-fit.

const plan: FitSignatureNode[] = [
  { id: 'plan-lane-1', type: 'phaseLane' },
  { id: 'agent:research:1', type: 'planAgent' },
  { id: 'merge-3', type: 'planMarker' },
];

describe('computeFitSignature', () => {
  it('is stable for the same view + runId + plan-node set', () => {
    expect(computeFitSignature('run', 'r1', plan)).toBe(computeFitSignature('run', 'r1', plan));
  });

  it('does NOT change when instance cards / drawers churn (the no-yank-on-live-tick invariant)', () => {
    const base = computeFitSignature('run', 'r1', plan);
    // a live tick spawns instance cards + an expand drawer — these must be invisible to the fit.
    const withChurn: FitSignatureNode[] = [
      ...plan,
      { id: 'instances-agent:research:1', type: 'instanceGroup' },
      { id: 'inst-agent:research:1-aid-0', type: 'agentCard' },
      { id: 'inst-agent:research:1-aid-1', type: 'agentCard' },
    ];
    expect(computeFitSignature('run', 'r1', withChurn)).toBe(base);
  });

  it('is UNCHANGED across a live→finalized swap (same runId + same plan template)', () => {
    // The only thing that differs on finalize is instance/drawer churn (excluded) — the plan
    // node set + runId + view are identical, so the signature must not move.
    const live = computeFitSignature('run', 'r1', [...plan, { id: 'inst-x', type: 'agentCard' }]);
    const finalized = computeFitSignature('run', 'r1', [
      ...plan,
      { id: 'inst-x', type: 'agentCard' },
      { id: 'inst-y', type: 'agentCard' }, // a late instance that arrived as the run finished
    ]);
    expect(finalized).toBe(live);
  });

  it('CHANGES when switching to a different run (so run-switching still re-fits)', () => {
    expect(computeFitSignature('run', 'r2', plan)).not.toBe(computeFitSignature('run', 'r1', plan));
  });

  it('CHANGES when the plan node set changes (a different workflow → re-fit)', () => {
    const other: FitSignatureNode[] = [{ id: 'plan-lane-1', type: 'phaseLane' }];
    expect(computeFitSignature('run', 'r1', other)).not.toBe(computeFitSignature('run', 'r1', plan));
  });

  it('CHANGES on a view switch (plan ↔ run re-fits)', () => {
    expect(computeFitSignature('plan', 'r1', plan)).not.toBe(computeFitSignature('run', 'r1', plan));
  });

  it('treats a missing runId as empty (the run-free Plan view) without throwing', () => {
    expect(computeFitSignature('plan', undefined, plan)).toBe(computeFitSignature('plan', undefined, plan));
  });
});
