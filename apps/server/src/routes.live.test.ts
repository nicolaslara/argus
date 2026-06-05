import { describe, it, expect } from 'vitest';
import {
  handleRunLive,
  handleProjectRuns,
  handleAgentResult,
  handleAgentActivity,
  handleDescribe,
  handleStream,
  safeRunJournalPath,
  type RouteDeps,
  type SseResponse,
} from './routes.ts';
import { SubUiEngine } from './subui.ts';
import type { FileSystemPort } from '@argus/adapter';
import type { AgentActivity, RunModel, RunSummary } from '@argus/contract';

// Live-route tests (L1 detection + L2 live snapshot). Self-contained: a fake port with a
// WORKING stat (mtime) so running-run detection fires, over a tree that reproduces the
// real layout — a finalized run in one session (so the slug resolves to a project) and a
// SEPARATE running run (a journal + persisted script, NO finalized json) in another.

const HOME = '/home/.claude';
const SLUG = '-Users-nicolas-devel-modal-rust';
const ROOT = '/Users/nicolas/devel/modal-rust';
const SESS_DONE = 'sess-done';
const SESS_LIVE = 'sess-live';
const RUN_LIVE = 'wf_live01';
const NOW = 10_000_000;

// A finalized run (shape-(1) scriptPath → recovers ROOT), so discoverProjects resolves SLUG.
const WF_DONE = JSON.stringify({
  workflowName: 'modal-rust-plan-research',
  status: 'completed',
  agentCount: 3,
  startTime: 1,
  scriptPath: `${ROOT}/.claude/workflows/plan-research.js`,
});

// The running run: a 2-phase persisted script + a journal with agent #1 done, #2 running.
const LIVE_SCRIPT = `export const meta = { name: 'live-test', description: 'd', phases: [{ title: 'P1' }, { title: 'P2' }] }
phase('P1')
const a = await agent('do alpha', { label: 'work:alpha', phase: 'P1' })
phase('P2')
const b = await agent('do beta', { label: 'work:beta', phase: 'P2' })
return { a, b }`;
const LIVE_JOURNAL =
  '{"type":"started","key":"k1","agentId":"aid1"}\n' +
  '{"type":"result","key":"k1","agentId":"aid1","result":"alpha is done"}\n' +
  '{"type":"started","key":"k2","agentId":"aid2"}\n';
const LIVE_SCRIPT_NAME = `live-test-${RUN_LIVE}.js`;

// A per-agent transcript for aid1, shaped like a real `agent-<id>.jsonl`: a user prompt,
// an assistant turn carrying usage + a tool_use, and one TORN line (must be skipped).
const AGENT_TRANSCRIPT =
  JSON.stringify({
    type: 'user',
    timestamp: '2026-06-05T21:58:01.000Z',
    message: { role: 'user', content: 'do alpha' },
  }) +
  '\n' +
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-06-05T21:58:10.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', name: 'Read' }, { type: 'text', text: 'alpha is done' }],
      usage: { input_tokens: 1000, output_tokens: 4, cache_read_input_tokens: 500 },
    },
  }) +
  '\n{ this is a TORN malformed line\n';

function makePort(): FileSystemPort {
  const files = new Map<string, { content: string; mtimeMs: number }>([
    [`${HOME}/projects/${SLUG}/${SESS_DONE}/workflows/wf_done.json`, { content: WF_DONE, mtimeMs: 1 }],
    [
      `${HOME}/projects/${SLUG}/${SESS_LIVE}/subagents/workflows/${RUN_LIVE}/journal.jsonl`,
      { content: LIVE_JOURNAL, mtimeMs: NOW - 2000 },
    ],
    [
      `${HOME}/projects/${SLUG}/${SESS_LIVE}/workflows/scripts/${LIVE_SCRIPT_NAME}`,
      { content: LIVE_SCRIPT, mtimeMs: NOW - 3000 },
    ],
    [
      `${HOME}/projects/${SLUG}/${SESS_LIVE}/subagents/workflows/${RUN_LIVE}/agent-aid1.jsonl`,
      { content: AGENT_TRANSCRIPT, mtimeMs: NOW - 2500 },
    ],
    [`${ROOT}/.claude/workflows/plan-research.js`, { content: LIVE_SCRIPT, mtimeMs: 1 }],
  ]);
  return {
    async readFile(p) {
      const v = files.get(p);
      if (!v) throw new Error(`ENOENT ${p}`);
      return v.content;
    },
    async readJson(p) {
      const v = files.get(p);
      if (!v) throw new Error(`ENOENT ${p}`);
      return JSON.parse(v.content) as unknown;
    },
    async listDir(p) {
      const prefix = p.replace(/\/+$/, '') + '/';
      const direct = new Map<string, boolean>();
      for (const k of files.keys()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) direct.set(rest, false);
        else direct.set(rest.slice(0, slash), true);
      }
      if (direct.size === 0) throw new Error(`ENOENT ${p}`);
      return [...direct.entries()].map(([name, isDir]) => ({ name, isDir }));
    },
    async stat(p) {
      const v = files.get(p);
      return v ? { size: v.content.length, mtimeMs: v.mtimeMs } : null;
    },
    async exists(p) {
      return files.has(p);
    },
    watch() {
      return () => {};
    },
  };
}

