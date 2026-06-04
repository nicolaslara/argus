import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlan, parseFinalizedRun } from '@argus/adapter';
import type { AgentNode, PlanModel, RunModel } from '@argus/contract';
import { buildOverlay } from './overlay.ts';

// P2 buildOverlay test. The function is PURE (PlanModel + RunModel → Overlay); the TEST
// harness reads the captured REAL fixtures (mirrors plan.test.ts / adapter.test.ts) to
// feed it. Two real (plan, run) pairs cover the three mismatch classes + the rounds
// signal; small crafted models cover the 3-way tie-break (exact > prefix+index >
// ambiguous, ambiguous never auto-resolved).
//
// Real pairs:
//   - completed-14agents.wf.json × plan-research.js : an all-complete fan-out run
//     (research 7/7, review 4/4 — tokens===0 is NOT a failure; the run-level
//     `parallel[0] failed` was a retried transient, not a surviving failed member).
//   - killed-9agents.wf.json × refine-plan.js : a loop run (rounds=2), a partial-instance
//     (interrupted critique members), AND a planned-not-run phase (`finalize`, gate-killed).

const here = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(here, '../../../.argus/fixtures');

function loadPlan(js: string): PlanModel {
  return parsePlan(readFileSync(resolve(FIX, 'named-workflows', js), 'utf8'), js);
}
function loadRun(wf: string, runId: string): RunModel {
  const raw = JSON.parse(readFileSync(resolve(FIX, 'finished', wf), 'utf8')) as unknown;
  return parseFinalizedRun(raw, { ref: { projectPath: '', slug: 's', sessionId: 'x', runId } });
}

describe('buildOverlay — 14-agent plan-research (all-complete fan-out binding)', () => {
  const plan = loadPlan('plan-research.js');
  const run = loadRun('completed-14agents.wf.json', 'wf_14');
  const ov = buildOverlay(plan, run);

  it('is pure — never mutates the inputs', () => {
    const planJson = JSON.stringify(plan);
    const runJson = JSON.stringify(run);
    buildOverlay(plan, run);
    expect(JSON.stringify(plan)).toBe(planJson);
    expect(JSON.stringify(run)).toBe(runJson);
  });

  it('binds the research fan-out (prefix+phaseIndex unique → medium), 7/7 complete', () => {
    const research = ov.bindings.find((b) => b.planNodeId.startsWith('agent:research:'));
    expect(research).toBeDefined();
    expect(research!.confidence).toBe('medium'); // prefix+phaseIndex, not a literal
    expect(research!.status).toBe('complete');
    expect(research!.succeeded).toBe(7);
    expect(research!.failed).toBe(0);
    expect(research!.total).toBe(7);
    expect(research!.ambiguous).toBe(false);
  });

  it('binds the exact `synthesize` + `design:*` labels at HIGH confidence', () => {
    const synth = ov.bindings.find((b) => b.planNodeId === 'agent:synthesize:5');
    expect(synth?.confidence).toBe('high'); // exact literal match
    expect(synth?.status).toBe('complete');
    const arch = ov.bindings.find((b) => b.planNodeId.startsWith('agent:design:architecture'));
    expect(arch?.confidence).toBe('high');
  });

  it('review fan-out is 4/4 COMPLETE — tokens===0 is NOT a failure', () => {
    // Regression guard: `review:red-team` is a successful `done` agent that reports
    // tokens===0 (a token-accounting quirk, the M1 "tokens=0 ≠ nothing" case). It must
    // NOT be counted as a failed instance. All 4 review agents are `done` in this run
    // (verified in the fixture), so the fan-out is 4/4 complete — NOT 3/4·1-failed.
    // A genuinely-failed `parallel[N] failed` member is dropped by `.filter(Boolean)`
    // and never reaches workflowProgress; it would surface as a shortfall, not here.
    const review = ov.bindings.find((b) => b.planNodeId.startsWith('agent:review:'));
    expect(review).toBeDefined();
    expect(review!.status).toBe('complete');
    expect(review!.total).toBe(4);
    expect(review!.succeeded).toBe(4);
    expect(review!.failed).toBe(0);
  });

  it('has no unplanned agents and no loop rounds for this linear fan-out run', () => {
    expect(ov.unplannedAgentIds).toEqual([]);
    expect(ov.rounds).toBeNull();
  });
});

describe('buildOverlay — refine-plan (loop rounds + planned-not-run + partial)', () => {
  const plan = loadPlan('refine-plan.js');
  const run = loadRun('killed-9agents.wf.json', 'wf_refine');
  const ov = buildOverlay(plan, run);

  it('observes the loop rounds (rounds=2) from the `:rN` round-suffixed instances', () => {
    expect(ov.rounds).toBe(2);
  });

  it('folds all round instances onto ONE critique plan node (medium, partial)', () => {
    const crit = ov.bindings.find((b) => b.planNodeId.startsWith('agent:critique:'));
    expect(crit).toBeDefined();
    expect(crit!.agentIds.length).toBe(8); // 4 critics × 2 rounds, one folded plan node
    expect(crit!.confidence).toBe('medium');
    expect(crit!.status).toBe('partial'); // 2 interrupted (failed) members
    expect(crit!.failed).toBe(2);
  });

  it('MISMATCH (planned-not-run): the gate-killed `finalize` phase bound no agent', () => {
    const fin = ov.bindings.find((b) => b.planNodeId === 'agent:finalize:3');
    expect(fin).toBeDefined();
    expect(fin!.status).toBe('not-run');
    expect(fin!.agentIds).toEqual([]);
    expect(fin!.succeeded).toBe(0);
  });
});

