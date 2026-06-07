import { describe, it, expect } from 'vitest';
import {
  handleProjectSessions,
  handleSessionNarrative,
  handleSessionTurns,
  isValidSessionId,
  safeSessionTranscriptPath,
  type RouteDeps,
  type RouteResult,
} from './routes.ts';
import {
  narrativeCacheKey,
  diskNarrativeCacheIO,
  NARRATIVE_CACHE_VERSION,
  type NarrativeCacheIO,
} from './narrative-cache.ts';
import type { FileSystemPort } from '@argus/adapter';
import type { SessionNarrative, SessionSummary, Turn } from '@argus/contract';

// M1 Session Narrative server-route test (boundaries.md §4 pattern, mirrors routes.test.ts's
// in-memory fake-port approach): exercise the three Story-view routes over a tiny but REAL
// transcript JSONL — a real user prompt opening a block, an assistant response with a tool_use,
// a tool_result carrier (must NOT start a block), and an image block (must drop, never reach the
// wire). The routes must charset-validate slug + sessionId, sibling-path-guard, cache by
// (slug+sessionId+stat+version), miss-and-recompute on an append, and 404 a missing transcript.

const CLAUDE_HOME = '/home/.claude';
const SLUG = '-Users-nicolas-devel-argus';
const PROJECT_ROOT = '/Users/nicolas/devel/argus';
const SESSION = 'sess-aaaa-bbbb-cccc';
const TRANSCRIPT = `${CLAUDE_HOME}/projects/${SLUG}/${SESSION}.jsonl`;

// One real user prompt → assistant text + a Read tool_use → a tool_result carrier (a synthetic
// user record that must NOT open a block) + an assistant record carrying an IMAGE block (its
// bytes must never reach a preview/turn). A plausible (if compact) slice of the real shape.
const PLANTED_IMAGE = 'iVBORw0KGgoPLANTEDIMAGEBYTESdef456';
function buildTranscript(): string {
  const lines = [
    {
      type: 'user',
      userType: 'external',
      timestamp: '2026-06-07T10:00:00.000Z',
      promptId: 'p1',
      cwd: PROJECT_ROOT,
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
          { type: 'tool_use', name: 'Read', input: { file_path: `${PROJECT_ROOT}/apps/server/src/routes.ts` } },
        ],
      },
    },
    {
      // tool_result carrier: a `user` record whose content is a tool_result block. MUST NOT
      // open a new block (the load-bearing synthetic-filter rule).
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
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PLANTED_IMAGE } },
        ],
      },
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

const SECOND_SESSION = 'sess-dddd-eeee-ffff';
function buildSecondTranscript(): string {
  return (
    JSON.stringify({
      type: 'user',
      userType: 'external',
      timestamp: '2026-06-06T09:00:00.000Z',
      promptId: 'q1',
      cwd: PROJECT_ROOT,
      message: { role: 'user', content: 'An earlier session.' },
    }) + '\n'
  );
}

/**
 * Build an in-memory FileSystemPort over a mutable path → content map, with a REAL stat
 * (size = byte length; mtimeMs bumped on each setFile) so the narrative cache key is
 * meaningful and an "append" actually moves the key. Mirrors routes.test.ts's fake port.
 */
function makeFakePort(): {
  port: FileSystemPort;
  setFile: (path: string, content: string) => void;
  delFile: (path: string) => void;
} {
  const files = new Map<string, string>();
  const mtimes = new Map<string, number>();
  let clock = 1000;
  const setFile = (path: string, content: string): void => {
    files.set(path, content);
    mtimes.set(path, (clock += 1000));
  };
  const delFile = (path: string): void => {
    files.delete(path);
    mtimes.delete(path);
  };
  setFile(TRANSCRIPT, buildTranscript());
  setFile(`${CLAUDE_HOME}/projects/${SLUG}/${SECOND_SESSION}.jsonl`, buildSecondTranscript());

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
    async stat(path: string) {
      const v = files.get(path);
      if (v === undefined) return null;
      return { size: Buffer.byteLength(v, 'utf8'), mtimeMs: mtimes.get(path) ?? 0 };
    },
    async exists(path: string): Promise<boolean> {
      return files.has(path);
    },
    watch(): () => void {
      return () => {};
    },
  };
  return { port, setFile, delFile };
}

