import { describe, it, expect } from 'vitest';
import type { ProjectRef, RunSummary, WorkflowMeta } from '@argus/contract';
import { defaultProject, defaultRun, defaultWorkflow } from './defaults.ts';

// The dogfood DEFAULT pickers (extracted from App.tsx). Pure functions over the discovered
// project/run/workflow lists — no React, no DOM. Exercised over hand-built fixtures.

function project(over: Partial<ProjectRef> & { projectPath: string }): ProjectRef {
  return {
    slug: over.projectPath.replace(/\//g, '-'),
    ...over,
  } as ProjectRef;
}

function run(over: Partial<RunSummary> & { runId: string; agentCount: number }): RunSummary {
  return {
    ref: { projectPath: '/p', slug: '-p', sessionId: 's', runId: over.runId },
    workflowName: 'wf',
    status: 'completed',
    startTime: null,
    ...over,
  } as RunSummary;
}

function workflow(over: Partial<WorkflowMeta> & { name: string }): WorkflowMeta {
  return {
    file: `${over.name}.js`,
    phases: [],
    ...over,
  } as WorkflowMeta;
}

describe('defaultProject', () => {
  it('returns undefined for undefined or empty input', () => {
    expect(defaultProject(undefined)).toBeUndefined();
    expect(defaultProject([])).toBeUndefined();
  });

  it('prefers a project whose path includes modal-rust', () => {
    const projects = [
      project({ projectPath: '/home/x/foo' }),
      project({ projectPath: '/home/x/modal-rust' }),
      project({ projectPath: '/home/x/bar' }),
    ];
    expect(defaultProject(projects)?.projectPath).toBe('/home/x/modal-rust');
  });

  it('falls back to the first project when none match modal-rust', () => {
    const projects = [project({ projectPath: '/home/x/foo' }), project({ projectPath: '/home/x/bar' })];
    expect(defaultProject(projects)?.projectPath).toBe('/home/x/foo');
  });
});

describe('defaultRun', () => {
  it('returns undefined for undefined or empty input', () => {
    expect(defaultRun(undefined)).toBeUndefined();
    expect(defaultRun([])).toBeUndefined();
  });

  it('picks the run with the highest agentCount (the richest run)', () => {
    const runs = [
      run({ runId: 'a', agentCount: 3 }),
      run({ runId: 'b', agentCount: 14 }),
      run({ runId: 'c', agentCount: 7 }),
    ];
    expect(defaultRun(runs)?.ref.runId).toBe('b');
  });

  it('does not mutate the input array (sorts a copy)', () => {
    const runs = [run({ runId: 'a', agentCount: 1 }), run({ runId: 'b', agentCount: 9 })];
    const before = runs.map((r) => r.ref.runId);
    defaultRun(runs);
    expect(runs.map((r) => r.ref.runId)).toEqual(before);
  });
});

describe('defaultWorkflow', () => {
  it('returns undefined for undefined or empty input', () => {
    expect(defaultWorkflow(undefined)).toBeUndefined();
    expect(defaultWorkflow([])).toBeUndefined();
  });

  it('prefers a workflow whose name includes plan-research', () => {
    const workflows = [workflow({ name: 'build' }), workflow({ name: 'plan-research' }), workflow({ name: 'ship' })];
    expect(defaultWorkflow(workflows)?.name).toBe('plan-research');
  });

  it('falls back to the first workflow when none match plan-research', () => {
    const workflows = [workflow({ name: 'build' }), workflow({ name: 'ship' })];
    expect(defaultWorkflow(workflows)?.name).toBe('build');
  });
});
