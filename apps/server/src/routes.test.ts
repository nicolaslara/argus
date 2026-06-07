import { describe, it, expect } from 'vitest';
import {
  handleProjectWorkflows,
  handleProjectPlan,
  handleRunPlan,
  handleRunSnapshot,
  handleAgentResult,
  handleProjectSessions,
  handleSessionNarrative,
  handleSessionTurns,
  isValidSegment,
  isValidRunId,
  isValidAgentId,
  isValidSessionId,
  isValidWorkflowFile,
  safeRunJsonPath,
  safeRunJournalPath,
  safeRunScriptPath,
  safeSessionTranscriptPath,
  safeWorkflowJsPath,
  type RouteDeps,
  type RouteResult,
} from './routes.ts';
import { tokenOk, hostAllowed } from './auth.ts';
import type { IncomingMessage } from 'node:http';
import { narrativeCacheKey, type NarrativeCacheIO, type TranscriptStat } from './narrative-cache.ts';
import type { FileSystemPort } from '@argus/adapter';
import type { PlanModel, SessionNarrative, SessionSummary, Turn } from '@argus/contract';

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

// ============================================================================
// Session Narrative ("Story" view) routes — M1 server layer.
//
// project → sessions-on-a-timeline → per-session topic blocks → (lazy) full turns.
// These exercise the three M1 routes over a tiny but REAL transcript JSONL (a real user
// prompt opening a block, an assistant response with a Read tool_use, a tool_result CARRIER
// user record that must NOT open a block, and an IMAGE block whose bytes must never reach the
// wire). They mirror routes.test.ts's in-memory fake-port approach but add a TRACKING port
// (every FS method records a call) so the security test can prove the auth gate (tokenOk +
// hostAllowed, enforced in index.ts BEFORE this route layer) rejects an un-tokened / foreign-
// Origin request 401/403 WITHOUT any FS read ever happening.
//   (a) GET /sessions          -> SessionSummary[] rows
//   (b) GET /narrative         -> SessionNarrative; same-stat = cache HIT, changed-stat recomputes
//   (c) GET /turns?block=      -> a block's Turn[]
//   (d) SECURITY: un-tokened / foreign-Origin 401/403 before any FS read; traversal sessionId rejected
//   (e) a missing transcript   -> 404, never 500
// ============================================================================

const NARR_SLUG = '-Users-nicolas-devel-argus';
const NARR_PROJECT_ROOT = '/Users/nicolas/devel/argus';
const NARR_SESSION = 'sess-aaaa-bbbb-cccc';
const NARR_TRANSCRIPT = `${CLAUDE_HOME}/projects/${NARR_SLUG}/${NARR_SESSION}.jsonl`;
const NARR_SECOND_SESSION = 'sess-dddd-eeee-ffff';

// A planted image base64 + a planted tool-result text: both must be ABSENT from the wire
// (image bytes are dropped in the adapter; the tool_result carrier never opens a block).
const NARR_PLANTED_IMAGE = 'iVBORw0KGgoPLANTEDNARRATIVEBYTES789';

function buildNarrTranscript(): string {
  const lines = [
    {
      type: 'user',
      userType: 'external',
      timestamp: '2026-06-07T10:00:00.000Z',
      promptId: 'p1',
      cwd: NARR_PROJECT_ROOT,
      message: { role: 'user', content: 'Wire the M1 server routes for the Story view.' },
    },
    {
      type: 'assistant',
      timestamp: '2026-06-07T10:00:05.000Z',
      promptId: 'a1',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'On it — reading the routes file first.' },
          { type: 'tool_use', name: 'Read', input: { file_path: `${NARR_PROJECT_ROOT}/apps/server/src/routes.ts` } },
        ],
      },
    },
    {
      // tool_result CARRIER: a `user` record whose content is a tool_result block. MUST NOT
      // open a new block (the load-bearing synthetic-filter rule) and its text never starts one.
      type: 'user',
      userType: 'external',
      timestamp: '2026-06-07T10:00:06.000Z',
      promptId: 'tr1',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: [{ type: 'text', text: 'file contents…' }] }],
      },
    },
    {
      // an assistant record carrying an IMAGE block — its base64 bytes must be dropped.
      type: 'assistant',
      timestamp: '2026-06-07T10:00:09.000Z',
      promptId: 'a2',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Here is the screenshot result.' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: NARR_PLANTED_IMAGE } },
        ],
      },
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

