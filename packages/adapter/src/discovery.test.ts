import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join as pjoin } from 'node:path';
import {
  deriveSlug,
  discoverProjects,
  discoverRuns,
  discoverProjectsWithReason,
  discoverRunsWithReason,
  discoverWorkflowMetas,
  parseWorkflowMeta,
  type FileSystemPort,
} from './index.ts';
import type { ProjectRef } from '@argus/contract';

// ---------------------------------------------------------------------------
// In-memory FileSystemPort. A flat map of absolute path -> file content; dirs are
// inferred from the path prefixes. Mirrors the node port surface but touches no disk.
// ---------------------------------------------------------------------------

class MemPort implements FileSystemPort {
  private files = new Map<string, string>();

  set(path: string, content: string): this {
    this.files.set(path, content);
    return this;
  }

  setJson(path: string, value: unknown): this {
    return this.set(path, JSON.stringify(value));
  }

  async readFile(path: string): Promise<string> {
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`ENOENT ${path}`);
    return v;
  }

  async readJson(path: string): Promise<unknown> {
    return JSON.parse(await this.readFile(path)) as unknown;
  }

  async listDir(path: string): Promise<Array<{ name: string; isDir: boolean }>> {
    const prefix = path.replace(/\/+$/, '') + '/';
    const names = new Map<string, boolean>(); // name -> isDir
    let any = false;
    for (const f of this.files.keys()) {
      if (!f.startsWith(prefix)) continue;
      any = true;
      const rest = f.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) names.set(rest, false);
      else names.set(rest.slice(0, slash), true);
    }
    if (!any) throw new Error(`ENOENT ${path}`); // missing dir -> reject (like node)
    return [...names.entries()].map(([name, isDir]) => ({ name, isDir }));
  }

  async stat() {
    return null;
  }
  async exists() {
    return false;
  }
  watch(): () => void {
    return () => {};
  }
}

// --- load the real finished fixtures (the synthetic tree is built from these) ---

const HERE = dirname(fileURLToPath(import.meta.url));
const FIN_DIR = pjoin(HERE, '..', '..', '..', '.argus', 'fixtures', 'finished');
const WF_DIR = pjoin(HERE, '..', '..', '..', '.argus', 'fixtures', 'named-workflows');

function fin(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(pjoin(FIN_DIR, `${name}.wf.json`), 'utf8')) as Record<string, unknown>;
}
function wfSrc(name: string): string {
  return readFileSync(pjoin(WF_DIR, name), 'utf8');
}

const HOME = '/fake/.claude';
const PROJECTS = `${HOME}/projects`;

/**
 * Build a synthetic ~/.claude/projects tree from the 5 real finished fixtures.
 * Each fixture is dropped under its on-disk slug/session/workflows/wf_<id>.json. We
 * derive the slug from the run's authoritative recovered projectPath so the tree is
 * realistic; runs whose scriptPath is the non-recoverable cache shape are placed
 * under the slug embedded in their scriptPath (the real on-disk location).
 */
function seedTree(): MemPort {
  const port = new MemPort();
  const entries: Array<{ fixture: string; slug: string; session: string; runId: string }> = [
    { fixture: 'completed-14agents', slug: '-Users-nicolas-devel-modal-rust', session: 'sess-a', runId: 'wf_aaa' },
    { fixture: 'completed-3agents', slug: '-Users-nicolas-devel-modal-rust', session: 'sess-b', runId: 'wf_bbb' },
    { fixture: 'failed-1agent', slug: '-Users-nicolas-devel-modal-rust', session: 'sess-c', runId: 'wf_ccc' },
    { fixture: 'killed-9agents', slug: '-Users-nicolas-devel-modal-rust', session: 'sess-d', runId: 'wf_ddd' },
    { fixture: 'completed-resumed-13agents', slug: '-Users-nicolas-devel-argus', session: 'sess-e', runId: 'wf_eee' },
  ];
  for (const e of entries) {
    port.setJson(`${PROJECTS}/${e.slug}/${e.session}/workflows/${e.runId}.json`, fin(e.fixture));
  }
  return port;
}

