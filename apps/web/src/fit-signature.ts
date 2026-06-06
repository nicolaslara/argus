// Live & inspection #2 (SUB-TASK C): the STRUCTURAL fit signature, extracted from App so it
// is unit-testable. The signature gates the one-shot structural fitView: the viewport only
// re-fits when this string changes. Two invariants make the live→finalized swap jump-free:
//
//  1. INSTANCE / DRAWER churn is excluded. A live run spawning an `agentCard`, a ghost
//     vanishing, or an `instanceGroup` drawer opening must NOT re-fit (run-view-merge-plan.md
//     §2 "Refit on a live tick: NEVER"). Only the PLAN node ids count toward the signature.
//
//  2. The signature keys on `view` + the selected `runId` + the plan-node id set. The runId is
//     stable DURING a run (a live tick keeps it), and — paired with SUB-TASK C's stable run
//     query key — a live→finalized transition reuses the same plan template, so the plan-node
//     id set is unchanged. The signature therefore does NOT change on finalize and the viewport
//     stays put. Switching to a DIFFERENT run (a new runId) DOES change it, so run-switching
//     still re-fits; and the initial empty→populated load changes it, so the first fit fires.

/** The minimal node shape the signature reads (id + the optional React Flow node type). */
export interface FitSignatureNode {
  id: string;
  type?: string;
}

/** The instance/drawer node types whose churn must never trigger a structural re-fit. */
const NON_STRUCTURAL_TYPES = new Set(['instanceGroup', 'agentCard']);

/**
 * Compute the structural fit signature for the current view/run/graph. Pure: the same inputs
 * always yield the same string, and only a structural change (view, run identity, or the set
 * of PLAN node ids) alters it.
 */
export function computeFitSignature(
  view: string,
  runId: string | undefined,
  nodes: readonly FitSignatureNode[],
): string {
  return (
    `${view}:${runId ?? ''}:` +
    nodes
      .filter((n) => !NON_STRUCTURAL_TYPES.has(n.type ?? ''))
      .map((n) => n.id)
      .join(',')
  );
}
