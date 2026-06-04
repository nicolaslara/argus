import { describe, it, expect } from 'vitest';
import {
  handleProjectWorkflows,
  handleProjectPlan,
  handleRunPlan,
  isValidSegment,
  isValidWorkflowFile,
  safeRunScriptPath,
  type RouteDeps,
} from './routes.ts';
import type { FileSystemPort } from '@argus/adapter';
import type { PlanModel } from '@argus/contract';

// P0 server-route test (boundaries.md §4 pattern, mirrors fs-port.test.ts's fake-port
// approach but for routing): exercise GET /api/projects/:slug/workflows over a small
// in-memory tree that reproduces the real on-disk layout — a finalized wf_*.json whose
// scriptPath recovers to the modal-rust root, plus that root's declared
// `.claude/workflows/plan-research.js` meta. The route must be slug-validated
// (bad slug -> 400) and, on a valid slug, return WorkflowMeta[] including plan-research
// with its 4 declared phases (Research / Design / Review / Synthesize).

const CLAUDE_HOME = '/home/.claude';
const SLUG = '-Users-nicolas-devel-modal-rust';
const PROJECT_ROOT = '/Users/nicolas/devel/modal-rust';
const SESSION = 'session-aaaa';

// A minimal but realistic `export const meta = {...}` literal (shape verified against
// the real modal-rust/.claude/workflows/plan-research.js on 2026-06-04). The workflow
// body is omitted on purpose: parseWorkflowMeta only evaluates the meta literal.
const PLAN_RESEARCH_SRC = `
export const meta = {
  name: 'modal-rust-plan-research',
  description: 'Plan + research a Modal Rust runtime.',
  whenToUse: 'When starting a new plan.',
  model: 'opus',
  phases: [
    { title: 'Research', detail: 'parallel primary-source research over the surface' },
    { title: 'Design', detail: 'architecture + milestone-plan proposals informed by research' },
    { title: 'Review', detail: 'adversarial lenses: red-team, sequencing, correctness' },
    { title: 'Synthesize', detail: 'consolidate into one authoritative synthesis' },
  ],
};

const RESEARCH = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];

phase('Research')
const research = (
  await parallel(RESEARCH.map((r) => () => agent(r.key, { label: \`research:\${r.key}\`, phase: 'Research' })))
).filter(Boolean)

phase('Synthesize')
const synthesis = await agent('synthesize', { label: 'synthesize', phase: 'Synthesize' })
return { research, synthesis }
`;

const IMPLEMENT_SRC = `
export const meta = {
  name: 'modal-rust-implement',
  description: 'Implement one milestone.',
  phases: [{ title: 'Implement', detail: 'do the work' }],
};
`;

// A finalized run header whose scriptPath is shape (1) -> recovers the project root.
const WF_HEADER = JSON.stringify({
  workflowName: 'modal-rust-plan-research',
  status: 'completed',
  agentCount: 14,
  durationMs: 1000,
  startTime: 1,
  summary: 'done',
  scriptPath: `${PROJECT_ROOT}/.claude/workflows/plan-research.js`,
});

// P2: a run whose scriptPath is the PER-RUN persisted cache-shape (2) path, with that
// persisted script present under <session>/workflows/scripts/.
const RUN_ID = 'wf_runtest';
const SCRIPT_BASENAME = `modal-rust-plan-research-${RUN_ID}.js`;
const SCRIPTS_PATH = `${CLAUDE_HOME}/projects/${SLUG}/${SESSION}/workflows/scripts/${SCRIPT_BASENAME}`;
const WF_HEADER_PERRUN = JSON.stringify({
  workflowName: 'modal-rust-plan-research',
  status: 'completed',
  scriptPath: SCRIPTS_PATH,
});

// An ORPHAN run: a shape-(1) scriptPath whose project `.js` is ABSENT in the port AND no
// per-run script — neither source is readable → a genuine 404.
const WF_HEADER_ORPHAN = JSON.stringify({
  workflowName: 'modal-rust-gone',
  status: 'completed',
  scriptPath: `${PROJECT_ROOT}/.claude/workflows/gone.js`,
});

