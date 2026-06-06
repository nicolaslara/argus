import { describe, it, expect } from 'vitest';
import type { RunSummary } from '@argus/contract';
import { filterRuns, filterTree } from './filter-runs.ts';
import type { TreeNode } from './shell/Rail.tsx';

// filterRuns / filterTree are the pure FILTER lens: a case-insensitive substring match on
// workflowName + status, composing AFTER groupRuns(). Empty query = no-op; a folder is kept
// iff its NAME matches (keeps all runs) OR a child run matches (kept, narrowed); empty
// folders/buckets are dropped so the tree stays clean.

let seq = 0;
function run(workflowName: string, status: RunSummary['status'] = 'completed'): RunSummary {
  seq += 1;
  return {
    ref: { projectPath: '/p', slug: 'p', sessionId: `s-${seq}`, runId: `r-${seq}` },
    workflowName,
    status,
    agentCount: 1,
    durationMs: 1000,
    startTime: seq * 1000,
    summary: '',
    partialFailure: false,
  };
}

function node(key: string, name: string, runs: RunSummary[], kind?: 'bucket'): TreeNode {
  return {
    key,
    name,
    workflow: null,
    runs,
    orderKey: runs.reduce((m, r) => Math.max(m, r.startTime ?? 0), 0),
    ...(kind ? { kind } : {}),
  };
}

describe('filterRuns — substring filter on workflowName + status (case-insensitive)', () => {
  const runs = [run('plan-research'), run('implement'), run('refine-plan', 'failed'), run('build', 'killed')];

  it('returns the list UNCHANGED for an empty / whitespace query (no-op)', () => {
    expect(filterRuns(runs, '')).toBe(runs);
    expect(filterRuns(runs, '   ')).toBe(runs);
  });

  it('matches workflowName substrings case-insensitively', () => {
    const got = filterRuns(runs, 'PLAN');
    expect(got.map((r) => r.workflowName)).toEqual(['plan-research', 'refine-plan']);
  });

  it('matches status substrings (fail → failed, kill → killed)', () => {
    expect(filterRuns(runs, 'fail').map((r) => r.workflowName)).toEqual(['refine-plan']);
    expect(filterRuns(runs, 'kill').map((r) => r.workflowName)).toEqual(['build']);
  });

  it('returns [] when nothing matches', () => {
    expect(filterRuns(runs, 'zzz-nope')).toEqual([]);
  });
});

describe('filterTree — narrows a grouped tree, composing with the group-by lens', () => {
  const tree: TreeNode[] = [
    node('wf:plan-research', 'plan-research', [run('plan-research'), run('plan-research', 'failed')]),
    node('wf:implement', 'implement', [run('implement'), run('implement')]),
  ];

  it('returns the tree UNCHANGED for an empty query (no-op, same reference)', () => {
    expect(filterTree(tree, '')).toBe(tree);
  });

  it('keeps a whole folder when the folder NAME matches (all its runs survive)', () => {
    const got = filterTree(tree, 'plan-research');
    expect(got).toHaveLength(1);
    expect(got[0]!.name).toBe('plan-research');
    expect(got[0]!.runs).toHaveLength(2); // name match keeps every run
  });

  it('keeps a folder by a child RUN match, narrowing to the matching runs', () => {
    // 'fail' does not match either folder NAME, but matches the failed run inside plan-research.
    const got = filterTree(tree, 'fail');
    expect(got).toHaveLength(1);
    expect(got[0]!.name).toBe('plan-research');
    expect(got[0]!.runs).toHaveLength(1);
    expect(got[0]!.runs[0]!.status).toBe('failed');
  });

  it('drops folders/buckets that have no matching runs (clean tree)', () => {
    const got = filterTree(tree, 'implement');
    expect(got.map((n) => n.name)).toEqual(['implement']);
  });

  it('returns [] when no folder name or run matches', () => {
    expect(filterTree(tree, 'zzz-nope')).toEqual([]);
  });

  it('preserves the node shape (key/kind/orderKey) when narrowing a bucket', () => {
    const statusTree: TreeNode[] = [
      node('status:failed', 'Failed', [run('plan-research', 'failed'), run('implement', 'failed')], 'bucket'),
    ];
    const got = filterTree(statusTree, 'plan');
    expect(got).toHaveLength(1);
    expect(got[0]!.key).toBe('status:failed');
    expect(got[0]!.kind).toBe('bucket');
    expect(got[0]!.runs).toHaveLength(1);
    expect(got[0]!.runs[0]!.workflowName).toBe('plan-research');
  });
});
