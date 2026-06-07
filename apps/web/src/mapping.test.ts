import { describe, it, expect } from 'vitest';
import type { AgentNode, RunModel } from '@argus/contract';
import { agentToCardData, runModelToGraph } from './mapping.ts';
import type { LiveFill } from './live-agent-fill.ts';

// STEP 2 (failure-and-live-inspector §4 "Live + finished agent card") — browser-free proof of
// the live-fill MERGE rule in `agentToCardData`. The rule (mapping.ts `fillMetric`): the journal
// value wins when present AND non-zero; otherwise the transcript-derived live value fills the
// card. So a RUNNING run's metric-starved card shows real dur/tok/tools/label, while a FINISHED
// run's card (journal already populated) stays byte-unchanged.

/** A minimal AgentNode; `over` sets the metric fields under test (defaults = a live, starved card). */
function agentNode(over: Partial<AgentNode> & { agentId: string }): AgentNode {
  return {
    index: 0,
    label: '',
    phaseIndex: 1,
    model: null,
    state: 'running',
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

const FILL: LiveFill = {
  durationMs: 4200,
  tokens: 1500,
  toolCount: 9,
  label: 'research:modal-rs-surface',
};

describe('agentToCardData — live transcript fill', () => {
  it('(a) fills dur/tok/tools/label for an agent whose journal values are missing/zero', () => {
    // A live, starved agent: null dur/tok, zero toolCalls, no label (bare id is its only handle).
    const agent = agentNode({
      agentId: 'a1',
      label: '',
      tokens: null,
      toolCalls: 0, // 0 is "starved" too — fillMetric treats present-but-zero as fillable
      durationMs: null,
    });
    const data = agentToCardData(agent, false, FILL);
    expect(data.durationMs).toBe(4200);
    expect(data.tokens).toBe(1500);
    expect(data.toolCalls).toBe(9);
    expect(data.label).toBe('research:modal-rs-surface');
  });

  it('(b) a finished agent (journal has dur/tok) is UNCHANGED by liveFill — journal wins', () => {
    // A finalized agent: real journal metrics + a real label. The fill must be IGNORED so a
    // finished run's card stays byte-identical to the no-fill build.
    const agent = agentNode({
      agentId: 'a2',
      state: 'done',
      label: 'research:done-label',
      tokens: 8000,
      toolCalls: 12,
      durationMs: 60_000,
    });
    const withFill = agentToCardData(agent, false, FILL);
    const noFill = agentToCardData(agent, false, undefined);
    // The journal values survive the fill verbatim.
    expect(withFill.tokens).toBe(8000);
    expect(withFill.toolCalls).toBe(12);
    expect(withFill.durationMs).toBe(60_000);
    expect(withFill.label).toBe('research:done-label');
    // And the fill is a TOTAL no-op for a populated agent (byte-unchanged card data).
    expect(withFill).toEqual(noFill);
  });

  it('(c) an agent with NO liveFill entry keeps its journal/em-dash values', () => {
    // No fill passed (the live map had no entry for this agent — e.g. a 404 transcript). The
    // starved journal values pass straight through (null/0 → the card renders em-dashes), and
    // the label falls back to the agentId.
    const agent = agentNode({
      agentId: 'a3',
      label: '',
      tokens: null,
      toolCalls: null,
      durationMs: null,
    });
    const data = agentToCardData(agent, false, undefined);
    expect(data.durationMs).toBeNull();
    expect(data.tokens).toBeNull();
    expect(data.toolCalls).toBeNull();
    expect(data.label).toBe('a3'); // bare-id fallback (no journal label, no fill label)
  });

  it('partial fill: a missing-from-fill field keeps its journal value; present fields win', () => {
    // The fill only knows the label + tokens (a sparse transcript). dur/tools stay starved.
    const agent = agentNode({ agentId: 'a4', tokens: null, toolCalls: null, durationMs: null });
    const data = agentToCardData(agent, false, { label: 'partial-task', tokens: 700 });
    expect(data.label).toBe('partial-task');
    expect(data.tokens).toBe(700);
    expect(data.toolCalls).toBeNull(); // not in the fill → stays starved
    expect(data.durationMs).toBeNull();
  });

  it('the journal label still wins over the fill label when present', () => {
    const agent = agentNode({ agentId: 'a5', label: 'journal-label' });
    const data = agentToCardData(agent, false, { label: 'fill-label' });
    expect(data.label).toBe('journal-label');
  });
});

// AV4: runModelToGraph is the PLAN-LESS Run-view fallback (now wired in useRunGraph for scriptless
// runs). It groups agents by phase into lanes straight from the RunModel — no plan, no elk.
describe('runModelToGraph — plan-less fallback (agents grouped by phase)', () => {
  const phase = (index: number, title: string) => ({ index, title, detail: null });
  function model(agents: AgentNode[], phases: ReturnType<typeof phase>[]): RunModel {
    return {
      ref: { projectPath: '', slug: 's', sessionId: 'sess', runId: 'wf_x' },
      workflowName: 'wf',
      status: 'completed',
      incomplete: false,
      startTime: null,
      durationMs: null,
      defaultModel: null,
      summary: '',
      phases,
      agents,
      edges: [],
      logs: [],
      partialFailure: { present: false, lines: [] },
      error: null,
      args: null,
      warnings: [],
      format: 'test',
    };
  }

  it('emits one phaseLane per phase + an agentCard per resolved agent, parented to its lane', () => {
    const g = runModelToGraph(
      model(
        [
          agentNode({ agentId: 'a', phaseIndex: 1, index: 0 }),
          agentNode({ agentId: 'b', phaseIndex: 1, index: 1 }),
          agentNode({ agentId: 'c', phaseIndex: 2, index: 2 }),
        ],
        [phase(1, 'P1'), phase(2, 'P2')],
      ),
    );
    const lanes = g.nodes.filter((n) => n.type === 'phaseLane');
    const cards = g.nodes.filter((n) => n.type === 'agentCard');
    expect(lanes).toHaveLength(2);
    expect(cards).toHaveLength(3);
    const laneIds = new Set(lanes.map((n) => n.id));
    expect(cards.every((c) => !!c.parentId && laneIds.has(c.parentId))).toBe(true);
  });

  it('drops an agent whose phaseIndex has no matching phase (belt-and-suspenders)', () => {
    const g = runModelToGraph(
      model(
        [
          agentNode({ agentId: 'a', phaseIndex: 1, index: 0 }),
          agentNode({ agentId: 'ghost', phaseIndex: 99, index: 1 }),
        ],
        [phase(1, 'P1')],
      ),
    );
    expect(g.nodes.filter((n) => n.type === 'agentCard')).toHaveLength(1);
  });
});
