import { describe, it, expect } from 'vitest';
import type { AgentNode, Phase } from '@argus/contract';
import {
  sortAgents,
  filterAgents,
  isFailure,
  phaseTitleOf,
  orderAgentsByExecution,
  STATE_ORDER,
  SORT_KEYS,
  DEFAULT_SORT,
} from './agent-table.ts';

// sortAgents / filterAgents are the PURE table lens (no React, no I/O). Tests craft minimal
// AgentNode objects inline (mirrors filter-runs.test.ts / mapping.test.ts) — no disk fixtures.
// Coverage: every sort key × asc/desc, nulls/0 sort last, string case-insensitivity, the fixed
// state enum order, the failure boolean, phase numeric + index tie-break, stability, and the
// filter substring (label/phase-title/model/state) + empty-query no-op.

let seq = 0;
function agent(over: Partial<AgentNode> = {}): AgentNode {
  seq += 1;
  return {
    agentId: over.agentId ?? `a-${seq}`,
    index: over.index ?? seq,
    label: over.label ?? `agent-${seq}`,
    phaseIndex: over.phaseIndex ?? 1,
    model: over.model ?? null,
    state: over.state ?? 'done',
    cached: over.cached ?? false,
    agentType: over.agentType ?? null,
    attempt: over.attempt ?? null,
    failedInLogs: over.failedInLogs ?? false,
    tokens: over.tokens ?? null,
    toolCalls: over.toolCalls ?? null,
    durationMs: over.durationMs ?? null,
    queuedAt: over.queuedAt ?? null,
    startedAt: over.startedAt ?? null,
    lastProgressAt: over.lastProgressAt ?? null,
    lastToolName: over.lastToolName ?? null,
    lastToolSummary: over.lastToolSummary ?? null,
    promptPreview: over.promptPreview ?? null,
    resultPreview: over.resultPreview ?? null,
  };
}

const PHASES: Phase[] = [
  { index: 1, title: 'Research', detail: null },
  { index: 2, title: 'Design', detail: null },
  { index: 3, title: 'Build', detail: null },
];

const labels = (rows: AgentNode[]) => rows.map((r) => r.label);

describe('sortAgents — purity + stability', () => {
  it('returns a NEW array and never mutates the input', () => {
    const input = [agent({ label: 'b', tokens: 10 }), agent({ label: 'a', tokens: 20 })];
    const json = JSON.stringify(input);
    const out = sortAgents(input, 'label', 'asc');
    expect(out).not.toBe(input);
    expect(JSON.stringify(input)).toBe(json); // input untouched
  });

  it('is STABLE — equal rows keep their input order', () => {
    // All same tokens → ties broken by input order, both asc and desc.
    const rows = [
      agent({ label: 'first', tokens: 100 }),
      agent({ label: 'second', tokens: 100 }),
      agent({ label: 'third', tokens: 100 }),
    ];
    expect(labels(sortAgents(rows, 'tokens', 'desc'))).toEqual(['first', 'second', 'third']);
    expect(labels(sortAgents(rows, 'tokens', 'asc'))).toEqual(['first', 'second', 'third']);
  });

  it('handles empty + single-element arrays', () => {
    expect(sortAgents([], 'tokens', 'desc')).toEqual([]);
    const one = [agent({ label: 'solo' })];
    expect(labels(sortAgents(one, 'label', 'asc'))).toEqual(['solo']);
  });
});

