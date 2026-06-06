import { describe, it, expect } from 'vitest';
import {
  handleProjectWorkflows,
  handleProjectPlan,
  handleRunPlan,
  handleRunSnapshot,
  handleAgentResult,
  isValidSegment,
  isValidRunId,
  isValidAgentId,
  isValidWorkflowFile,
  safeRunJsonPath,
  safeRunJournalPath,
  safeRunScriptPath,
  safeWorkflowJsPath,
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

// ============================================================================
// Path-traversal attack vectors (charset + resolve() guards). The route layer receives each
// segment POST-decode (index.ts's decodeSegment runs decodeURIComponent ONCE before dispatch),
// so the charset REs below are the authoritative guard on the decoded value. These harden the
// existing single-traversal checks with: URL-encoded-then-decoded traversal, absolute paths,
// null bytes, whitespace, non-ASCII, sibling-project escapes, double-encoding, and bad
// workflow-file shapes — across isValidSegment / isValidRunId / isValidAgentId /
// isValidWorkflowFile and every safe* path builder.
// ============================================================================
describe('path-traversal attack vectors (charset + resolve guards)', () => {
  describe('isValidSegment', () => {
    it('accepts the real slug / session / run shapes', () => {
      expect(isValidSegment('-Users-nicolas-devel-modal-rust')).toBe(true);
      expect(isValidSegment('session-aaaa-bbbb')).toBe(true);
      expect(isValidSegment('wf_abc123')).toBe(true);
    });

    it('rejects dot-segments and parent traversal', () => {
      expect(isValidSegment('..')).toBe(false);
      expect(isValidSegment('.')).toBe(false);
      expect(isValidSegment('..foo')).toBe(false); // a dot is not in the charset
      expect(isValidSegment('a.b')).toBe(false);
    });

    it('rejects decoded URL-encoded traversal (%2e%2e / %2f → "..", "/" post-decode)', () => {
      // index.ts decodes ONCE; the route sees the decoded value, which the charset RE blocks.
      expect(isValidSegment(decodeURIComponent('%2e%2e'))).toBe(false); // ".."
      expect(isValidSegment(decodeURIComponent('%2e%2e%2f'))).toBe(false); // "../"
      expect(isValidSegment(decodeURIComponent('foo%2fbar'))).toBe(false); // "foo/bar"
      expect(isValidSegment(decodeURIComponent('foo%5cbar'))).toBe(false); // "foo\bar"
    });

    it('rejects path separators and absolute paths', () => {
      expect(isValidSegment('/etc/passwd')).toBe(false);
      expect(isValidSegment('etc/passwd')).toBe(false);
      expect(isValidSegment('\\windows\\system32')).toBe(false);
      expect(isValidSegment('C:\\windows')).toBe(false);
    });

    it('rejects null bytes and control characters', () => {
      expect(isValidSegment('foo\x00')).toBe(false);
      expect(isValidSegment('\x00')).toBe(false);
      expect(isValidSegment('foo\nbar')).toBe(false);
      expect(isValidSegment('foo\tbar')).toBe(false);
    });

    it('rejects whitespace and non-ASCII', () => {
      expect(isValidSegment('.. /etc')).toBe(false);
      expect(isValidSegment('a b')).toBe(false);
      expect(isValidSegment('café')).toBe(false); // é (decoded from %C3%A9) is outside the charset
      expect(isValidSegment(decodeURIComponent('%C3%A9'))).toBe(false);
    });

    it('rejects empty and over-length segments', () => {
      expect(isValidSegment('')).toBe(false);
      expect(isValidSegment('a'.repeat(257))).toBe(false);
      expect(isValidSegment('a'.repeat(256))).toBe(true);
    });

    it('double-encoding only decodes ONE layer; the residual %xx is still blocked', () => {
      // %252e%252e → (one decode) → "%2e%2e" — the literal '%' is not in the charset.
      expect(isValidSegment(decodeURIComponent('%252e%252e'))).toBe(false);
    });
  });

  describe('isValidRunId', () => {
    it('requires the wf_ prefix', () => {
      expect(isValidRunId('wf_abc123')).toBe(true);
      expect(isValidRunId('run_abc')).toBe(false);
      expect(isValidRunId('abc')).toBe(false);
      expect(isValidRunId('WF_abc')).toBe(false); // case-sensitive prefix
    });

    it('rejects wf_ with traversal / separators in the suffix', () => {
      expect(isValidRunId('wf_../../etc')).toBe(false);
      expect(isValidRunId('wf_/etc')).toBe(false);
      expect(isValidRunId('wf_a.b')).toBe(false);
    });

    it('requires a non-empty suffix after wf_', () => {
      expect(isValidRunId('wf_')).toBe(false);
      expect(isValidRunId('wf_a')).toBe(true);
    });
  });

  describe('isValidAgentId', () => {
    it('accepts a hex-ish token, rejects traversal / separators / null bytes', () => {
      expect(isValidAgentId('a403d457ffb0b3e01')).toBe(true);
      expect(isValidAgentId('../../etc')).toBe(false);
      expect(isValidAgentId('a/b')).toBe(false);
      expect(isValidAgentId('a\x00')).toBe(false);
      expect(isValidAgentId('')).toBe(false);
      expect(isValidAgentId('a'.repeat(129))).toBe(false);
    });
  });

  describe('isValidWorkflowFile', () => {
    it('accepts a plain .js basename', () => {
      expect(isValidWorkflowFile('plan-research.js')).toBe(true);
      expect(isValidWorkflowFile('implement_v2.js')).toBe(true);
    });

    it('rejects embedded path separators', () => {
      expect(isValidWorkflowFile('subdir/file.js')).toBe(false);
      expect(isValidWorkflowFile('..\\file.js')).toBe(false);
      expect(isValidWorkflowFile('/abs/file.js')).toBe(false);
    });

    it('rejects wrong / missing / double extensions', () => {
      expect(isValidWorkflowFile('file')).toBe(false);
      expect(isValidWorkflowFile('file.ts')).toBe(false);
      expect(isValidWorkflowFile('file.js.bak')).toBe(false);
      expect(isValidWorkflowFile('file.JS')).toBe(false); // case-sensitive .js
      expect(isValidWorkflowFile('file.Js')).toBe(false);
    });

    it('rejects traversal and bare-dot names', () => {
      expect(isValidWorkflowFile('../escape.js')).toBe(false);
      expect(isValidWorkflowFile('..js')).toBe(false); // ".." is forbidden explicitly
      expect(isValidWorkflowFile('.js')).toBe(false); // empty stem
    });

    it('rejects null bytes and over-length names', () => {
      expect(isValidWorkflowFile('file\x00.js')).toBe(false);
      expect(isValidWorkflowFile('a'.repeat(260) + '.js')).toBe(false);
    });
  });

  describe('safe* path builders stay inside the home / workflows root', () => {
    const HOME = '/home/.claude';
    const OK_SLUG = '-Users-nicolas-devel-modal-rust';
    const OK_SESSION = 'session-aaaa';
    const OK_RUN = 'wf_runtest';

    it('safeRunJsonPath: valid → inside home; traversal/bad segments → null', () => {
      const ok = safeRunJsonPath(HOME, OK_SLUG, OK_SESSION, OK_RUN);
      expect(ok).not.toBeNull();
      expect(ok!.startsWith('/home/.claude/')).toBe(true);
      expect(ok!.endsWith(`${OK_RUN}.json`)).toBe(true);
      // Each segment rejected on bad charset (before any resolve()).
      expect(safeRunJsonPath(HOME, '../etc', OK_SESSION, OK_RUN)).toBeNull();
      expect(safeRunJsonPath(HOME, OK_SLUG, '../../etc', OK_RUN)).toBeNull();
      expect(safeRunJsonPath(HOME, OK_SLUG, OK_SESSION, '../../etc')).toBeNull();
      expect(safeRunJsonPath(HOME, OK_SLUG, OK_SESSION, 'notawf')).toBeNull();
    });

    it('safeRunJournalPath: valid → inside home; sibling-project escape → null', () => {
      const ok = safeRunJournalPath(HOME, OK_SLUG, OK_SESSION, OK_RUN);
      expect(ok).not.toBeNull();
      expect(ok!.startsWith('/home/.claude/')).toBe(true);
      expect(ok!.endsWith('/journal.jsonl')).toBe(true);
      // A sibling-project slug with a traversal session never escapes the charset gate.
      expect(safeRunJournalPath(HOME, '-Users-other-project', '../../../other', OK_RUN)).toBeNull();
    });

    it('safeRunScriptPath: a bad script basename is rejected even with valid segments', () => {
      expect(safeRunScriptPath(HOME, OK_SLUG, OK_SESSION, OK_RUN, 'real.js')).not.toBeNull();
      expect(safeRunScriptPath(HOME, OK_SLUG, OK_SESSION, OK_RUN, '../../escape.js')).toBeNull();
      expect(safeRunScriptPath(HOME, OK_SLUG, OK_SESSION, OK_RUN, 'scripts/../../escape.js')).toBeNull();
      expect(safeRunScriptPath(HOME, OK_SLUG, OK_SESSION, OK_RUN, 'evil.ts')).toBeNull();
    });

    it('safeWorkflowJsPath: stays inside <project>/.claude/workflows; traversal → null', () => {
      const ok = safeWorkflowJsPath('/Users/x/project', 'plan-research.js');
      expect(ok).toBe('/Users/x/project/.claude/workflows/plan-research.js');
      expect(safeWorkflowJsPath('/Users/x/project', '../../escape.js')).toBeNull();
      expect(safeWorkflowJsPath('/Users/x/project', 'sub/escape.js')).toBeNull();
      expect(safeWorkflowJsPath('/Users/x/project', 'evil.ts')).toBeNull();
    });
  });

  describe('full-dispatch: bad segments are 400 BEFORE any FS access', () => {
    const deps: RouteDeps = { port: makeFakePort(), claudeHome: CLAUDE_HOME };

    it('handleRunSnapshot rejects an absolute-path-like / traversal runId with 400', async () => {
      expect((await handleRunSnapshot(deps, SLUG, SESSION, '../../etc')).status).toBe(400);
      expect((await handleRunSnapshot(deps, SLUG, SESSION, 'notawf')).status).toBe(400);
      expect((await handleRunSnapshot(deps, '../etc', SESSION, RUN_ID)).status).toBe(400);
    });

    it('handleAgentResult rejects a traversal agentId with 400', async () => {
      expect((await handleAgentResult(deps, SLUG, SESSION, RUN_ID, '../../etc')).status).toBe(400);
      expect((await handleAgentResult(deps, SLUG, SESSION, RUN_ID, 'a/b')).status).toBe(400);
      expect((await handleAgentResult(deps, SLUG, SESSION, '../../etc', 'agent1')).status).toBe(400);
    });
  });
});
