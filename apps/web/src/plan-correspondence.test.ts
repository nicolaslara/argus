// UIBUG-2 — the Plan/Run correspondence discriminator. A focused run whose workflow is NOT a
// declared `.js` (an inline `script` run) must render its OWN per-run plan as the Plan-view
// blueprint, never fall back to a different (default) workflow. These tests pin that rule.

import { describe, it, expect } from 'vitest';
import type { PlanModel, RunSummary, WorkflowMeta } from '@argus/contract';
import { pickPlanSource } from './plan-correspondence.ts';

// Minimal fixtures — the helper reads ONLY `summary.workflowName` and `w.name`; the plans are
// opaque sentinels we assert identity against (so the cast keeps the fixtures honest + tiny).
const DECLARED_PLAN = { id: 'declared' } as unknown as PlanModel;
const RUN_PLAN = { id: 'run' } as unknown as PlanModel;

const declaredWorkflows: WorkflowMeta[] = [
  { name: 'argus-implement' } as WorkflowMeta,
  { name: 'argus-plan-research' } as WorkflowMeta,
];

const runOf = (workflowName: string): RunSummary => ({ workflowName } as RunSummary);

describe('pickPlanSource — UIBUG-2 Plan/Run correspondence', () => {
  it('Run view: never substitutes — the per-run override only applies in the Plan view', () => {
    const r = pickPlanSource({
      view: 'run',
      summary: runOf('argus-impl-live-card-fill'), // undeclared, but view is run
      workflows: declaredWorkflows,
      runPlan: RUN_PLAN,
      declaredPlan: DECLARED_PLAN,
    });
    expect(r.usePerRun).toBe(false);
    expect(r.plan).toBe(DECLARED_PLAN);
  });

  it('Plan view + focused run IS a declared workflow: keeps the declared plan', () => {
    const r = pickPlanSource({
      view: 'plan',
      summary: runOf('argus-implement'),
      workflows: declaredWorkflows,
      runPlan: RUN_PLAN,
      declaredPlan: DECLARED_PLAN,
    });
    expect(r.focusedHasDeclaredWorkflow).toBe(true);
    expect(r.usePerRun).toBe(false);
    expect(r.plan).toBe(DECLARED_PLAN);
  });

  it('Plan view + focused run is UNDECLARED (ad-hoc) with a per-run plan: renders the per-run plan', () => {
    const r = pickPlanSource({
      view: 'plan',
      summary: runOf('argus-impl-live-card-fill'),
      workflows: declaredWorkflows,
      runPlan: RUN_PLAN,
      declaredPlan: DECLARED_PLAN,
    });
    expect(r.focusedHasDeclaredWorkflow).toBe(false);
    expect(r.usePerRun).toBe(true);
    expect(r.plan).toBe(RUN_PLAN); // the run's OWN plan, NOT the default workflow's
  });

  it('Plan view + undeclared run but the per-run plan has not resolved yet: stays on the declared plan', () => {
    const r = pickPlanSource({
      view: 'plan',
      summary: runOf('argus-impl-live-card-fill'),
      workflows: declaredWorkflows,
      runPlan: undefined, // still loading
      declaredPlan: DECLARED_PLAN,
    });
    expect(r.usePerRun).toBe(false); // cannot substitute without the per-run plan
    expect(r.plan).toBe(DECLARED_PLAN);
  });

  it('Plan view, no run focused (run-free workflow review): keeps the declared plan', () => {
    const r = pickPlanSource({
      view: 'plan',
      summary: null,
      workflows: declaredWorkflows,
      runPlan: RUN_PLAN,
      declaredPlan: DECLARED_PLAN,
    });
    expect(r.focusedHasDeclaredWorkflow).toBe(false);
    expect(r.usePerRun).toBe(false);
    expect(r.plan).toBe(DECLARED_PLAN);
  });

  it('treats an empty declared-workflows list as "undeclared" → per-run plan wins', () => {
    const r = pickPlanSource({
      view: 'plan',
      summary: runOf('anything'),
      workflows: [],
      runPlan: RUN_PLAN,
      declaredPlan: DECLARED_PLAN,
    });
    expect(r.usePerRun).toBe(true);
    expect(r.plan).toBe(RUN_PLAN);
  });
});