describe('sortAgents — numeric keys (tokens/duration/toolCalls): nulls & 0 sort LAST', () => {
  for (const key of ['tokens', 'duration', 'toolCalls'] as const) {
    const field = key === 'tokens' ? 'tokens' : key === 'duration' ? 'durationMs' : 'toolCalls';
    it(`${key}: desc orders large→small with null/0 last`, () => {
      const rows = [
        agent({ label: 'mid', [field]: 50 } as Partial<AgentNode>),
        agent({ label: 'zero', [field]: 0 } as Partial<AgentNode>),
        agent({ label: 'big', [field]: 100 } as Partial<AgentNode>),
        agent({ label: 'none', [field]: null } as Partial<AgentNode>),
      ];
      expect(labels(sortAgents(rows, key, 'desc'))).toEqual(['big', 'mid', 'zero', 'none']);
    });
    it(`${key}: asc orders small→large with null/0 STILL last (not first)`, () => {
      const rows = [
        agent({ label: 'mid', [field]: 50 } as Partial<AgentNode>),
        agent({ label: 'none', [field]: null } as Partial<AgentNode>),
        agent({ label: 'big', [field]: 100 } as Partial<AgentNode>),
        agent({ label: 'zero', [field]: 0 } as Partial<AgentNode>),
      ];
      // 0 and null both collapse to "no value" → after the real numbers, input order between them.
      expect(labels(sortAgents(rows, key, 'asc'))).toEqual(['mid', 'big', 'none', 'zero']);
    });
  }

  it('0 and null sort IDENTICALLY (both "no value")', () => {
    const rows = [
      agent({ label: 'real', tokens: 5 }),
      agent({ label: 'zero', tokens: 0 }),
      agent({ label: 'nul', tokens: null }),
    ];
    // zero before nul by input order; both after the real value, in both directions.
    expect(labels(sortAgents(rows, 'tokens', 'asc'))).toEqual(['real', 'zero', 'nul']);
    expect(labels(sortAgents(rows, 'tokens', 'desc'))).toEqual(['real', 'zero', 'nul']);
  });
});

describe('sortAgents — string keys (label/model): case-insensitive, empties last', () => {
  it('label asc/desc is case-insensitive', () => {
    const rows = [agent({ label: 'Banana' }), agent({ label: 'apple' }), agent({ label: 'Cherry' })];
    expect(labels(sortAgents(rows, 'label', 'asc'))).toEqual(['apple', 'Banana', 'Cherry']);
    expect(labels(sortAgents(rows, 'label', 'desc'))).toEqual(['Cherry', 'Banana', 'apple']);
  });

  it('empty label falls back to agentId then sorts last when truly empty', () => {
    const rows = [
      agent({ label: '', agentId: '', index: 1 }),
      agent({ label: 'zeta', index: 2 }),
      agent({ label: 'alpha', index: 3 }),
    ];
    // The empty-label/empty-id row has no display label → sorts LAST in asc.
    const out = labels(sortAgents(rows, 'label', 'asc'));
    expect(out[0]).toBe('alpha');
    expect(out[1]).toBe('zeta');
    expect(out[2]).toBe('');
  });

  it('model: nulls sort last (both directions), case-insensitive otherwise', () => {
    const rows = [
      agent({ label: 'opus', model: 'claude-Opus' }),
      agent({ label: 'none', model: null }),
      agent({ label: 'haiku', model: 'claude-haiku' }),
    ];
    expect(labels(sortAgents(rows, 'model', 'asc'))).toEqual(['haiku', 'opus', 'none']);
    expect(labels(sortAgents(rows, 'model', 'desc'))).toEqual(['opus', 'haiku', 'none']);
  });
});

describe('sortAgents — phase key (numeric 1→2→3, ties by agent.index)', () => {
  it('asc 1→3, desc 3→1', () => {
    const rows = [
      agent({ label: 'p3', phaseIndex: 3 }),
      agent({ label: 'p1', phaseIndex: 1 }),
      agent({ label: 'p2', phaseIndex: 2 }),
    ];
    expect(labels(sortAgents(rows, 'phase', 'asc', PHASES))).toEqual(['p1', 'p2', 'p3']);
    expect(labels(sortAgents(rows, 'phase', 'desc', PHASES))).toEqual(['p3', 'p2', 'p1']);
  });

  it('same phase → broken by agent.index', () => {
    const rows = [
      agent({ label: 'second', phaseIndex: 2, index: 20 }),
      agent({ label: 'first', phaseIndex: 2, index: 10 }),
    ];
    expect(labels(sortAgents(rows, 'phase', 'asc'))).toEqual(['first', 'second']);
  });
});

