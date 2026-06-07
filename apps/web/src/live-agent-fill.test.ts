// @argus/web — unit tests for the PURE live-fill target-selection seam (AV8). The React hook
// (useLiveAgentFill) is thin glue over `pickLiveFillTargets` + `needsFill`; we test the logic
// that decides WHICH agents get an eager /activity fetch each live tick, and in what order.

import { describe, it, expect } from 'vitest';
import type { AgentNode, AgentState } from '@argus/contract';
import { needsFill, pickLiveFillTargets, MAX_LIVE_FILL } from './live-agent-fill.ts';

/** Minimal AgentNode factory — only the fields the fill logic reads matter. */
function agent(
  id: string,
  state: AgentState,
  over: Partial<AgentNode> = {},
): AgentNode {
  return {
    agentId: id,
    index: 0,
    label: id,
    phaseIndex: 1,
    model: null,
    state,
    cached: false,
    agentType: null,
    attempt: null,
    failedInLogs: false,
    tokens: null,
    toolCalls: null,
    durationMs: null,
    queuedAt: null,
    startedAt: null,
    lastProgressAt: null,
    lastToolName: null,
    lastToolSummary: null,
    promptPreview: null,
    resultPreview: null,
    ...over,
  };
}

describe('needsFill', () => {
  it('true for an in-flight agent (running/queued) regardless of metrics', () => {
    expect(needsFill(agent('a', 'running', { durationMs: 5, tokens: 9 }))).toBe(true);
    expect(needsFill(agent('b', 'queued', { durationMs: 5, tokens: 9 }))).toBe(true);
  });
  it('true for a finished agent MISSING dur or tok (journal-starved)', () => {
    expect(needsFill(agent('c', 'done', { durationMs: null, tokens: 9 }))).toBe(true);
    expect(needsFill(agent('d', 'done', { durationMs: 5, tokens: null }))).toBe(true);
  });
  it('false for a finished agent carrying BOTH dur AND tok (the model is the truth)', () => {
    expect(needsFill(agent('e', 'done', { durationMs: 5, tokens: 9 }))).toBe(false);
  });
});

describe('pickLiveFillTargets', () => {
  it('prioritizes in-flight (running/queued) agents BEFORE the missing-metric tail', () => {
    const agents = [
      agent('done-missing', 'done', { durationMs: null, tokens: null }),
      agent('running-1', 'running'),
      agent('queued-1', 'queued'),
    ];
    // in-flight first (source order within group), then the rest.
    expect(pickLiveFillTargets(agents)).toEqual(['running-1', 'queued-1', 'done-missing']);
  });

  it('skips finished agents that already have both metrics', () => {
    const agents = [
      agent('complete', 'done', { durationMs: 5, tokens: 9 }),
      agent('running-1', 'running'),
    ];
    expect(pickLiveFillTargets(agents)).toEqual(['running-1']);
  });

  it('caps the result at MAX_LIVE_FILL, dropping the tail', () => {
    const agents = Array.from({ length: MAX_LIVE_FILL + 5 }, (_, i) => agent(`r${i}`, 'running'));
    const out = pickLiveFillTargets(agents);
    expect(out).toHaveLength(MAX_LIVE_FILL);
    expect(out[0]).toBe('r0');
    expect(out[MAX_LIVE_FILL - 1]).toBe(`r${MAX_LIVE_FILL - 1}`);
  });

  it('honors an explicit cap and keeps in-flight ahead of the tail within it', () => {
    const agents = [
      agent('done-missing', 'done', { durationMs: null, tokens: null }),
      agent('running-1', 'running'),
      agent('running-2', 'running'),
    ];
    // cap=2 → both running ones win the budget; the missing-metric done one is dropped.
    expect(pickLiveFillTargets(agents, 2)).toEqual(['running-1', 'running-2']);
  });

  it('returns [] when nothing needs a fill', () => {
    const agents = [agent('complete', 'done', { durationMs: 5, tokens: 9 })];
    expect(pickLiveFillTargets(agents)).toEqual([]);
  });
});