function buildNarrSecondTranscript(): string {
  return (
    JSON.stringify({
      type: 'user',
      userType: 'external',
      timestamp: '2026-06-06T09:00:00.000Z',
      promptId: 'q1',
      cwd: NARR_PROJECT_ROOT,
      message: { role: 'user', content: 'An earlier session.' },
    }) + '\n'
  );
}

/**
 * A TRACKING in-memory FileSystemPort over a mutable path → content map, with a REAL stat
 * (size = byte length; mtimeMs bumped per setFile) so the narrative cache key is meaningful
 * and an "append" actually moves the key. Every method records into `calls` so a test can
 * assert NO FS access happened (the auth-gate-before-FS-read proof). Mirrors routes.test.ts's
 * makeFakePort + routes.narrative.test.ts's stat-aware port.
 */
function makeNarrPort(): {
  port: FileSystemPort;
  setFile: (path: string, content: string) => void;
  delFile: (path: string) => void;
  calls: string[];
} {
  const files = new Map<string, string>();
  const mtimes = new Map<string, number>();
  const calls: string[] = [];
  let clock = 1000;
  const setFile = (path: string, content: string): void => {
    files.set(path, content);
    mtimes.set(path, (clock += 1000));
  };
  const delFile = (path: string): void => {
    files.delete(path);
    mtimes.delete(path);
  };
  setFile(NARR_TRANSCRIPT, buildNarrTranscript());
  setFile(`${CLAUDE_HOME}/projects/${NARR_SLUG}/${NARR_SECOND_SESSION}.jsonl`, buildNarrSecondTranscript());

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

  const port: FileSystemPort = {
    async readFile(path: string): Promise<string> {
      calls.push(`readFile:${path}`);
      const v = files.get(path);
      if (v === undefined) throw new Error(`ENOENT: ${path}`);
      return v;
    },
    async readJson(path: string): Promise<unknown> {
      calls.push(`readJson:${path}`);
      const v = files.get(path);
      if (v === undefined) throw new Error(`ENOENT: ${path}`);
      return JSON.parse(v);
    },
    async listDir(path: string) {
      calls.push(`listDir:${path}`);
      return listDir(path);
    },
    async stat(path: string) {
      calls.push(`stat:${path}`);
      const v = files.get(path);
      if (v === undefined) return null;
      return { size: Buffer.byteLength(v, 'utf8'), mtimeMs: mtimes.get(path) ?? 0 };
    },
    async exists(path: string): Promise<boolean> {
      calls.push(`exists:${path}`);
      return files.has(path);
    },
    watch(): () => void {
      return () => {};
    },
  };
  return { port, setFile, delFile, calls };
}

/** An in-memory cache IO that counts reads/writes (so we can assert hit vs recompute). */
function makeNarrCache(): NarrativeCacheIO & {
  reads: number;
  writes: number;
  store: Map<string, SessionNarrative>;
} {
  const store = new Map<string, SessionNarrative>();
  return {
    reads: 0,
    writes: 0,
    store,
    async read(hash: string) {
      this.reads += 1;
      return store.get(hash) ?? null;
    },
    async write(hash: string, entry: SessionNarrative) {
      this.writes += 1;
      store.set(hash, entry);
    },
  };
}

function narrBody<T>(res: RouteResult): T {
  return res.body as T;
}

// (a) GET /api/projects/:slug/sessions -> SessionSummary[] rows -----------------
describe('handleProjectSessions (M1 — the session-timeline rows)', () => {
  it('returns the SessionSummary rows for a real project (start→end spans + counts)', async () => {
    const { port } = makeNarrPort();
    const deps: RouteDeps = { port, claudeHome: CLAUDE_HOME };
    const res = await handleProjectSessions(deps, NARR_SLUG);
    expect(res.status).toBe(200);
    const { sessions } = narrBody<{ sessions: SessionSummary[] }>(res);
    expect(sessions.map((s) => s.sessionId).sort()).toEqual([NARR_SECOND_SESSION, NARR_SESSION].sort());
    const main = sessions.find((s) => s.sessionId === NARR_SESSION)!;
    expect(main.timeRange.start).toBe('2026-06-07T10:00:00.000Z');
    expect(main.timeRange.end).toBe('2026-06-07T10:00:09.000Z');
    expect(main.recordCount).toBeGreaterThan(0);
    expect(main.projectPath).toBe(NARR_PROJECT_ROOT);
  });

  it('rejects a traversal-ish slug with 400 before any FS access', async () => {
    const { port, calls } = makeNarrPort();
    const deps: RouteDeps = { port, claudeHome: CLAUDE_HOME };
    const res = await handleProjectSessions(deps, '../etc');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'bad_request' });
    expect(calls).toEqual([]); // a bad slug never touches the FS
  });

  it('returns { sessions: [] } for an unknown slug (never a 500)', async () => {
    const { port } = makeNarrPort();
    const deps: RouteDeps = { port, claudeHome: CLAUDE_HOME };
    const res = await handleProjectSessions(deps, '-Users-nicolas-devel-nope');
    expect(res.status).toBe(200);
    expect(narrBody<{ sessions: SessionSummary[] }>(res).sessions).toEqual([]);
  });
});