// ===========================================================================
// deriveSlug — deterministic, matches Claude Code's observed rule
// ===========================================================================

describe('deriveSlug (deterministic, observed Claude Code rule)', () => {
  it('plain devel/modal-rust case', () => {
    expect(deriveSlug('/Users/nicolas/devel/modal-rust')).toBe('-Users-nicolas-devel-modal-rust');
  });

  it('dotted hidden segment collapses to a double dash (.config -> --config)', () => {
    // The leading "/" and the "." of ".config" each map to "-", giving "--config".
    // Verified against the real on-disk dir name -Users-nicolas--config-ghostty.
    expect(deriveSlug('/Users/nicolas/.config/ghostty')).toBe('-Users-nicolas--config-ghostty');
  });

  it('is a pure function of its input (deterministic)', () => {
    const p = '/Users/nicolas/devel/argus';
    expect(deriveSlug(p)).toBe(deriveSlug(p));
    expect(deriveSlug(p)).toBe('-Users-nicolas-devel-argus');
  });
});

// ===========================================================================
// discoverRuns over a fake-port synthetic tree
// ===========================================================================

describe('discoverRuns over a synthetic tree (header fields only)', () => {
  it('modal-rust: correct status mix + abs-path RunRef keys', async () => {
    const port = seedTree();
    const project: ProjectRef = {
      projectPath: '/Users/nicolas/devel/modal-rust',
      slug: '-Users-nicolas-devel-modal-rust',
      name: 'modal-rust',
      sessionCount: 4,
    };
    const runs = await discoverRuns(port, project, HOME);

    // 4 runs land under modal-rust: two recover via scriptPath (.../modal-rust/.claude/...)
    // and two carry the non-recoverable cache scriptPath whose slug decodes to the same
    // path -> all four group under /Users/nicolas/devel/modal-rust.
    expect(runs.length).toBe(4);

    // every RunRef is keyed by the recovered ABSOLUTE projectPath, not the slug.
    for (const r of runs) {
      expect(r.ref.projectPath).toBe('/Users/nicolas/devel/modal-rust');
      expect(r.ref.slug).toBe('-Users-nicolas-devel-modal-rust');
    }

    const byName = new Map(runs.map((r) => [r.workflowName, r.status]));
    expect(byName.get('modal-rust-plan-research')).toBe('completed'); // completed-14
    expect(byName.get('modal-rust-ergonomics-e1')).toBe('completed'); // completed-3
    expect(byName.get('modal-rust-poc-validate')).toBe('failed'); // failed-1
    expect(byName.get('modal-rust-refine-plan')).toBe('killed'); // killed-9
  });

  it('full status mix across BOTH projects is completed/completed/failed/killed/completed', async () => {
    const port = seedTree();
    const modalRust: ProjectRef = {
      projectPath: '/Users/nicolas/devel/modal-rust',
      slug: '-Users-nicolas-devel-modal-rust',
      name: 'modal-rust',
      sessionCount: 4,
    };
    const argus: ProjectRef = {
      projectPath: '/Users/nicolas/devel/argus',
      slug: '-Users-nicolas-devel-argus',
      name: 'argus',
      sessionCount: 1,
    };
    const all = [...(await discoverRuns(port, modalRust, HOME)), ...(await discoverRuns(port, argus, HOME))];
    const statuses = all.map((r) => r.status).sort();
    expect(statuses).toEqual(['completed', 'completed', 'completed', 'failed', 'killed']);

    const argusRuns = await discoverRuns(port, argus, HOME);
    expect(argusRuns.length).toBe(1);
    expect(argusRuns[0]!.workflowName).toBe('argus-plan-research');
    expect(argusRuns[0]!.ref.projectPath).toBe('/Users/nicolas/devel/argus');
  });

  it('reads HEADER fields only: agentCount + partialFailure from logs (no progress walk)', async () => {
    const port = seedTree();
    const project: ProjectRef = {
      projectPath: '/Users/nicolas/devel/modal-rust',
      slug: '-Users-nicolas-devel-modal-rust',
      name: 'modal-rust',
      sessionCount: 4,
    };
    const runs = await discoverRuns(port, project, HOME);
    const plan = runs.find((r) => r.workflowName === 'modal-rust-plan-research')!;
    // completed-14agents carries a hidden `parallel[0] failed` log line -> partialFailure.
    expect(plan.partialFailure).toBe(true);
    // RunSummary has no per-agent arrays (header-only contract).
    expect(Object.keys(plan)).not.toContain('agents');
    expect(Object.keys(plan)).not.toContain('phases');
  });
});

