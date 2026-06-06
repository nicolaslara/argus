// The dogfood DEFAULT pickers (M4: overridable), extracted from App.tsx. Pure functions over
// the discovered project/run/workflow lists — no React, no DOM, no app state. App falls back to
// these whenever the user has not explicitly selected a project / run / workflow yet, so the app
// opens on the same modal-rust / richest-run / plan-research picks as before, while ANY discovered
// entity can override them. Kept pure so they are unit-testable without the React app.

import type { ProjectRef, RunSummary, WorkflowMeta } from '@argus/contract';

/** Dogfood DEFAULT (M4: overridable): prefer modal-rust; else the first project. */
export function defaultProject(projects: ProjectRef[] | undefined): ProjectRef | undefined {
  if (!projects || projects.length === 0) return undefined;
  return projects.find((p) => p.projectPath.includes('modal-rust')) ?? projects[0];
}

/** Execution DEFAULT (M4: overridable): the richest run (the 14-agent plan-research run). */
export function defaultRun(runs: RunSummary[] | undefined): RunSummary | undefined {
  if (!runs || runs.length === 0) return undefined;
  return [...runs].sort((a, b) => b.agentCount - a.agentCount)[0];
}

/** Plan DEFAULT (M4: overridable): plan-research; else the first declared workflow. */
export function defaultWorkflow(workflows: WorkflowMeta[] | undefined): WorkflowMeta | undefined {
  if (!workflows || workflows.length === 0) return undefined;
  return workflows.find((w) => w.name.includes('plan-research')) ?? workflows[0];
}
