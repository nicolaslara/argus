import { describe, it, expect } from 'vitest';
import type { AgentNode, AgentState, RunModel, RunStatus } from '@argus/contract';
import { deriveFailureInfo, pickFailurePoint, formatArgs } from './failure-info.ts';

// STEP 3 — the run failure analysis (extracted from App.tsx). Three independent pure
// helpers: deriveFailureInfo (banner content + red-ring agentIds), pickFailurePoint (the
// proximate failure point), and formatArgs (the objective "called on <args>" line). No
// React, no DOM — exercised over hand-built RunModel/AgentNode fixtures.

function agent(over: Partial<AgentNode> & { agentId: string }): AgentNode {
  return {
    index: 0,
    label: '',
    phaseIndex: 1,
    model: null,
    state: 'done' as AgentState,
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

function run(over: Partial<RunModel> = {}): RunModel {
  return {
    ref: { projectPath: '/p', slug: '-p', sessionId: 's', runId: 'wf_x' },
    workflowName: 'wf',
    status: 'completed' as RunStatus,
    incomplete: false,
    startTime: 0,
    durationMs: null,
    defaultModel: null,
    summary: '',
    phases: [],
    agents: [],
    edges: [],
    logs: [],
    partialFailure: { present: false, lines: [] },
    error: null,
    args: null,
    warnings: [],
    format: 'cc-workflow/observed-2026-06-04',
    ...over,
  };
}

describe('deriveFailureInfo', () => {
  it('returns null for an undefined run', () => {
    expect(deriveFailureInfo(undefined)).toBeNull();
  });

  it('returns null for a completed run with no error', () => {
    expect(deriveFailureInfo(run({ status: 'completed', error: null }))).toBeNull();
  });

  it('treats a completed run that nonetheless carries an error as failed', () => {
    const info = deriveFailureInfo(run({ status: 'completed', error: { message: 'boom' } }));
    expect(info).not.toBeNull();
    expect(info!.message).toBe('boom');
  });

  it('treats status:"failed" as failed even without an error object', () => {
    const info = deriveFailureInfo(run({ status: 'failed', error: null }));
    expect(info).not.toBeNull();
    // Defensive default message — never an empty banner.
    expect(info!.message).toBe('this run ended in failure');
  });

  it('picks the latest-started DEAD agent as the failure point and rings every dead id', () => {
    const a = agent({ agentId: 'a', label: 'first', state: 'done', startedAt: 100 });
    const b = agent({ agentId: 'b', label: 'broke-early', state: 'error', startedAt: 200 });
    const c = agent({ agentId: 'c', label: 'broke-late', state: 'interrupted', startedAt: 300 });
    const info = deriveFailureInfo(
      run({ status: 'failed', durationMs: 1234, agents: [a, b, c] }),
    );
    expect(info!.failingAgentId).toBe('c');
    expect(info!.failingLabel).toBe('broke-late');
    expect(info!.elapsedMs).toBe(1234);
    // Both dead agents are ringed (b + c), but NOT the done agent a.
    expect([...info!.failureAgentIds].sort()).toEqual(['b', 'c']);
  });

  it('FALLBACK: a failed run with NO dead agents pins the last-started agent', () => {
    // Workflow-level failure: every agent recorded done, but the run carries an error.
    const a = agent({ agentId: 'a', label: 'early', state: 'done', startedAt: 100 });
    const b = agent({ agentId: 'b', label: 'late', state: 'done', startedAt: 500 });
    const info = deriveFailureInfo(
      run({ status: 'failed', error: { message: 'no StructuredOutput' }, agents: [a, b] }),
    );
    expect(info!.failingAgentId).toBe('b');
    expect(info!.failingLabel).toBe('late');
    // Only the proximate point is ringed in the fallback path.
    expect([...info!.failureAgentIds]).toEqual(['b']);
  });

  it('passes through internalDetail (the raw stack) and falls back to id when label is blank', () => {
    const a = agent({ agentId: 'agent-007', label: '', state: 'error', startedAt: 10 });
    const info = deriveFailureInfo(
      run({
        status: 'failed',
        error: { message: 'oops', internalDetail: 'at $bunfs/cli.js:1:1' },
        agents: [a],
      }),
    );
    expect(info!.internalDetail).toBe('at $bunfs/cli.js:1:1');
    expect(info!.failingLabel).toBe('agent-007');
  });

  it('a failed run with no agents at all yields null point / empty ring set', () => {
    const info = deriveFailureInfo(run({ status: 'failed', agents: [] }));
    expect(info!.failingAgentId).toBeNull();
    expect(info!.failingLabel).toBeNull();
    expect(info!.failureAgentIds.size).toBe(0);
  });
});

describe('pickFailurePoint', () => {
  it('returns null for an empty list', () => {
    expect(pickFailurePoint([])).toBeNull();
  });

  it('returns the single agent for a one-element list', () => {
    const a = agent({ agentId: 'solo', startedAt: 5 });
    expect(pickFailurePoint([a])).toBe(a);
  });

  it('picks the agent with the latest startedAt', () => {
    const a = agent({ agentId: 'a', startedAt: 100 });
    const b = agent({ agentId: 'b', startedAt: 300 });
    const c = agent({ agentId: 'c', startedAt: 200 });
    expect(pickFailurePoint([a, b, c])!.agentId).toBe('b');
  });

  it('falls back to queuedAt when startedAt is null', () => {
    const a = agent({ agentId: 'a', startedAt: null, queuedAt: 100 });
    const b = agent({ agentId: 'b', startedAt: null, queuedAt: 400 });
    expect(pickFailurePoint([a, b])!.agentId).toBe('b');
  });

  it('keeps the first when no agent has any timing (both null) — defaults to list head', () => {
    const a = agent({ agentId: 'a', startedAt: null, queuedAt: null });
    const b = agent({ agentId: 'b', startedAt: null, queuedAt: null });
    expect(pickFailurePoint([a, b])!.agentId).toBe('a');
  });

  it('ties on equal startedAt resolve to the LATER element (>= comparison)', () => {
    const a = agent({ agentId: 'a', startedAt: 200 });
    const b = agent({ agentId: 'b', startedAt: 200 });
    expect(pickFailurePoint([a, b])!.agentId).toBe('b');
  });

  it('a timed agent beats an untimed one regardless of order', () => {
    const untimed = agent({ agentId: 'u', startedAt: null, queuedAt: null });
    const timed = agent({ agentId: 't', startedAt: 50 });
    expect(pickFailurePoint([untimed, timed])!.agentId).toBe('t');
    expect(pickFailurePoint([timed, untimed])!.agentId).toBe('t');
  });
});

describe('formatArgs', () => {
  it('null / undefined → null', () => {
    expect(formatArgs(null)).toBeNull();
    expect(formatArgs(undefined)).toBeNull();
  });

  it('a short string is returned as-is', () => {
    expect(formatArgs('hello world')).toBe('hello world');
  });

  it('a string longer than 160 chars is truncated with an ellipsis', () => {
    const long = 'x'.repeat(200);
    const out = formatArgs(long)!;
    expect(out).toBe(`${'x'.repeat(160)}…`);
    expect(out.length).toBe(161); // 160 chars + the ellipsis glyph
  });

  it('a 160-char string is NOT truncated (boundary)', () => {
    const exact = 'y'.repeat(160);
    expect(formatArgs(exact)).toBe(exact);
  });

  it('numbers and booleans stringify', () => {
    expect(formatArgs(42)).toBe('42');
    expect(formatArgs(0)).toBe('0');
    expect(formatArgs(true)).toBe('true');
    expect(formatArgs(false)).toBe('false');
  });

  it('an empty array → null', () => {
    expect(formatArgs([])).toBeNull();
  });

  it('a non-empty array → "N items: …" (singular for 1)', () => {
    expect(formatArgs(['a'])).toBe('1 item: a');
    expect(formatArgs(['a', 'b'])).toBe('2 items: a, b');
  });

  it('an array of >4 items shows the first four + an ellipsis', () => {
    expect(formatArgs([1, 2, 3, 4, 5, 6])).toBe('6 items: 1, 2, 3, 4, …');
  });

  it('array elements that are non-strings are JSON-stringified', () => {
    expect(formatArgs([{ k: 1 }, 'plain'])).toBe('2 items: {"k":1}, plain');
  });

  it('an empty object → null', () => {
    expect(formatArgs({})).toBeNull();
  });

  it('a non-empty object → "k: v · …" rows', () => {
    expect(formatArgs({ a: 'one', b: 'two' })).toBe('a: one · b: two');
  });

  it('object values that are non-strings are JSON-stringified', () => {
    expect(formatArgs({ count: 3, nested: { x: 1 } })).toBe('count: 3 · nested: {"x":1}');
  });

  it('an object shows at most the first 5 keys', () => {
    const out = formatArgs({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 })!;
    expect(out).toBe('a: 1 · b: 2 · c: 3 · d: 4 · e: 5');
    expect(out.includes('f:')).toBe(false);
  });
});