// --- crafted minimal models for the 3-way tie-break + the unplanned mismatch ----------
// These exercise the §6 classifier on shapes too rare in the captured corpus to rely on.

function planNode(over: Partial<PlanModel['nodes'][number]> & { id: string }): PlanModel['nodes'][number] {
  return {
    kind: 'agent',
    title: 'a',
    labelTemplate: null,
    agentType: null,
    phaseRef: 1,
    multiplicity: { kind: 'one' },
    optional: false,
    loopRef: null,
    parentDecisionId: null,
    annotation: { subtitle: null, typed: false, source: 'static' },
    confidence: 'static',
    ...over,
  };
}
function agentNode(over: Partial<AgentNode> & { agentId: string; label: string }): AgentNode {
  return {
    index: 0,
    phaseIndex: 1,
    model: null,
    state: 'done',
    cached: false,
    agentType: null,
    attempt: null,
    failedInLogs: false,
    tokens: 100,
    toolCalls: 1,
    durationMs: 1,
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
function mkPlan(nodes: PlanModel['nodes']): PlanModel {
  return {
    workflowFile: 'x.js',
    workflowName: 'x',
    lanes: [{ index: 1, title: 'P1', detail: null, confidence: 'declared' }],
    nodes,
    edges: [],
    containers: [],
    warnings: [],
    derivedFrom: 'static-source',
    coverageRatio: 1,
    format: 'cc-workflow/observed-2026-06-04',
  };
}
function mkRun(agents: AgentNode[]): RunModel {
  return {
    ref: { projectPath: '', slug: 's', sessionId: 'x', runId: 'wf_x' },
    workflowName: 'x',
    status: 'completed',
    incomplete: false,
    startTime: null,
    durationMs: null,
    defaultModel: null,
    summary: '',
    phases: [{ index: 1, title: 'P1', detail: null }],
    agents,
    edges: [],
    logs: [],
    partialFailure: { present: false, lines: [] },
    error: null,
    args: null,
    warnings: [],
    format: 'cc-workflow/observed-2026-06-04',
  };
}

describe('buildOverlay — §6 three-way tie-break', () => {
  it('exact literal > prefix+index: an exact match wins over a prefix candidate', () => {
    // Plan node A: exact literal `build`. Plan node B: prefix `build` (template hole).
    const plan = mkPlan([
      planNode({ id: 'A', labelTemplate: { literalPrefix: 'build', holes: [], raw: 'build' } }),
      planNode({ id: 'B', labelTemplate: { literalPrefix: 'build', holes: ['x'], raw: 'build${x}' } }),
    ]);
    const run = mkRun([agentNode({ agentId: 'a1', label: 'build' })]);
    const ov = buildOverlay(plan, run);
    const a = ov.bindings.find((b) => b.planNodeId === 'A')!;
    const b = ov.bindings.find((b) => b.planNodeId === 'B')!;
    expect(a.confidence).toBe('high'); // exact wins
    expect(a.agentIds).toEqual(['a1']);
    expect(b.agentIds).toEqual([]); // the prefix node did NOT also claim it
    expect(a.ambiguous).toBe(false);
  });

  it('AMBIGUOUS (low): one run agent matching >1 plan node is flagged, never auto-resolved', () => {
    // Two plan nodes with the SAME exact literal `dup` — genuinely ambiguous.
    const plan = mkPlan([
      planNode({ id: 'A', labelTemplate: { literalPrefix: 'dup', holes: [], raw: 'dup' } }),
      planNode({ id: 'B', labelTemplate: { literalPrefix: 'dup', holes: [], raw: 'dup' } }),
    ]);
    const run = mkRun([agentNode({ agentId: 'a1', label: 'dup' })]);
    const ov = buildOverlay(plan, run);
    const ambiguous = ov.bindings.filter((b) => b.ambiguous);
    expect(ambiguous.length).toBeGreaterThanOrEqual(1);
    for (const b of ambiguous) expect(b.confidence).toBe('low'); // never resolved to a winner
  });

  it('prefix+index AMBIGUOUS: two template prefixes claim one agent → low, ambiguous', () => {
    const plan = mkPlan([
      planNode({ id: 'A', labelTemplate: { literalPrefix: 'review:', holes: ['x'], raw: 'review:${x}' } }),
      planNode({ id: 'B', labelTemplate: { literalPrefix: 'review:', holes: ['y'], raw: 'review:${y}' } }),
    ]);
    const run = mkRun([agentNode({ agentId: 'a1', label: 'review:red-team' })]);
    const ov = buildOverlay(plan, run);
    expect(ov.bindings.some((b) => b.ambiguous && b.confidence === 'low')).toBe(true);
  });

  it('MISMATCH (unplanned-agent): a label matching no plan node lands in unplannedAgentIds', () => {
    const plan = mkPlan([
      planNode({ id: 'A', labelTemplate: { literalPrefix: 'research:', holes: ['x'], raw: 'research:${x}' } }),
    ]);
    const run = mkRun([
      agentNode({ agentId: 'a1', label: 'research:foo' }),
      agentNode({ agentId: 'rogue', label: 'totally-unplanned' }),
    ]);
    const ov = buildOverlay(plan, run);
    expect(ov.unplannedAgentIds).toEqual(['rogue']);
    expect(ov.bindings.find((b) => b.planNodeId === 'A')!.agentIds).toEqual(['a1']);
  });
});
