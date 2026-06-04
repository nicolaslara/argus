import { describe, it, expect } from 'vitest';
import {
  handleProjectWorkflows,
  isValidSegment,
  type RouteDeps,
} from './routes.ts';
import type { FileSystemPort } from '@argus/adapter';

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
export async function __wf(agent, parallel) { /* body never runs */ }
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

/** Build an in-memory FileSystemPort over a flat path -> content map. */
function makeFakePort(): FileSystemPort {
  const files = new Map<string, string>([
    [`${CLAUDE_HOME}/projects/${SLUG}/${SESSION}/workflows/wf_test.json`, WF_HEADER],
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