/** Build an in-memory FileSystemPort over a flat path -> content map. */
function makeFakePort(): FileSystemPort {
  const files = new Map<string, string>([
    [`${CLAUDE_HOME}/projects/${SLUG}/${SESSION}/workflows/wf_test.json`, WF_HEADER],
    [`${CLAUDE_HOME}/projects/${SLUG}/${SESSION}/workflows/${RUN_ID}.json`, WF_HEADER_PERRUN],
    [`${CLAUDE_HOME}/projects/${SLUG}/${SESSION}/workflows/wf_orphan.json`, WF_HEADER_ORPHAN],
    [SCRIPTS_PATH, PLAN_RESEARCH_SRC],
    [`${PROJECT_ROOT}/.claude/workflows/plan-research.js`, PLAN_RESEARCH_SRC],
    [`${PROJECT_ROOT}/.claude/workflows/implement.js`, IMPLEMENT_SRC],
  ]);

  // Directory listing derived from the file map (POSIX-ish, like discovery's join()).
  function listDir(path: string): Array<{ name: string; isDir: boolean }> {
    const prefix = path.replace(/\/+$/, '') + '/';
    const direct = new Map<string, boolean>();
    for (const key of files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) direct.set(rest, false);
      else direct.set(rest.slice(0, slash), true);
    }
    if (direct.size === 0) throw new Error(`ENOENT: ${path}`);
    return [...direct.entries()].map(([name, isDir]) => ({ name, isDir }));
  }

  return {
    async readFile(path: string): Promise<string> {
      const v = files.get(path);
      if (v === undefined) throw new Error(`ENOENT: ${path}`);
      return v;
    },
    async readJson(path: string): Promise<unknown> {
      const v = files.get(path);
      if (v === undefined) throw new Error(`ENOENT: ${path}`);
      return JSON.parse(v);
    },
    async listDir(path: string) {
      return listDir(path);
    },
    async stat() {
      return null;
    },
    async exists(path: string): Promise<boolean> {
      return files.has(path);
    },
    watch(_path: string, _onEvent: (event: { path: string; type: string }) => void): () => void {
      return () => {};
    },
  };
}