const deps = (): RouteDeps => ({ port: makePort(), claudeHome: HOME, now: () => NOW });

describe('safeRunJournalPath', () => {
  it('builds the journal path inside the home; rejects traversal', () => {
    expect(safeRunJournalPath(HOME, SLUG, SESS_LIVE, RUN_LIVE)).toBe(
      `${HOME}/projects/${SLUG}/${SESS_LIVE}/subagents/workflows/${RUN_LIVE}/journal.jsonl`,
    );
    expect(safeRunJournalPath(HOME, '..', SESS_LIVE, RUN_LIVE)).toBeNull();
    expect(safeRunJournalPath(HOME, SLUG, SESS_LIVE, 'not_a_runid')).toBeNull();
  });
});

describe('handleRunLive (L2 live snapshot)', () => {
  it('builds a partial live RunModel; labels/phases recovered from the persisted script', async () => {
    const res = await handleRunLive(deps(), SLUG, SESS_LIVE, RUN_LIVE);
    expect(res.status).toBe(200);
    const m = res.body as RunModel;
    expect(m.status).toBe('running');
    expect(m.incomplete).toBe(true);
    expect(m.agents).toHaveLength(2);
    // start-order binding: 1st journal agent → P1 'work:alpha' (done), 2nd → P2 'work:beta' (running).
    const a1 = m.agents.find((a) => a.agentId === 'aid1')!;
    const a2 = m.agents.find((a) => a.agentId === 'aid2')!;
    expect(a1.label).toBe('work:alpha');
    expect(a1.state).toBe('done');
    expect(a1.resultPreview?.text).toBe('alpha is done');
    expect(a2.label).toBe('work:beta');
    expect(a2.state).toBe('running');
    expect(m.phases.map((p) => p.title)).toEqual(['P1', 'P2']);
  });

  it('bad segment → 400; missing journal → 404', async () => {
    expect((await handleRunLive(deps(), SLUG, SESS_LIVE, 'bad id')).status).toBe(400);
    expect((await handleRunLive(deps(), SLUG, SESS_LIVE, 'wf_absent')).status).toBe(404);
  });
});

describe('handleAgentResult (R1 lazy full result)', () => {
  it('returns the full result value for an agent; 400 bad agentId; 404 missing journal', async () => {
    const ok = await handleAgentResult(deps(), SLUG, SESS_LIVE, RUN_LIVE, 'aid1');
    expect(ok.status).toBe(200);
    expect((ok.body as { value: unknown }).value).toBe('alpha is done');
    expect((await handleAgentResult(deps(), SLUG, SESS_LIVE, RUN_LIVE, 'bad id')).status).toBe(400);
    expect((await handleAgentResult(deps(), SLUG, SESS_LIVE, 'wf_absent', 'aid1')).status).toBe(404);
    // an agent with no result event → 200 with value null.
    const none = await handleAgentResult(deps(), SLUG, SESS_LIVE, RUN_LIVE, 'aid2');
    expect(none.status).toBe(200);
    expect((none.body as { value: unknown }).value).toBeNull();
  });
});

describe('handleAgentActivity (per-agent drill-in)', () => {
  it('returns the parsed activity for an agent; 400 bad agentId; 404 missing transcript', async () => {
    const ok = await handleAgentActivity(deps(), SLUG, SESS_LIVE, RUN_LIVE, 'aid1');
    expect(ok.status).toBe(200);
    const { activity } = ok.body as { activity: AgentActivity };
    expect(activity.agentId).toBe('aid1');
    expect(activity.label).toBe('do alpha');
    // the torn line is skipped; the one real tool_use is still counted.
    expect(activity.toolCalls).toBe(1);
    expect(activity.tools).toEqual([{ name: 'Read', count: 1 }]);
    expect(activity.tokens).toEqual({ input: 1000, output: 4, cacheRead: 500 });
    expect(activity.lastText).toBe('alpha is done');

    // 400 on a bad agentId (charset guard), BEFORE any FS access.
    expect((await handleAgentActivity(deps(), SLUG, SESS_LIVE, RUN_LIVE, 'bad id')).status).toBe(400);
    // 404 when the run dir / transcript is absent (cleaned/old run → degrade gracefully).
    expect((await handleAgentActivity(deps(), SLUG, SESS_LIVE, RUN_LIVE, 'aid2')).status).toBe(404);
    expect((await handleAgentActivity(deps(), SLUG, SESS_LIVE, 'wf_absent', 'aid1')).status).toBe(404);
  });
});