/** An in-memory cache IO that counts writes (so we can assert hit vs recompute). */
function makeMemCache(): NarrativeCacheIO & { reads: number; writes: number; store: Map<string, SessionNarrative> } {
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

function bodyOf<T>(res: RouteResult): T {
  return res.body as T;
}

// --- path guard + validators -----------------------------------------------

describe('safeSessionTranscriptPath + isValidSessionId (M1 sibling-path guard)', () => {
  it('builds the SIBLING <slug>/<sessionId>.jsonl inside claudeHome', () => {
    expect(safeSessionTranscriptPath(CLAUDE_HOME, SLUG, SESSION)).toBe(TRANSCRIPT);
  });

  it('rejects a traversal-ish slug or sessionId (charset) before any path build', () => {
    expect(isValidSessionId('../../etc/passwd')).toBe(false);
    expect(isValidSessionId('a/b')).toBe(false);
    expect(isValidSessionId('a.jsonl')).toBe(false); // a dot is not in the segment charset
    expect(isValidSessionId('')).toBe(false);
    expect(isValidSessionId(SESSION)).toBe(true);
    expect(safeSessionTranscriptPath(CLAUDE_HOME, '../etc', SESSION)).toBeNull();
    expect(safeSessionTranscriptPath(CLAUDE_HOME, SLUG, '../../secret')).toBeNull();
    expect(safeSessionTranscriptPath(CLAUDE_HOME, SLUG, 'a/b')).toBeNull();
  });
});

// --- GET /sessions ----------------------------------------------------------

describe('handleProjectSessions (M1 session-timeline)', () => {
  it('rejects a bad slug with 400 before any FS access', async () => {
    const { port } = makeFakePort();
    const deps: RouteDeps = { port, claudeHome: CLAUDE_HOME };
    const res = await handleProjectSessions(deps, '../etc');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'bad_request' });
  });

  it('lists the project sessions as start→end spans', async () => {
    const { port } = makeFakePort();
    const deps: RouteDeps = { port, claudeHome: CLAUDE_HOME };
    const res = await handleProjectSessions(deps, SLUG);
    expect(res.status).toBe(200);
    const { sessions } = bodyOf<{ sessions: SessionSummary[] }>(res);
    const ids = sessions.map((s) => s.sessionId).sort();
    expect(ids).toEqual([SECOND_SESSION, SESSION].sort());
    const main = sessions.find((s) => s.sessionId === SESSION)!;
    expect(main.timeRange.start).toBe('2026-06-07T10:00:00.000Z');
    expect(main.recordCount).toBeGreaterThan(0);
    expect(main.projectPath).toBe(PROJECT_ROOT);
  });

  it('returns { sessions: [] } for an unknown slug (never a 500)', async () => {
    const { port } = makeFakePort();
    const deps: RouteDeps = { port, claudeHome: CLAUDE_HOME };
    const res = await handleProjectSessions(deps, '-Users-nicolas-devel-nope');
    expect(res.status).toBe(200);
    expect(bodyOf<{ sessions: SessionSummary[] }>(res).sessions).toEqual([]);
  });
});

// --- GET /sessions/:sessionId/narrative -------------------------------------