describe('sortAgents — state key (fixed enum order, success-first)', () => {
  it('STATE_ORDER is done<running<queued<error<interrupted<unknown', () => {
    expect(STATE_ORDER.done).toBeLessThan(STATE_ORDER.running);
    expect(STATE_ORDER.running).toBeLessThan(STATE_ORDER.queued);
    expect(STATE_ORDER.queued).toBeLessThan(STATE_ORDER.error);
    expect(STATE_ORDER.error).toBeLessThan(STATE_ORDER.interrupted);
    expect(STATE_ORDER.interrupted).toBeLessThan(STATE_ORDER.unknown);
  });

  it('asc puts done first; desc puts failures first', () => {
    const rows = [
      agent({ label: 'err', state: 'error' }),
      agent({ label: 'ok', state: 'done' }),
      agent({ label: 'run', state: 'running' }),
      agent({ label: 'unk', state: 'unknown' }),
    ];
    expect(labels(sortAgents(rows, 'state', 'asc'))).toEqual(['ok', 'run', 'err', 'unk']);
    expect(labels(sortAgents(rows, 'state', 'desc'))).toEqual(['unk', 'err', 'run', 'ok']);
  });
});

describe('sortAgents — failure boolean key', () => {
  it('asc surfaces failures first (error OR failedInLogs)', () => {
    const rows = [
      agent({ label: 'ok', state: 'done' }),
      agent({ label: 'errored', state: 'error' }),
      agent({ label: 'logfail', state: 'done', failedInLogs: true }),
    ];
    const asc = labels(sortAgents(rows, 'failure', 'asc'));
    expect(asc.slice(0, 2).sort()).toEqual(['errored', 'logfail']); // both failures, before 'ok'
    expect(asc[2]).toBe('ok');
    // desc hides failures at the bottom
    expect(labels(sortAgents(rows, 'failure', 'desc'))[0]).toBe('ok');
  });
});

describe('filterAgents — substring over label / phase title / model / state', () => {
  const rows = [
    agent({ label: 'research:surface', phaseIndex: 1, model: 'claude-opus', state: 'done' }),
    agent({ label: 'design:arch', phaseIndex: 2, model: 'claude-haiku', state: 'error' }),
    agent({ label: 'build:ci', phaseIndex: 3, model: null, state: 'running' }),
  ];

  it('empty / whitespace query is a no-op (same reference)', () => {
    expect(filterAgents(rows, '')).toBe(rows);
    expect(filterAgents(rows, '   ')).toBe(rows);
  });

  it('matches label case-insensitively', () => {
    expect(labels(filterAgents(rows, 'RESEARCH', PHASES))).toEqual(['research:surface']);
  });

  it('matches phase title (resolved via phases)', () => {
    expect(labels(filterAgents(rows, 'design', PHASES))).toEqual(['design:arch']);
  });

  it('matches model substring', () => {
    expect(labels(filterAgents(rows, 'haiku', PHASES))).toEqual(['design:arch']);
  });

  it('matches state (forgiving substring: "err" → error, "ERROR" → error)', () => {
    expect(labels(filterAgents(rows, 'err', PHASES))).toEqual(['design:arch']);
    expect(labels(filterAgents(rows, 'ERROR', PHASES))).toEqual(['design:arch']);
    expect(labels(filterAgents(rows, 'running', PHASES))).toEqual(['build:ci']);
  });

  it('no match → empty array', () => {
    expect(filterAgents(rows, 'zzz-nope', PHASES)).toEqual([]);
  });

  it('without phases, phase-title matching is simply skipped (label/model/state still work)', () => {
    expect(labels(filterAgents(rows, 'design'))).toEqual(['design:arch']); // label still matches
    expect(filterAgents(rows, 'Research-phase-title-only')).toEqual([]); // would need phases
  });
});

describe('filter + sort composition', () => {
  it('filtering then sorting yields the filtered subset in sorted order', () => {
    const rows = [
      agent({ label: 'design:b', phaseIndex: 2, tokens: 10 }),
      agent({ label: 'research:x', phaseIndex: 1, tokens: 999 }),
      agent({ label: 'design:a', phaseIndex: 2, tokens: 50 }),
    ];
    const filtered = filterAgents(rows, 'design', PHASES);
    expect(labels(sortAgents(filtered, 'tokens', 'desc'))).toEqual(['design:a', 'design:b']);
  });
});