// (b) GET /narrative -> SessionNarrative; same-stat = HIT, changed-stat recomputes -
describe('handleSessionNarrative (M1 — watch view + the stat-keyed disk cache)', () => {
  it('precomputes a SessionNarrative; the tool_result carrier opens no block; image bytes never reach the wire', async () => {
    const { port } = makeNarrPort();
    const deps: RouteDeps = { port, claudeHome: CLAUDE_HOME, narrativeCache: makeNarrCache() };
    const res = await handleSessionNarrative(deps, NARR_SLUG, NARR_SESSION);
    expect(res.status).toBe(200);
    const narrative = narrBody<SessionNarrative>(res);
    expect(narrative.sessionId).toBe(NARR_SESSION);
    // ONE real prompt → ONE 'prompt' block (the tool_result carrier did NOT open a block).
    expect(narrative.blocks.length).toBe(1);
    expect(narrative.blocks[0]!.cutReason).toBe('prompt');
    expect(narrative.blocks[0]!.toolCounts.Read).toBe(1);
    // The planted image base64 must be absent everywhere on the wire.
    expect(JSON.stringify(narrative)).not.toContain(NARR_PLANTED_IMAGE);
  });

  it('a SECOND call on the SAME stat is a cache HIT (no recompute / no second write)', async () => {
    const { port, calls } = makeNarrPort();
    const cache = makeNarrCache();
    const deps: RouteDeps = { port, claudeHome: CLAUDE_HOME, narrativeCache: cache };
    await handleSessionNarrative(deps, NARR_SLUG, NARR_SESSION); // miss → compute + write
    expect(cache.writes).toBe(1);
    const readFilesAfterFirst = calls.filter((c) => c.startsWith(`readFile:${NARR_TRANSCRIPT}`)).length;
    expect(readFilesAfterFirst).toBe(1); // the first (miss) read the 67 MB-equivalent transcript once

    const res2 = await handleSessionNarrative(deps, NARR_SLUG, NARR_SESSION); // HIT
    expect(res2.status).toBe(200);
    expect(cache.writes).toBe(1); // no second write → served from the cache
    // A hit must NOT re-read the transcript (the whole point of the stat-keyed cache).
    expect(calls.filter((c) => c.startsWith(`readFile:${NARR_TRANSCRIPT}`)).length).toBe(1);
  });

  it('a CHANGED stat (append) MISSES + recomputes under the new key', async () => {
    const { port, setFile } = makeNarrPort();
    const cache = makeNarrCache();
    const deps: RouteDeps = { port, claudeHome: CLAUDE_HOME, narrativeCache: cache };
    await handleSessionNarrative(deps, NARR_SLUG, NARR_SESSION);
    expect(cache.writes).toBe(1);

    // Append a SECOND real user prompt → a longer transcript → a new stat → a new key → a miss.
    const appended =
      buildNarrTranscript() +
      JSON.stringify({
        type: 'user',
        userType: 'external',
        timestamp: '2026-06-07T11:00:00.000Z',
        promptId: 'p2',
        message: { role: 'user', content: 'A follow-up prompt that adds a second block.' },
      }) +
      '\n';
    setFile(NARR_TRANSCRIPT, appended);

    const res = await handleSessionNarrative(deps, NARR_SLUG, NARR_SESSION);
    expect(res.status).toBe(200);
    expect(cache.writes).toBe(2); // recomputed + re-written under the NEW (stat-shifted) key
    expect(narrBody<SessionNarrative>(res).blocks.length).toBe(2); // the appended prompt = a 2nd block
    // The two writes are under DISTINCT cache keys (the stat moved).
    expect(cache.store.size).toBe(2);
  });

  it('works with NO cache injected (recompute every call, still correct)', async () => {
    const { port } = makeNarrPort();
    const deps: RouteDeps = { port, claudeHome: CLAUDE_HOME };
    const res = await handleSessionNarrative(deps, NARR_SLUG, NARR_SESSION);
    expect(res.status).toBe(200);
    expect(narrBody<SessionNarrative>(res).blocks.length).toBe(1);
  });
});