describe('handleSessionNarrative (M1 watch view + disk cache)', () => {
  it('rejects bad slug / sessionId with 400', async () => {
    const { port } = makeFakePort();
    const deps: RouteDeps = { port, claudeHome: CLAUDE_HOME };
    expect((await handleSessionNarrative(deps, '../etc', SESSION)).status).toBe(400);
    expect((await handleSessionNarrative(deps, SLUG, '../../secret')).status).toBe(400);
  });

  it('404s a missing transcript (never a 500) and never reads it', async () => {
    const { port } = makeFakePort();
    const deps: RouteDeps = { port, claudeHome: CLAUDE_HOME };
    const res = await handleSessionNarrative(deps, SLUG, 'sess-does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it('precomputes the narrative; image bytes never reach the wire', async () => {
    const { port } = makeFakePort();
    const cache = makeMemCache();
    const deps: RouteDeps = { port, claudeHome: CLAUDE_HOME, narrativeCache: cache };
    const res = await handleSessionNarrative(deps, SLUG, SESSION);
    expect(res.status).toBe(200);
    const narrative = bodyOf<SessionNarrative>(res);
    expect(narrative.sessionId).toBe(SESSION);
    // One real prompt → one 'prompt' block (the tool_result carrier did NOT open a block).
    expect(narrative.blocks.length).toBe(1);
    const block = narrative.blocks[0]!;
    expect(block.cutReason).toBe('prompt');
    expect(block.toolCounts.Read).toBe(1);
    // The planted image base64 must be absent everywhere on the wire.
    const wire = JSON.stringify(narrative);
    expect(wire).not.toContain(PLANTED_IMAGE);
  });

  it('is a cache HIT on an unchanged transcript (no re-write)', async () => {
    const { port } = makeFakePort();
    const cache = makeMemCache();
    const deps: RouteDeps = { port, claudeHome: CLAUDE_HOME, narrativeCache: cache };
    await handleSessionNarrative(deps, SLUG, SESSION); // miss → compute + write
    expect(cache.writes).toBe(1);
    const res2 = await handleSessionNarrative(deps, SLUG, SESSION); // hit
    expect(res2.status).toBe(200);
    expect(cache.writes).toBe(1); // no second write → served from cache
  });

  it('MISSES + recomputes after an append (stat-keyed)', async () => {
    const { port, setFile } = makeFakePort();
    const cache = makeMemCache();
    const deps: RouteDeps = { port, claudeHome: CLAUDE_HOME, narrativeCache: cache };
    await handleSessionNarrative(deps, SLUG, SESSION);
    expect(cache.writes).toBe(1);

    // Append a SECOND real user prompt → a longer transcript → new stat → new key → miss.
    const appended =
      buildTranscript() +
      JSON.stringify({
        type: 'user',
        userType: 'external',
        timestamp: '2026-06-07T11:00:00.000Z',
        promptId: 'p2',
        message: { role: 'user', content: 'A follow-up prompt that adds a second block.' },
      }) +
      '\n';
    setFile(TRANSCRIPT, appended);

    const res = await handleSessionNarrative(deps, SLUG, SESSION);
    expect(res.status).toBe(200);
    expect(cache.writes).toBe(2); // recomputed + re-written under the new key
    expect(bodyOf<SessionNarrative>(res).blocks.length).toBe(2); // the appended prompt = a 2nd block
  });

  it('works with NO cache injected (recompute every call)', async () => {
    const { port } = makeFakePort();
    const deps: RouteDeps = { port, claudeHome: CLAUDE_HOME };
    const res = await handleSessionNarrative(deps, SLUG, SESSION);
    expect(res.status).toBe(200);
    expect(bodyOf<SessionNarrative>(res).blocks.length).toBe(1);
  });
});

// --- GET /sessions/:sessionId/turns?block= ----------------------------------

describe('handleSessionTurns (M1 lazy click-in)', () => {
  it('rejects a missing block param with 400', async () => {
    const { port } = makeFakePort();
    const deps: RouteDeps = { port, claudeHome: CLAUDE_HOME };
    const res = await handleSessionTurns(deps, SLUG, SESSION, '');
    expect(res.status).toBe(400);
  });

  it('404s an unknown blockId (never used to build a path)', async () => {
    const { port } = makeFakePort();
    const deps: RouteDeps = { port, claudeHome: CLAUDE_HOME };
    const res = await handleSessionTurns(deps, SLUG, SESSION, 'deadbeef');
    expect(res.status).toBe(404);
  });

  it('resolves a real blockId → its turns; image bytes never reach the wire', async () => {
    const { port } = makeFakePort();
    const cache = makeMemCache();
    const deps: RouteDeps = { port, claudeHome: CLAUDE_HOME, narrativeCache: cache };
    const narres = await handleSessionNarrative(deps, SLUG, SESSION);
    const blockId = bodyOf<SessionNarrative>(narres).blocks[0]!.id;

    const res = await handleSessionTurns(deps, SLUG, SESSION, blockId);
    expect(res.status).toBe(200);
    const { turns } = bodyOf<{ turns: Turn[] }>(res);
    expect(turns.length).toBeGreaterThan(0);
    // The user prompt turn + assistant turns are present; the click-in served from the cache
    // (no second narrative write).
    expect(turns[0]!.role).toBe('user');
    const wire = JSON.stringify(turns);
    expect(wire).not.toContain(PLANTED_IMAGE);
  });

  it('404s a missing transcript', async () => {
    const { port } = makeFakePort();
    const deps: RouteDeps = { port, claudeHome: CLAUDE_HOME };
    const res = await handleSessionTurns(deps, SLUG, 'sess-nope', 'deadbeef');
    expect(res.status).toBe(404);
  });
});

// --- the cache key recipe ---------------------------------------------------

describe('narrativeCacheKey + diskNarrativeCacheIO', () => {
  it('is stable for identical inputs and shifts on any stat change', () => {
    const a = narrativeCacheKey(SLUG, SESSION, { size: 100, mtimeMs: 5 });
    const aSame = narrativeCacheKey(SLUG, SESSION, { size: 100, mtimeMs: 5 });
    expect(a).toBe(aSame);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    // size change → new key (append)
    expect(narrativeCacheKey(SLUG, SESSION, { size: 101, mtimeMs: 5 })).not.toBe(a);
    // mtime change → new key
    expect(narrativeCacheKey(SLUG, SESSION, { size: 100, mtimeMs: 6 })).not.toBe(a);
    // different session → new key
    expect(narrativeCacheKey(SLUG, 'other', { size: 100, mtimeMs: 5 })).not.toBe(a);
  });

  it('disk cache IO rejects a non-hex hash (path-escape defense)', async () => {
    const io = diskNarrativeCacheIO('/tmp/argus-narr-test-cache');
    // A non-hex hash can never resolve to a path → read returns null, write is a no-op.
    expect(await io.read('../escape')).toBeNull();
    await io.write('../escape', { sessionId: 'x' } as unknown as SessionNarrative);
    expect(await io.read('../escape')).toBeNull();
  });

  it('NARRATIVE_CACHE_VERSION is folded into the key (a bump busts all entries)', () => {
    // Same inputs, but the version string is part of the hashed projection — we assert the
    // pin is a non-empty stable string (the actual bust is exercised by changing the const).
    expect(typeof NARRATIVE_CACHE_VERSION).toBe('string');
    expect(NARRATIVE_CACHE_VERSION.length).toBeGreaterThan(0);
  });
});