// ===========================================================================
// discoverProjects + slug-collision -> multiple ProjectRef entries
// ===========================================================================

describe('discoverProjects (keyed/de-duped by recovered abs projectPath)', () => {
  it('groups the synthetic tree into the two real projects', async () => {
    const projects = await discoverProjects(seedTree(), HOME);
    const paths = projects.map((p) => p.projectPath).sort();
    expect(paths).toEqual(['/Users/nicolas/devel/argus', '/Users/nicolas/devel/modal-rust']);
    const modal = projects.find((p) => p.name === 'modal-rust')!;
    expect(modal.sessionCount).toBe(4);
  });

  it('SLUG COLLISION: two cwds sharing one slug dir surface as TWO ProjectRefs', async () => {
    // A single on-disk slug dir holds runs from two DIFFERENT recovered cwds (the
    // authoritative key). discoverProjects must split them into two switcher entries.
    const slug = '-Users-nicolas-devel-x';
    const port = new MemPort();
    port.setJson(`${PROJECTS}/${slug}/s1/workflows/wf_1.json`, {
      workflowName: 'x-a',
      status: 'completed',
      scriptPath: '/Users/nicolas/devel/x/.claude/workflows/a.js',
    });
    port.setJson(`${PROJECTS}/${slug}/s2/workflows/wf_2.json`, {
      workflowName: 'x-b',
      status: 'completed',
      // a DIFFERENT real cwd that happens to slugify to the same dir name
      scriptPath: '/Users/nicolas/devel-x/.claude/workflows/b.js',
    });
    const projects = await discoverProjects(port, HOME);
    const paths = projects.map((p) => p.projectPath).sort();
    expect(paths).toEqual(['/Users/nicolas/devel-x', '/Users/nicolas/devel/x']);
    // both still carry the same on-disk slug (kept for path-building).
    expect(projects.every((p) => p.slug === slug)).toBe(true);

    // discoverRuns filtered to each recovered cwd yields exactly its own run.
    const runsA = await discoverRuns(port, projects.find((p) => p.projectPath === '/Users/nicolas/devel/x')!, HOME);
    const runsB = await discoverRuns(port, projects.find((p) => p.projectPath === '/Users/nicolas/devel-x')!, HOME);
    expect(runsA.map((r) => r.workflowName)).toEqual(['x-a']);
    expect(runsB.map((r) => r.workflowName)).toEqual(['x-b']);
  });
});

// ===========================================================================
// Robustness: bogus/missing path -> empty-with-reason, never a throw
// ===========================================================================