// (c) GET /turns?block= -> a block's Turn[] -----------------------------------
describe('handleSessionTurns (M1 — the lazy click-in view)', () => {
  it('resolves a real blockId → its Turn[]; image bytes never reach the wire', async () => {
    const { port } = makeNarrPort();
    const cache = makeNarrCache();
    const deps: RouteDeps = { port, claudeHome: CLAUDE_HOME, narrativeCache: cache };
    const narres = await handleSessionNarrative(deps, NARR_SLUG, NARR_SESSION);
    const blockId = narrBody<SessionNarrative>(narres).blocks[0]!.id;

    const res = await handleSessionTurns(deps, NARR_SLUG, NARR_SESSION, blockId);
    expect(res.status).toBe(200);
    const { turns } = narrBody<{ turns: Turn[] }>(res);
    expect(turns.length).toBeGreaterThan(0);
    expect(turns[0]!.role).toBe('user'); // the real prompt is the first turn
    expect(turns.some((t) => t.role === 'assistant')).toBe(true);
    // A click-in NEVER emits the dropped image bytes.
    expect(JSON.stringify(turns)).not.toContain(NARR_PLANTED_IMAGE);
  });

  it('rejects a missing block param with 400', async () => {
    const { port } = makeNarrPort();
    const deps: RouteDeps = { port, claudeHome: CLAUDE_HOME };
    expect((await handleSessionTurns(deps, NARR_SLUG, NARR_SESSION, '')).status).toBe(400);
  });

  it('404s an unknown blockId (the blockId is matched against the narrative, never used to build a path)', async () => {
    const { port } = makeNarrPort();
    const deps: RouteDeps = { port, claudeHome: CLAUDE_HOME };
    expect((await handleSessionTurns(deps, NARR_SLUG, NARR_SESSION, 'deadbeef')).status).toBe(404);
  });
});

// (d) SECURITY — auth gate before any FS read + path-traversal sessionId rejection
describe('M1 narrative routes — SECURITY (auth gate before any FS read; traversal sessionId rejected)', () => {
  const HOSTS = new Set(['127.0.0.1:4317', 'localhost:4317']);
  const ORIGINS = new Set(['http://127.0.0.1:4317', 'http://localhost:4317']);
  const TOKEN = 'secret-token-abc';

  /** A minimal IncomingMessage stand-in carrying just the headers the guards read. */
  function req(headers: Record<string, string> = {}): IncomingMessage {
    return { headers } as unknown as IncomingMessage;
  }
  const narrativeUrl = new URL(
    `http://127.0.0.1:4317/api/projects/${NARR_SLUG}/sessions/${NARR_SESSION}/narrative`,
  );

  /**
   * Model index.ts's dispatch ORDER: hostAllowed → tokenOk → (only then) the route handler.
   * The handler is the ONLY thing that touches the FS, so if the gate fails first the tracking
   * port records ZERO calls. Returns {status, fsTouched} so the test asserts both at once.
   */
  async function gatedNarrative(
    deps: RouteDeps,
    calls: string[],
    reqHeaders: Record<string, string>,
    url: URL,
  ): Promise<{ status: number; fsTouched: boolean }> {
    if (!hostAllowed(req(reqHeaders), HOSTS, ORIGINS)) {
      return { status: 403, fsTouched: calls.length > 0 };
    }
    if (!tokenOk(req(reqHeaders), url, TOKEN)) {
      return { status: 401, fsTouched: calls.length > 0 };
    }
    const res = await handleSessionNarrative(deps, NARR_SLUG, NARR_SESSION);
    return { status: res.status, fsTouched: calls.length > 0 };
  }

  it('an UN-TOKENED call 401s BEFORE any FS read (no readFile/stat/listDir hit)', async () => {
    const { port, calls } = makeNarrPort();
    const deps: RouteDeps = { port, claudeHome: CLAUDE_HOME };
    const out = await gatedNarrative(deps, calls, { host: '127.0.0.1:4317' /* no token */ }, narrativeUrl);
    expect(out.status).toBe(401);
    expect(out.fsTouched).toBe(false);
    expect(calls).toEqual([]);
  });

  it('a FOREIGN-Origin call 403s BEFORE any FS read (DNS-rebinding guard, no FS hit)', async () => {
    const { port, calls } = makeNarrPort();
    const deps: RouteDeps = { port, claudeHome: CLAUDE_HOME };
    const out = await gatedNarrative(
      deps,
      calls,
      { host: '127.0.0.1:4317', origin: 'http://evil.example.com', authorization: `Bearer ${TOKEN}` },
      narrativeUrl,
    );
    expect(out.status).toBe(403);
    expect(out.fsTouched).toBe(false);
    expect(calls).toEqual([]);
  });

  it('a correctly-tokened, same-origin call PASSES the gate and reaches the handler (200)', async () => {
    const { port, calls } = makeNarrPort();
    const deps: RouteDeps = { port, claudeHome: CLAUDE_HOME };
    const out = await gatedNarrative(
      deps,
      calls,
      { host: '127.0.0.1:4317', authorization: `Bearer ${TOKEN}` },
      narrativeUrl,
    );
    expect(out.status).toBe(200);
    expect(out.fsTouched).toBe(true); // only NOW does the FS get read (post-gate)
  });

  it('rejects a path-traversal sessionId (../, absolute, bad charset) with 400 — no FS read', async () => {
    const { port, calls } = makeNarrPort();
    const deps: RouteDeps = { port, claudeHome: CLAUDE_HOME };
    // The charset validator forbids every traversal shape.
    expect(isValidSessionId('../../etc/passwd')).toBe(false);
    expect(isValidSessionId('/etc/passwd')).toBe(false);
    expect(isValidSessionId('a/b')).toBe(false);
    expect(isValidSessionId('a.jsonl')).toBe(false); // a dot is outside the segment charset
    expect(isValidSessionId('foo\x00')).toBe(false);
    expect(isValidSessionId(NARR_SESSION)).toBe(true);
    // safeSessionTranscriptPath returns null on any escape (the `.jsonl` suffix is OURS, never input).
    expect(safeSessionTranscriptPath(CLAUDE_HOME, NARR_SLUG, NARR_SESSION)).toBe(NARR_TRANSCRIPT);
    expect(safeSessionTranscriptPath(CLAUDE_HOME, NARR_SLUG, '../../secret')).toBeNull();
    expect(safeSessionTranscriptPath(CLAUDE_HOME, '../etc', NARR_SESSION)).toBeNull();
    // And the route 400s a traversal sessionId / slug BEFORE any FS access.
    for (const bad of ['../../etc/passwd', '/etc/passwd', 'a/b']) {
      const res = await handleSessionNarrative(deps, NARR_SLUG, bad);
      expect(res.status).toBe(400);
    }
    expect((await handleSessionNarrative(deps, '../etc', NARR_SESSION)).status).toBe(400);
    expect((await handleSessionTurns(deps, NARR_SLUG, '../../etc', 'someblock')).status).toBe(400);
    expect(calls).toEqual([]); // every rejection happened before any FS read
  });
});