describe('helpers', () => {
  it('isFailure: error OR failedInLogs', () => {
    expect(isFailure(agent({ state: 'error' }))).toBe(true);
    expect(isFailure(agent({ state: 'done', failedInLogs: true }))).toBe(true);
    expect(isFailure(agent({ state: 'interrupted' }))).toBe(false);
    expect(isFailure(agent({ state: 'done' }))).toBe(false);
  });

  it('phaseTitleOf resolves the 1-based index, null when unknown / no phases', () => {
    expect(phaseTitleOf(agent({ phaseIndex: 2 }), PHASES)).toBe('Design');
    expect(phaseTitleOf(agent({ phaseIndex: 9 }), PHASES)).toBeNull();
    expect(phaseTitleOf(agent({ phaseIndex: 1 }), undefined)).toBeNull();
  });

  it('SORT_KEYS + DEFAULT_SORT are coherent', () => {
    expect(SORT_KEYS).toContain(DEFAULT_SORT.key);
    expect(DEFAULT_SORT).toEqual({ key: 'tokens', direction: 'desc' });
  });
});

// ARCH-1: orderAgentsByExecution — the EXECUTION-ORDER (DAG) view. Phases are the sequential
// spine (header rows, depth 0); the parallel agents within a phase are indented (depth 1).
describe('orderAgentsByExecution — the DAG view', () => {
  const phases: Phase[] = [
    { index: 1, title: 'Research', detail: null },
    { index: 2, title: 'Design', detail: null },
  ];

  it('emits phase headers (depth 0) in ascending index order, each followed by its agents (depth 1)', () => {
    const r1 = agent({ agentId: 'r1', phaseIndex: 1, index: 1 });
    const r2 = agent({ agentId: 'r2', phaseIndex: 1, index: 2 });
    const d1 = agent({ agentId: 'd1', phaseIndex: 2, index: 3 });
    // pass OUT OF ORDER to prove the defensive phase + index sort.
    const rows = orderAgentsByExecution([d1, r2, r1], phases);
    expect(rows.map((row) => (row.isPhaseHeader ? `#${row.phase?.title}` : row.agent?.agentId))).toEqual([
      '#Research',
      'r1',
      'r2',
      '#Design',
      'd1',
    ]);
    // header depth 0, agents depth 1.
    expect(rows[0]).toMatchObject({ isPhaseHeader: true, depth: 0, agentCountInPhase: 2 });
    expect(rows[1]).toMatchObject({ depth: 1 });
    expect(rows[1]?.isPhaseHeader).toBeFalsy();
  });

  it('skips a declared phase that has no agents (no empty header)', () => {
    const only = agent({ agentId: 'r1', phaseIndex: 1, index: 1 });
    const rows = orderAgentsByExecution([only], phases);
    expect(rows.some((row) => row.isPhaseHeader && row.phase?.title === 'Design')).toBe(false);
  });

  it('groups an agent under a SYNTHETIC header when its phaseIndex has no declared Phase', () => {
    const orphan = agent({ agentId: 'x', phaseIndex: 9, index: 1 });
    const rows = orderAgentsByExecution([orphan], phases);
    const header = rows.find((row) => row.isPhaseHeader);
    expect(header?.phase?.index).toBe(9);
    expect(header?.phase?.title).toBe('phase 9'); // synthetic
  });

  it('with no phases, puts every agent under one synthetic "agents" bucket (sorted by index)', () => {
    const a = agent({ agentId: 'a', index: 2 });
    const b = agent({ agentId: 'b', index: 1 });
    const rows = orderAgentsByExecution([a, b], undefined);
    expect(rows[0]).toMatchObject({ isPhaseHeader: true, phase: { title: 'agents' } });
    expect(rows.slice(1).map((row) => row.agent?.agentId)).toEqual(['b', 'a']); // index asc
  });

  it('returns [] for an empty agents array (no phantom header)', () => {
    expect(orderAgentsByExecution([], phases)).toEqual([]);
  });

  it('is pure — does not mutate the input arrays', () => {
    const a = agent({ agentId: 'a', phaseIndex: 1, index: 2 });
    const b = agent({ agentId: 'b', phaseIndex: 1, index: 1 });
    const input = [a, b];
    const before = [...input];
    orderAgentsByExecution(input, phases);
    expect(input).toEqual(before); // same order, not reordered in place
  });
});
