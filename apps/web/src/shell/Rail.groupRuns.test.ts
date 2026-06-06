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