// (e) a MISSING transcript -> 404, never 500 ----------------------------------
describe('M1 narrative routes — a missing transcript is a 404 (never a 500)', () => {
  it('handleSessionNarrative 404s a missing transcript via the cheap stat probe (never the 67 MB read)', async () => {
    const { port, calls } = makeNarrPort();
    const deps: RouteDeps = { port, claudeHome: CLAUDE_HOME, narrativeCache: makeNarrCache() };
    const res = await handleSessionNarrative(deps, NARR_SLUG, 'sess-does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
    // A missing transcript is detected by stat() — never by a readFile of the absent file.
    expect(calls.some((c) => c.startsWith('readFile:'))).toBe(false);
  });

  it('handleSessionTurns 404s a missing transcript (never a 500)', async () => {
    const { port } = makeNarrPort();
    const deps: RouteDeps = { port, claudeHome: CLAUDE_HOME };
    const res = await handleSessionTurns(deps, NARR_SLUG, 'sess-nope', 'deadbeef');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it('a transcript that VANISHES between the stat and the read degrades to 404, never 500', async () => {
    const { port, delFile } = makeNarrPort();
    const cache = makeNarrCache();
    const deps: RouteDeps = { port, claudeHome: CLAUDE_HOME, narrativeCache: cache };
    // Hand-poison the cache: a key for the CURRENT stat exists, but the read returns null and the
    // transcript is deleted before the recompute read — loadSessionNarrative's readFile throws →
    // the handler maps it to 404 (never a 500 / leaked stack).
    const st = await port.stat(NARR_TRANSCRIPT);
    expect(st).not.toBeNull();
    const key = narrativeCacheKey(NARR_SLUG, NARR_SESSION, st as TranscriptStat);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    delFile(NARR_TRANSCRIPT); // vanish AFTER computing the would-be stat
    const res = await handleSessionNarrative(deps, NARR_SLUG, NARR_SESSION);
    // Now stat() returns null → 404 at the probe (the cheapest path). Still never a 500.
    expect(res.status).toBe(404);
  });
});