describe('handleDescribe (I4 whole-run summary)', () => {
  it('feeds a run digest to the sub-UI engine and returns its PanelSpec', async () => {
    let prompt = '';
    const subui = new SubUiEngine({
      cacheDir: '/x',
      runner: async (p: string) => {
        prompt = p;
        return '{"title":"Run digest","sections":[{"kind":"callout","tone":"success","text":"ok"}]}';
      },
    });
    const res = await handleDescribe({ port: makePort(), claudeHome: HOME, subui }, SLUG, SESS_DONE, 'wf_done');
    expect(res.status).toBe(200);
    const body = res.body as { status: string; spec: { title: string } | null };
    expect(body.status).toBe('ready');
    expect(body.spec?.title).toBe('Run digest');
    // the digest the engine saw is the WHOLE run (workflow name + status), not one agent.
    expect(prompt).toContain('modal-rust-plan-research');
    expect(prompt).toContain('completed');
  });
  it('no engine → unavailable; unreadable run → 404', async () => {
    expect((await handleDescribe(deps(), SLUG, SESS_DONE, 'wf_done')).status).toBe(200); // deps() has no subui
    expect(((await handleDescribe(deps(), SLUG, SESS_DONE, 'wf_done')).body as { status: string }).status).toBe(
      'unavailable',
    );
    const subui = new SubUiEngine({ cacheDir: '/x', runner: async () => null });
    expect((await handleDescribe({ port: makePort(), claudeHome: HOME, subui }, SLUG, SESS_DONE, 'wf_absent')).status).toBe(404);
  });
});

describe('handleStream (L3 SSE) — arch-review #5', () => {
  function fakeRes() {
    const writes: string[] = [];
    const handlers: Record<string, () => void> = {};
    let status = 0;
    let headers: Record<string, string> = {};
    const res: SseResponse & { _writes: string[]; _status: () => number; _headers: () => Record<string, string>; _fire: (e: string) => void } = {
      writeHead(s, h) { status = s; headers = h; },
      write(c) { writes.push(c); },
      end(c) { if (c) writes.push(c); },
      on(e, cb) { handlers[e] = cb; },
      _writes: writes,
      _status: () => status,
      _headers: () => headers,
      _fire: (e) => handlers[e]?.(),
    };
    return res;
  }

  it('rejects a bad runId with 400 (no stream opened)', () => {
    const res = fakeRes();
    handleStream(deps(), res, SLUG, SESS_LIVE, 'bad id');
    expect(res._status()).toBe(400);
    expect(res._writes.join('')).not.toContain('event: open');
  });

  it('opens an SSE stream, pushes `changed` on a journal change, and tears down on close', async () => {
    let watchCb: (() => void) | null = null;
    let unwatched = false;
    const base = makePort();
    const port = {
      ...base,
      watch: (p: string, cb: (e: { path: string; type: string }) => void) => {
        watchCb = () => cb({ path: p, type: 'change' });
        return () => { unwatched = true; };
      },
    };
    const res = fakeRes();
    handleStream({ port, claudeHome: HOME }, res, SLUG, SESS_LIVE, RUN_LIVE);
    expect(res._status()).toBe(200);
    expect(res._headers()['content-type']).toContain('text/event-stream');
    expect(res._writes.join('')).toContain('event: open');
    expect(watchCb).not.toBeNull();
    // a journal change → a debounced `changed` event.
    watchCb!();
    await new Promise((r) => setTimeout(r, 200));
    expect(res._writes.join('')).toContain('event: changed');
    // disconnect → the watch is torn down (no leaked watcher).
    res._fire('close');
    expect(unwatched).toBe(true);
  });
});

describe('handleProjectRuns merges running runs (L1)', () => {
  it('surfaces the in-progress run alongside the finalized one', async () => {
    const res = await handleProjectRuns(deps(), SLUG);
    expect(res.status).toBe(200);
    const runs = res.body as RunSummary[];
    const live = runs.find((r) => r.ref.runId === RUN_LIVE);
    const done = runs.find((r) => r.ref.runId === 'wf_done');
    expect(done?.status).toBe('completed');
    expect(live?.status).toBe('running');
    expect(live?.startTime).toBe(NOW - 2000); // journal mtime = best-effort "last active".
  });
});
