import { describe, it, expect } from 'vitest';
import type { RunSummary, WorkflowMeta } from '@argus/contract';
import { groupRuns, type TreeNode } from './Rail.tsx';

// The 'workflow' LENS of groupRuns: every DISTINCT workflowName must become its own NAMED folder —
// declared workflows AND ad-hoc/inline runs alike — so a run is findable by name in the Workflow
// lens just as it is under Time/Status. There is NO opaque "(other runs)" catch-all anymore.

let nextStart = 1_000;
/** A minimal finished RunSummary; startTime auto-increments so "newer" runs are easy to assert. */
function run(workflowName: string, opts: Partial<RunSummary> = {}): RunSummary {
  const startTime = opts.startTime ?? (nextStart += 1_000);
  return {
    ref: { projectPath: '/p', slug: 'p', sessionId: `s-${startTime}`, runId: `r-${startTime}` },
    workflowName,
    status: 'completed',
    agentCount: 1,
    durationMs: 1000,
    startTime,
    summary: '',
    partialFailure: false,
    ...opts,
  };
}

function wf(name: string, file = `${name}.js`): WorkflowMeta {
  return { file, name, description: '', whenToUse: null, phases: [], model: null };
}

const byKey = (nodes: TreeNode[]) => new Map(nodes.map((n) => [n.key, n]));

describe('groupRuns — Workflow lens names every distinct workflow (no "(other runs)" bucket)', () => {
  it('gives an ad-hoc workflowName its OWN named, findable folder', () => {
    const runs = [run('argus-view-unification'), run('plan-research')];
    const declared = [wf('plan-research')]; // only plan-research is a DECLARED workflow

    const nodes = groupRuns(runs, declared, 'workflow');
    const keyed = byKey(nodes);

    // The ad-hoc run is no longer hidden: it's a named folder keyed by its workflowName.
    const adHoc = keyed.get('wf:argus-view-unification');
    expect(adHoc).toBeDefined();
    expect(adHoc!.name).toBe('argus-view-unification');
    expect(adHoc!.workflow).toBeNull(); // ad-hoc → no declared workflow / no Plan
    expect(adHoc!.runs).toHaveLength(1);

    // And nothing is dumped into a catch-all bucket.
    expect(keyed.has('orphans')).toBe(false);
    expect(nodes.some((n) => n.name === '(other runs)')).toBe(false);
  });

  it('sorts multiple ad-hoc workflows by recency (newest-first)', () => {
    const older = run('argus-sidebar-redesign', { startTime: 5_000 });
    const newer = run('argus-view-unification', { startTime: 9_000 });
    const nodes = groupRuns([older, newer], [], 'workflow');

    const adHocNames = nodes.map((n) => n.name);
    expect(adHocNames).toEqual(['argus-view-unification', 'argus-sidebar-redesign']);
  });

  it('keeps declared empty workflows (after declared-with-runs, before ad-hoc)', () => {
    const runs = [run('plan-research', { startTime: 8_000 }), run('argus-view-unification', { startTime: 9_000 })];
    const declared = [wf('plan-research'), wf('empty-flow')]; // empty-flow has zero runs

    const nodes = groupRuns(runs, declared, 'workflow');
    const order = nodes.map((n) => n.name);

    // declared WITH runs first, then declared EMPTY, then ad-hoc.
    expect(order).toEqual(['plan-research', 'empty-flow', 'argus-view-unification']);
    const empty = nodes.find((n) => n.name === 'empty-flow');
    expect(empty!.runs).toHaveLength(0);
    expect(empty!.workflow).not.toBeNull();
  });

  it('keeps every run in the tree (declared + ad-hoc; none hidden)', () => {
    const runs = [run('plan-research'), run('argus-view-unification'), run('argus-sidebar-redesign'), run('plan-research')];
    const declared = [wf('plan-research')];

    const nodes = groupRuns(runs, declared, 'workflow');
    const total = nodes.reduce((acc, n) => acc + n.runs.length, 0);
    expect(total).toBe(runs.length); // all 4 runs accounted for across named folders
  });

  it('a running run is never bucketed into the Workflow lens', () => {
    const runs = [run('argus-view-unification', { status: 'running' }), run('argus-view-unification')];
    const nodes = groupRuns(runs, [], 'workflow');
    const adHoc = nodes.find((n) => n.name === 'argus-view-unification');
    expect(adHoc!.runs).toHaveLength(1); // only the finished one
  });
});

