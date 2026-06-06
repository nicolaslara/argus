// @argus/web — the explorer FILTER lens: a pure, testable substring filter over the
// already-grouped tree. This is the "escape hatch" that keeps the rail usable as run
// counts grow: the group-by lens (Workflow/Time/Status) decides the SHAPE, the filter
// narrows WHICH runs show inside that shape. The two compose orthogonally — filterTree()
// runs AFTER groupRuns(), so it never has to know how the tree was bucketed.
//
// Pure + deterministic (no React, no wall clock): a query in, a narrowed TreeNode[] out.
// Consumes ONLY @argus/contract types (+ the TreeNode shape, imported as a TYPE so this
// stays a leaf module with no runtime dependency on Rail.tsx).

import type { RunSummary } from '@argus/contract';
import type { TreeNode } from './shell/Rail.tsx';

/** Normalize a query for case-insensitive substring matching (trim → lowercase). */
function normalize(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * Does a single run match the (already-normalized) query? Matches on the two fields a
 * reader actually scans for: the workflow NAME and the terminal STATUS (so `fail` finds
 * `failed`, `kill` finds `killed`, `comp` finds `completed`). An empty query matches all.
 */
function runMatches(run: RunSummary, normalized: string): boolean {
  if (normalized === '') return true;
  return (
    run.workflowName.toLowerCase().includes(normalized) ||
    run.status.toLowerCase().includes(normalized)
  );
}

/**
 * Filter a flat RunSummary[] by a substring query on workflowName + status
 * (case-insensitive). An empty/whitespace query is a no-op (returns the list unchanged).
 */
export function filterRuns(runs: RunSummary[], query: string): RunSummary[] {
  const normalized = normalize(query);
  if (normalized === '') return runs;
  return runs.filter((r) => runMatches(r, normalized));
}

/**
 * Filter a grouped TreeNode[] by a substring query. A folder/bucket is KEPT iff either:
 *   - its own NAME matches (so e.g. filtering `plan` keeps the whole "plan-research"
 *     folder with all its runs — you asked for that workflow), or
 *   - at least one of its RUNS matches (the folder is kept, narrowed to the matches).
 * Folders left with zero runs after narrowing are DROPPED, so the tree stays clean (no
 * empty headers). An empty/whitespace query is a no-op (returns the tree unchanged).
 */
export function filterTree(tree: TreeNode[], query: string): TreeNode[] {
  const normalized = normalize(query);
  if (normalized === '') return tree;
  const out: TreeNode[] = [];
  for (const node of tree) {
    const nameMatches = node.name.toLowerCase().includes(normalized);
    // A name match keeps every run; otherwise keep only the runs that match themselves.
    const runs = nameMatches ? node.runs : node.runs.filter((r) => runMatches(r, normalized));
    if (runs.length === 0) continue; // drop folders/buckets with nothing to show
    // Preserve the node shape; only the run membership narrows (orderKey kept frozen).
    out.push(runs === node.runs ? node : { ...node, runs });
  }
  return out;
}