describe('robustness: empty-with-reason (never throws)', () => {
  it('nonexistent claudeHome -> empty projects + a coded reason', async () => {
    const empty = new MemPort(); // nothing seeded
    await expect(discoverProjects(empty, '/nope/.claude')).resolves.toEqual([]);
    const rep = await discoverProjectsWithReason(empty, '/nope/.claude');
    expect(rep.items).toEqual([]);
    expect(rep.reasons.map((r) => r.code)).toContain('projects-dir-unreadable');
  });

  it('missing workflows dir for the project -> empty runs (no throw)', async () => {
    const port = new MemPort();
    // a session dir exists but has no workflows/ subdir
    port.setJson(`${PROJECTS}/-Users-nicolas-devel-z/sess/notes.txt` /* not a wf file */, 0 as unknown);
    const project: ProjectRef = {
      projectPath: '/Users/nicolas/devel/z',
      slug: '-Users-nicolas-devel-z',
      name: 'z',
      sessionCount: 1,
    };
    await expect(discoverRuns(port, project, HOME)).resolves.toEqual([]);
  });

  it('unreadable run header -> skipped with a reason, the rest still discovered', async () => {
    const port = new MemPort();
    const slug = '-Users-nicolas-devel-q';
    port.setJson(`${PROJECTS}/${slug}/s1/workflows/wf_ok.json`, {
      workflowName: 'q-ok',
      status: 'completed',
      scriptPath: '/Users/nicolas/devel/q/.claude/workflows/ok.js',
    });
    port.set(`${PROJECTS}/${slug}/s1/workflows/wf_bad.json`, '{ not json'); // unreadable JSON
    const project: ProjectRef = {
      projectPath: '/Users/nicolas/devel/q',
      slug,
      name: 'q',
      sessionCount: 1,
    };
    const rep = await discoverRunsWithReason(port, project, HOME);
    expect(rep.items.map((r) => r.workflowName)).toEqual(['q-ok']);
    expect(rep.reasons.map((r) => r.code)).toContain('run-header-unreadable');
  });
});

// ===========================================================================
// parseWorkflowMeta over real named-workflows + a null case
// ===========================================================================

describe('parseWorkflowMeta (static .claude/workflows/*.js meta)', () => {
  it('extracts name + phases from a real plan-research.js meta', () => {
    const meta = parseWorkflowMeta(wfSrc('plan-research.js'), 'plan-research.js');
    expect(meta).not.toBeNull();
    expect(meta!.name).toBe('modal-rust-plan-research');
    expect(meta!.file).toBe('plan-research.js');
    expect(meta!.phases.map((p) => p.title)).toEqual(['Research', 'Design', 'Review', 'Synthesize']);
    expect(meta!.whenToUse).toBeTruthy();
    expect(typeof meta!.description).toBe('string');
  });

  it('extracts the implement.js meta phases', () => {
    const meta = parseWorkflowMeta(wfSrc('implement.js'));
    expect(meta!.name).toBe('modal-rust-implement');
    expect(meta!.phases.map((p) => p.title)).toEqual(['Select', 'Implement', 'Verify', 'Record']);
  });

  it('returns null on a non-meta file (no export const meta) — never throws', () => {
    expect(parseWorkflowMeta('const x = 1; export const notMeta = {};')).toBeNull();
    expect(parseWorkflowMeta('')).toBeNull();
    expect(parseWorkflowMeta('export const meta = { /* unbalanced')).toBeNull();
  });

  it('discoverWorkflowMetas over the real named-workflows dir lists all 5', async () => {
    const port = new MemPort();
    const projectPath = '/Users/nicolas/devel/modal-rust';
    for (const f of [
      'build-modal-rust-sdk.js',
      'implement.js',
      'materialize-workpads.js',
      'plan-research.js',
      'refine-plan.js',
    ]) {
      port.set(`${projectPath}/.claude/workflows/${f}`, wfSrc(f));
    }
    // a junk file -> dropped with a reason, never a crash.
    port.set(`${projectPath}/.claude/workflows/broken.js`, 'console.log("no meta here")');
    const metas = await discoverWorkflowMetas(port, projectPath);
    expect(metas.length).toBe(5);
    expect(metas.map((m) => m.name)).toContain('modal-rust-plan-research');
  });

  it('missing .claude/workflows dir -> empty (no throw)', async () => {
    const port = new MemPort();
    await expect(discoverWorkflowMetas(port, '/Users/nicolas/devel/nowhere')).resolves.toEqual([]);
  });
});
