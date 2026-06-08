// @argus/web — M3 spawn→run correlation (client-side).
//
// A Story block records WorkflowSpawns (a Workflow tool_use: scriptBasename + timestamp). The
// chip should jump straight to that RUN in the Workflows page — but the spawn's scriptBasename
// (the template FILE, e.g. `plan-research.js`) does NOT match the run's workflowName (its
// meta.name, e.g. `argus-plan-research` / `explore-session-narrative`): one template script
// produces differently-named runs. The reliable join is TIME: a finalized run's `startTime`
// equals the spawning tool_use's timestamp (observed Δ=0 ms on the real session; the next-closest
// run is always minutes away). So we match on a tight time window AND require UNIQUENESS — a spawn
// with zero or >1 run in the window resolves to null (inert chip), keeping false positives at zero.

import type { RunSummary, WorkflowSpawn } from '@argus/contract';

/** ± window (ms) around the spawn timestamp. run.startTime is observed to equal it to the ms;
 *  a small slack absorbs any clock granularity while staying far below the minutes-away runner-up. */
export const SPAWN_MATCH_WINDOW_MS = 2000;

/**
 * Resolve the run a WorkflowSpawn launched, or null when it can't be matched UNAMBIGUOUSLY.
 * Pure; never throws. Match = the unique run whose `startTime` is within
 * {@link SPAWN_MATCH_WINDOW_MS} of the spawn's timestamp. Zero or multiple candidates → null.
 */
export function matchSpawnToRun(
  spawn: Pick<WorkflowSpawn, 'timestamp'>,
  runs: RunSummary[],
): RunSummary | null {
  if (!spawn.timestamp) return null;
  const t = Date.parse(spawn.timestamp);
  if (!Number.isFinite(t)) return null;
  const within = runs.filter((r) => r.startTime != null && Math.abs(r.startTime - t) <= SPAWN_MATCH_WINDOW_MS);
  return within.length === 1 ? within[0]! : null;
}