describe('groupRuns — PINNED workflows float to the top of the Workflow lens', () => {
  it('floats a pinned declared workflow above a more-recent declared-with-runs', () => {
    // recent (top by recency) vs older-but-pinned: pinned wins.
    const runs = [run('recent-flow', { startTime: 9_000 }), run('old-flow', { startTime: 5_000 })];
    const declared = [wf('recent-flow'), wf('old-flow')];

    const nodes = groupRuns(runs, declared, 'workflow', new Set(['old-flow']));
    expect(nodes.map((n) => n.name)).toEqual(['old-flow', 'recent-flow']);
  });

  it('floats a pinned EMPTY declared workflow above a declared-with-runs', () => {
    const runs = [run('busy-flow', { startTime: 9_000 })];
    const declared = [wf('busy-flow'), wf('empty-flow')]; // empty-flow has zero runs

    const nodes = groupRuns(runs, declared, 'workflow', new Set(['empty-flow']));
    // pinned (even though empty) is first; busy-flow follows.
    expect(nodes.map((n) => n.name)).toEqual(['empty-flow', 'busy-flow']);
  });

  it('floats a pinned AD-HOC workflow above declared workflows', () => {
    const runs = [run('declared-flow', { startTime: 9_000 }), run('ad-hoc-flow', { startTime: 5_000 })];
    const declared = [wf('declared-flow')]; // ad-hoc-flow is NOT declared

    const nodes = groupRuns(runs, declared, 'workflow', new Set(['ad-hoc-flow']));
    expect(nodes[0]!.name).toBe('ad-hoc-flow');
    expect(nodes[0]!.workflow).toBeNull();
  });

  it('sorts multiple pinned workflows by recency among themselves (newest-first)', () => {
    const runs = [run('pin-old', { startTime: 5_000 }), run('pin-new', { startTime: 9_000 }), run('unpinned', { startTime: 7_000 })];
    const declared = [wf('pin-old'), wf('pin-new'), wf('unpinned')];

    const nodes = groupRuns(runs, declared, 'workflow', new Set(['pin-old', 'pin-new']));
    // both pinned (recency among themselves) before the unpinned one.
    expect(nodes.map((n) => n.name)).toEqual(['pin-new', 'pin-old', 'unpinned']);
  });

  it('ranks the full ladder: pinned → declared-with-runs → declared-empty → ad-hoc', () => {
    const runs = [
      run('withruns', { startTime: 9_000 }),
      run('pinned', { startTime: 1_000 }),
      run('adhoc', { startTime: 8_000 }),
    ];
    const declared = [wf('pinned'), wf('withruns'), wf('empty')]; // empty has zero runs; adhoc undeclared

    const nodes = groupRuns(runs, declared, 'workflow', new Set(['pinned']));
    expect(nodes.map((n) => n.name)).toEqual(['pinned', 'withruns', 'empty', 'adhoc']);
  });

  it('falls back to the normal recency sort when the pinned set is empty', () => {
    const runs = [run('a', { startTime: 5_000 }), run('b', { startTime: 9_000 })];
    const declared = [wf('a'), wf('b')];
    // no pinned arg → default empty Set → unchanged baseline order (b newer, so first).
    expect(groupRuns(runs, declared, 'workflow').map((n) => n.name)).toEqual(['b', 'a']);
  });

  it('IGNORES the pinned set in the Time lens (buckets are not per-workflow)', () => {
    const runs = [run('flow-x'), run('flow-y')];
    const declared = [wf('flow-x'), wf('flow-y')];
    const withPin = groupRuns(runs, declared, 'time', new Set(['flow-y']));
    const noPin = groupRuns(runs, declared, 'time');
    // Time buckets are identical with or without a pin — pinning has no effect off the Workflow lens.
    expect(withPin.map((n) => n.key)).toEqual(noPin.map((n) => n.key));
    // and the bucket keys are time:* (never a wf folder lifted by a pin).
    expect(withPin.every((n) => n.key.startsWith('time:'))).toBe(true);
  });

  it('IGNORES the pinned set in the Status lens', () => {
    const runs = [run('flow-x', { status: 'failed' }), run('flow-y', { status: 'completed' })];
    const declared = [wf('flow-x'), wf('flow-y')];
    const withPin = groupRuns(runs, declared, 'status', new Set(['flow-y']));
    const noPin = groupRuns(runs, declared, 'status');
    expect(withPin.map((n) => n.key)).toEqual(noPin.map((n) => n.key));
    expect(withPin.every((n) => n.key.startsWith('status:'))).toBe(true);
  });
});
