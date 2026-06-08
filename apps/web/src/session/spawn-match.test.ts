import { describe, it, expect } from 'vitest';
import type { RunSummary } from '@argus/contract';
import { matchSpawnToRun } from './spawn-match.ts';

function run(runId: string, startTime: number | null): RunSummary {
  return {
    ref: { projectPath: '/p', slug: 's', sessionId: 'sess', runId },
    workflowName: 'wf',
    status: 'completed',
    agentCount: 0,
    durationMs: null,
    startTime,
    summary: '',
    partialFailure: false,
  };
}

describe('matchSpawnToRun — M3 spawn→run correlation (time window + uniqueness)', () => {
  const ts = '2026-06-04T09:25:05.010Z';
  const ms = Date.parse(ts);

  it('matches the unique run whose startTime equals the spawn timestamp (observed Δ=0)', () => {
    const runs = [run('wf_a', ms), run('wf_b', ms + 600_000)];
    expect(matchSpawnToRun({ timestamp: ts }, runs)?.ref.runId).toBe('wf_a');
  });

  it('matches within the slack window', () => {
    const runs = [run('wf_a', ms + 1500)];
    expect(matchSpawnToRun({ timestamp: ts }, runs)?.ref.runId).toBe('wf_a');
  });

  it('null when NO run falls in the window (inert chip)', () => {
    expect(matchSpawnToRun({ timestamp: ts }, [run('wf_a', ms + 60_000)])).toBeNull();
  });

  it('null (ZERO false positives) when >1 run falls in the window', () => {
    const runs = [run('wf_a', ms), run('wf_b', ms + 400)];
    expect(matchSpawnToRun({ timestamp: ts }, runs)).toBeNull();
  });

  it('null for a missing or unparseable timestamp', () => {
    expect(matchSpawnToRun({ timestamp: null }, [run('wf_a', ms)])).toBeNull();
    expect(matchSpawnToRun({ timestamp: 'not-a-date' }, [run('wf_a', ms)])).toBeNull();
  });
});
