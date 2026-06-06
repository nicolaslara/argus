// @argus/web — UIBUG-2: the Plan/Run correspondence discriminator (pure, browser-free).
//
// When a focused run's workflow is NOT among the declared `workflows` (an inline `script`
// workflow, e.g. "argus-impl-live-card-fill"), toggling to the Plan view would fall back to
// `defaultWorkflow(workflows)` → render a DIFFERENT workflow's blueprint. The Run view already
// fetches the CORRECT per-run plan (`fetchRunPlan(ref)` → a PlanModel; the server returns the
// EXACT persisted per-run script, falling back to the recovered workflow `.js`). This pure
// helper decides WHICH PlanModel the Plan view should render so Plan and Run correspond, and is
// the single source of that rule (App.tsx calls it; a unit test pins it).

import type { PlanModel, RunSummary, WorkflowMeta } from '@argus/contract';

export interface PickPlanSourceArgs {
  /** The active canvas view. The per-run override only applies in the Plan view. */
  view: 'plan' | 'run';
  /** The focused run summary (null when no run is focused). */
  summary: RunSummary | null | undefined;
  /** The project's declared workflows (the `.js` files). */
  workflows: WorkflowMeta[];
  /** The per-run PlanModel already fetched for the morph (null until it resolves). */
  runPlan: PlanModel | null | undefined;
  /** The declared-workflow PlanModel (planQ.data) — the normal Plan-view blueprint. */
  declaredPlan: PlanModel | null | undefined;
}

export interface PlanSource {
  /** The PlanModel the Plan view should actually render. */
  plan: PlanModel | null | undefined;
  /** True iff the per-run plan is being substituted for an ad-hoc (undeclared) run. */
  usePerRun: boolean;
  /** True iff the focused run's workflow IS one of the declared `.js` workflows. */
  focusedHasDeclaredWorkflow: boolean;
}

/**
 * Decide the Plan-view blueprint. In the Plan view, when a run is focused whose workflow is NOT
 * declared (an inline `script` run) AND its per-run plan is available, render that per-run plan
 * (`usePerRun: true`); otherwise render the declared-workflow plan unchanged.
 */
export function pickPlanSource({
  view,
  summary,
  workflows,
  runPlan,
  declaredPlan,
}: PickPlanSourceArgs): PlanSource {
  const focusedHasDeclaredWorkflow =
    !!summary && workflows.some((w) => w.name === summary.workflowName);
  const usePerRun = view === 'plan' && !!summary && !focusedHasDeclaredWorkflow && !!runPlan;
  return {
    plan: usePerRun ? runPlan : declaredPlan,
    usePerRun,
    focusedHasDeclaredWorkflow,
  };
}