describe('handleProjectWorkflows (P0 route)', () => {
  const deps: RouteDeps = { port: makeFakePort(), claudeHome: CLAUDE_HOME };

  it('rejects a traversal-ish / bad slug with 400 before any FS access', async () => {
    expect(isValidSegment('../etc')).toBe(false);
    const res = await handleProjectWorkflows(deps, '../etc');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'bad_request' });
  });

  it('returns WorkflowMeta[] incl. plan-research with its 4 declared phases', async () => {
    const res = await handleProjectWorkflows(deps, SLUG);
    expect(res.status).toBe(200);
    const metas = res.body as Array<{ name: string; phases: Array<{ title: string }> }>;
    expect(Array.isArray(metas)).toBe(true);
    expect(metas.length).toBeGreaterThanOrEqual(2);

    const plan = metas.find((m) => m.name === 'modal-rust-plan-research');
    expect(plan).toBeDefined();
    expect(plan!.phases.map((p) => p.title)).toEqual([
      'Research',
      'Design',
      'Review',
      'Synthesize',
    ]);
    // Sorted by name; deduped by file basename.
    expect(metas).toEqual([...metas].sort((a, b) => a.name.localeCompare(b.name)));
  });

  it('returns [] (never 500) for an unknown slug', async () => {
    const res = await handleProjectWorkflows(deps, '-no-such-project');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('handleProjectPlan (P1 route — run-free static plan DAG)', () => {
  const deps: RouteDeps = { port: makeFakePort(), claudeHome: CLAUDE_HOME };

  it('rejects a bad slug / bad workflow file (400) before any FS access', async () => {
    expect(isValidWorkflowFile('plan-research.js')).toBe(true);
    expect(isValidWorkflowFile('../etc/passwd.js')).toBe(false);
    expect(isValidWorkflowFile('plan-research.ts')).toBe(false);
    expect((await handleProjectPlan(deps, '../etc', 'plan-research.js')).status).toBe(400);
    expect((await handleProjectPlan(deps, SLUG, '../escape.js')).status).toBe(400);
  });

  it('returns a static-source PlanModel with a fan-out for plan-research.js', async () => {
    const res = await handleProjectPlan(deps, SLUG, 'plan-research.js');
    expect(res.status).toBe(200);
    const plan = res.body as PlanModel;
    expect(plan.derivedFrom).toBe('static-source');
    expect(plan.workflowName).toBe('modal-rust-plan-research');
    expect(plan.lanes.map((l) => l.title)).toEqual([
      'Research',
      'Design',
      'Review',
      'Synthesize',
    ]);
    // The RESEARCH fan-out (3 literal objects) → a fixed-3 process split + fanout edges.
    expect(
      plan.nodes.some((n) => n.kind === 'process' && n.multiplicity.kind === 'fixed' && n.multiplicity.n === 3),
    ).toBe(true);
    expect(plan.edges.some((e) => e.kind === 'fanout')).toBe(true);
    expect(plan.edges.some((e) => e.kind === 'merge')).toBe(true);
    // The format pin is stamped.
    expect(plan.format).toBe('cc-workflow/observed-2026-06-04');
  });

  it('404 (never 500) for an unknown slug or an unknown workflow file', async () => {
    expect((await handleProjectPlan(deps, '-no-such-project', 'plan-research.js')).status).toBe(404);
    expect((await handleProjectPlan(deps, SLUG, 'nonexistent.js')).status).toBe(404);
  });
});

describe('handleRunPlan (P2 route — the PER-RUN persisted plan source)', () => {
  const deps: RouteDeps = { port: makeFakePort(), claudeHome: CLAUDE_HOME };

  // The token gate (401) and Host/Origin gate (403) are enforced in index.ts BEFORE this
  // route layer is reached (shared by every /api route); the route layer below enforces
  // segment-charset (400) + resolve()-inside-claudeHome (400) + a read miss (404).

  it('safeRunScriptPath: charset + resolve()-inside-claudeHome guard (path traversal → null)', () => {
    expect(safeRunScriptPath(CLAUDE_HOME, SLUG, SESSION, RUN_ID, SCRIPT_BASENAME)).not.toBeNull();
    // traversal on the runId segment → 400 (null).
    expect(safeRunScriptPath(CLAUDE_HOME, SLUG, SESSION, '../../etc', SCRIPT_BASENAME)).toBeNull();
    // traversal on the script file → null.
    expect(safeRunScriptPath(CLAUDE_HOME, SLUG, SESSION, RUN_ID, '../../escape.js')).toBeNull();
    // a non-wf_ runId → null (runId charset is wf_*).
    expect(safeRunScriptPath(CLAUDE_HOME, SLUG, SESSION, 'notarun', SCRIPT_BASENAME)).toBeNull();
  });

  it('returns the per-run PlanModel parsed from the persisted scripts/*.js (200)', async () => {
    const res = await handleRunPlan(deps, SLUG, SESSION, RUN_ID);
    expect(res.status).toBe(200);
    const plan = res.body as PlanModel;
    expect(plan.derivedFrom).toBe('static-source');
    expect(plan.workflowName).toBe('modal-rust-plan-research');
    expect(plan.lanes.map((l) => l.title)).toEqual(['Research', 'Design', 'Review', 'Synthesize']);
    expect(plan.format).toBe('cc-workflow/observed-2026-06-04');
  });

  it('400 (before any FS access) on a path-traversal runId / bad segment', async () => {
    expect((await handleRunPlan(deps, '../etc', SESSION, RUN_ID)).status).toBe(400);
    expect((await handleRunPlan(deps, SLUG, '../etc', RUN_ID)).status).toBe(400);
    expect((await handleRunPlan(deps, SLUG, SESSION, '../../etc')).status).toBe(400);
  });

  it('404 (never 500/leak) when the run header is missing', async () => {
    expect((await handleRunPlan(deps, SLUG, SESSION, 'wf_nosuchrun')).status).toBe(404);
  });

  it('falls back to the recovered project workflow plan when there is NO per-run script (200)', async () => {
    // wf_test's header is the shape-(1) project path; no `<name>-<runId>.js` persisted, so
    // the route falls back to the project `plan-research.js` (present in the port) → 200.
    const res = await handleRunPlan(deps, SLUG, SESSION, 'wf_test');
    expect(res.status).toBe(200);
    expect((res.body as PlanModel).workflowName).toBe('modal-rust-plan-research');
  });

  it('404 (never 500/leak) when NEITHER a per-run script NOR the project script is readable', async () => {
    const res = await handleRunPlan(deps, SLUG, SESSION, 'wf_orphan');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });
});
