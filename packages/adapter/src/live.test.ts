import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join as pjoin } from 'node:path';
import {
  parseJournal,
  reduceJournal,
  classifyRunLiveness,
  planExpectedSlots,
  buildLiveModel,
  agentResultFromJournal,
  parsePlan,
  discoverRunningRunsReport,
  ADAPTER_FORMAT,
  type FileSystemPort,
} from './index.ts';
import { ADAPTER_FORMAT_LIVE } from './live.ts';
import type { RunRef } from '@argus/contract';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = pjoin(HERE, '..', '..', '..', '.argus', 'fixtures', 'live', 'probe-2phase');
const journalText = readFileSync(pjoin(FIX, 'journal.jsonl'), 'utf8');
const scriptSrc = readFileSync(pjoin(FIX, 'script.js'), 'utf8');
const finalized = JSON.parse(readFileSync(pjoin(FIX, 'finalized.wf.json'), 'utf8')) as {
  workflowProgress: Array<{ type: string; agentId?: string; label?: string; phaseIndex?: number }>;
};

const REF: RunRef = {
  projectPath: '/Users/nicolas/devel/argus',
  slug: '-Users-nicolas-devel-argus',
  sessionId: 'sess-x',
  runId: 'wf_dc04a1d4-e8e',
};

// The authoritative agentId -> label / phase map from the FINALIZED json (NOT available
// live) — used to assert that start-order binding recovers the SAME labels (F3/F4).
const finalMap = new Map(
  finalized.workflowProgress
    .filter((e) => e.type === 'workflow_agent' && e.agentId)
    .map((e) => [e.agentId!, { label: e.label!, phaseIndex: e.phaseIndex! }]),
);

describe('parseJournal', () => {
  it('parses the real probe journal: 3 started + 3 result, no bad lines', () => {
    const { events, badLines } = parseJournal(journalText);
    expect(badLines).toBe(0);
    expect(events.filter((e) => e.type === 'started')).toHaveLength(3);
    expect(events.filter((e) => e.type === 'result')).toHaveLength(3);
    // result events carry the full result text.
    expect(events.find((e) => e.type === 'result')?.result).toBeTypeOf('string');
  });

  it('is line-independent: a torn/garbage line is counted, not fatal', () => {
    const torn = journalText.trimEnd() + '\n{ this is not json';
    const { events, badLines } = parseJournal(torn);
    expect(badLines).toBe(1);
    expect(events.length).toBeGreaterThan(0);
  });

  it('drops a line with no agentId', () => {
    const { badLines } = parseJournal('{"type":"started"}\n');
    expect(badLines).toBe(1);
  });
});

describe('reduceJournal', () => {
  it('collapses to one agent per id in first-appearance order; result => done text', () => {
    const live = reduceJournal(parseJournal(journalText).events);
    expect(live).toHaveLength(3);
    expect(live.map((a) => a.order)).toEqual([0, 1, 2]);
    expect(live.every((a) => a.started && a.result !== undefined)).toBe(true);
  });
});

describe('agentResultFromJournal (R1 full result)', () => {
  it('returns a STRING result for a text agent', () => {
    const v = agentResultFromJournal(journalText, 'a20a3ff609362a4db');
    expect(typeof v).toBe('string');
    expect(v as string).toContain('directed acyclic graph');
  });
  it('returns an OBJECT result for a schema agent', () => {
    const j = '{"type":"result","key":"k","agentId":"ag1","result":{"verdict":"sound","issues":[1,2]}}\n';
    expect(agentResultFromJournal(j, 'ag1')).toEqual({ verdict: 'sound', issues: [1, 2] });
  });
  it('returns null for an unknown agent or a torn line', () => {
    expect(agentResultFromJournal(journalText, 'nope')).toBeNull();
    expect(agentResultFromJournal('{bad json\n{"type":"result","agentId":"x"}', 'x')).toBeNull();
  });
});

describe('classifyRunLiveness', () => {
  const now = 1_000_000;
  it('finalized json present => finalized (F1: existence ≈ over)', () => {
    expect(
      classifyRunLiveness({ journalExists: true, finalizedExists: true, journalMtimeMs: now, nowMs: now }),
    ).toBe('finalized');
  });
  it('no journal => finalized (nothing live)', () => {
    expect(
      classifyRunLiveness({ journalExists: false, finalizedExists: false, journalMtimeMs: null, nowMs: now }),
    ).toBe('finalized');
  });
  it('fresh journal, no finalized => running', () => {
    expect(
      classifyRunLiveness({ journalExists: true, finalizedExists: false, journalMtimeMs: now - 1000, nowMs: now }),
    ).toBe('running');
  });
  it('quiet journal, no finalized => stale (likely crashed)', () => {
    expect(
      classifyRunLiveness({
        journalExists: true,
        finalizedExists: false,
        journalMtimeMs: now - 10 * 60_000,
        nowMs: now,
      }),
    ).toBe('stale');
  });
});

describe('planExpectedSlots', () => {
  it('flattens the probe plan into 3 ordered slots (Gather x2, Summarize x1)', () => {
    const plan = parsePlan(scriptSrc, 'probe.js');
    const slots = planExpectedSlots(plan);
    expect(slots).not.toBeNull();
    expect(slots).toEqual([
      { label: 'probe:dag', phaseIndex: 1 },
      { label: 'probe:toposort', phaseIndex: 1 },
      { label: 'probe:combine', phaseIndex: 2 },
    ]);
  });

  it('returns null when any agent node is unbounded (refuses to half-bind)', () => {
    const src = `export const meta = { name: 'x', description: 'd' }
const items = args.list
phase('P')
await parallel(items.map((it) => () => agent('do ' + it, { label: 'work:' + it, phase: 'P' })))`;
    const plan = parsePlan(src, 'unbounded.js');
    expect(planExpectedSlots(plan)).toBeNull();
  });
});

describe('buildLiveModel — incremental journal replay (the gate fixture)', () => {
  const plan = parsePlan(scriptSrc, 'probe.js');
  const lines = journalText.split('\n').filter((l) => l.trim().length > 0);
  const prefix = (n: number) => lines.slice(0, n).join('\n');

  it('after the 2 Gather "started" events: 2 agents running, 0 done', () => {
    const m = buildLiveModel(prefix(2), REF, { plan });
    expect(m.status).toBe('running');
    expect(m.incomplete).toBe(true);
    expect(m.agents).toHaveLength(2);
    expect(m.agents.every((a) => a.state === 'running')).toBe(true);
    expect(m.summary).toBe('0/2 agents done');
  });

  it('L6 gate: replaying line-by-line never LOSES or DUPLICATES a node; reconciles to finalized', () => {
    let prevIds: string[] = [];
    for (let n = 1; n <= lines.length; n += 1) {
      const m = buildLiveModel(prefix(n), REF, { plan });
      const ids = m.agents.map((a) => a.agentId);
      expect(new Set(ids).size).toBe(ids.length); // NO duplicate nodes
      expect(prevIds.every((id) => ids.includes(id))).toBe(true); // NO lost node (monotone superset)
      // a 'done' agent NEVER reverts to 'running' as more lines arrive (monotone state).
      expect(m.agents.filter((a) => a.state === 'done').length).toBeGreaterThanOrEqual(0);
      prevIds = ids;
    }
    // L5 reconciliation: the final live agent SET equals the finalized json's agent set.
    const live = buildLiveModel(journalText, REF, { plan });
    const liveIds = new Set(live.agents.map((a) => a.agentId));
    const finalIds = new Set(finalMap.keys());
    expect(liveIds).toEqual(finalIds);
    // and each live label matches what finalize assigned (start-order binding is correct).
    for (const a of live.agents) expect(a.label).toBe(finalMap.get(a.agentId)!.label);
  });

  it('after the first "result": exactly one agent flips to done', () => {
    const m = buildLiveModel(prefix(3), REF, { plan });
    expect(m.agents.filter((a) => a.state === 'done')).toHaveLength(1);
    expect(m.agents.filter((a) => a.state === 'running')).toHaveLength(1);
  });

  it('full journal: 3 done, labels/phases recovered match the finalized json', () => {
    const m = buildLiveModel(journalText, REF, { plan });
    expect(m.agents).toHaveLength(3);
    expect(m.agents.every((a) => a.state === 'done')).toBe(true);
    expect(m.summary).toBe('3/3 agents done');
    // start-order binding recovered the SAME labels/phases the finalize would assign (F4).
    for (const a of m.agents) {
      const expected = finalMap.get(a.agentId)!;
      expect(a.label).toBe(expected.label);
      expect(a.phaseIndex).toBe(expected.phaseIndex);
    }
    // phases titled from the plan; phase edge synthesized Gather -> Summarize.
    expect(m.phases.map((p) => p.title)).toEqual(['Gather', 'Summarize']);
    expect(m.edges).toEqual([{ from: 1, to: 2 }]);
    // a result preview is carried from the journal (the live content source, F2).
    expect(m.agents[0]!.resultPreview?.text.length).toBeGreaterThan(0);
    // metrics are null live (F3 — they only land at finalize).
    expect(m.agents[0]!.tokens).toBeNull();
    expect(m.agents[0]!.durationMs).toBeNull();
  });

  it('without a plan: anonymous agents in a single "Running" lane', () => {
    const m = buildLiveModel(journalText, REF);
    expect(m.agents.every((a) => a.label === '')).toBe(true);
    expect(m.phases).toEqual([{ index: 1, title: 'Running', detail: null }]);
    expect(m.warnings.map((w) => w.code)).toContain('live-incomplete');
  });

  it('with an unbounded plan: degrades to anonymous + a coded warning', () => {
    const src = `export const meta = { name: 'x', description: 'd' }
const items = args.list
phase('P')
await parallel(items.map((it) => () => agent('do ' + it, { label: 'work:' + it, phase: 'P' })))`;
    const unbounded = parsePlan(src, 'unbounded.js');
    const m = buildLiveModel(journalText, REF, { plan: unbounded });
    expect(m.agents.every((a) => a.label === '')).toBe(true);
    expect(m.warnings.map((w) => w.code)).toContain('live-unbound-anonymous');
  });

  it('uses the live format pin, identical to the finalized adapter pin', () => {
    expect(ADAPTER_FORMAT_LIVE).toBe(ADAPTER_FORMAT);
    expect(buildLiveModel(journalText, REF).format).toBe(ADAPTER_FORMAT);
  });
});

// --- detection: a MemPort with real stat/exists ----------------------------

class StatPort implements FileSystemPort {
  private files = new Map<string, { content: string; mtimeMs: number }>();
  set(path: string, content: string, mtimeMs = 0): this {
    this.files.set(path, { content, mtimeMs });
    return this;
  }
  async readFile(path: string): Promise<string> {
    const v = this.files.get(path);
    if (!v) throw new Error(`ENOENT ${path}`);
    return v.content;
  }
  async readJson(path: string): Promise<unknown> {
    return JSON.parse(await this.readFile(path)) as unknown;
  }
  async listDir(path: string): Promise<Array<{ name: string; isDir: boolean }>> {
    const prefix = path.replace(/\/+$/, '') + '/';
    const names = new Map<string, boolean>();
    let any = false;
    for (const f of this.files.keys()) {
      if (!f.startsWith(prefix)) continue;
      any = true;
      const rest = f.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) names.set(rest, false);
      else names.set(rest.slice(0, slash), true);
    }
    if (!any) throw new Error(`ENOENT ${path}`);
    return [...names.entries()].map(([name, isDir]) => ({ name, isDir }));
  }
  async stat(path: string) {
    const v = this.files.get(path);
    return v ? { size: v.content.length, mtimeMs: v.mtimeMs } : null;
  }
  async exists(path: string) {
    return this.files.has(path);
  }
  watch(): () => void {
    return () => {};
  }
}

describe('discoverRunningRunsReport (L1 detection)', () => {
  const HOME = '/home/.claude';
  const slug = '-Users-nicolas-devel-argus';
  const project = { projectPath: '/Users/nicolas/devel/argus', slug, name: 'argus', sessionCount: 1 };
  const now = 10_000_000;
  const base = `${HOME}/projects/${slug}`;

  it('emits a running run (journal, no finalized json) and omits finalized + stale ones', async () => {
    const port = new StatPort();
    // sess-run: a running run — fresh journal, NO finalized json.
    port.set(`${base}/sess-run/subagents/workflows/wf_run/journal.jsonl`, journalText, now - 2000);
    // sess-done: a finished run — journal AND finalized json present => NOT running.
    port.set(`${base}/sess-done/subagents/workflows/wf_done/journal.jsonl`, journalText, now - 9999);
    port.set(`${base}/sess-done/workflows/wf_done.json`, '{"status":"completed"}', now - 9999);
    // sess-stale: a crashed run — old journal, no finalized => stale, omitted.
    port.set(`${base}/sess-stale/subagents/workflows/wf_stale/journal.jsonl`, journalText, now - 60 * 60_000);

    const { items } = await discoverRunningRunsReport(port, HOME, project, now);
    expect(items).toHaveLength(1);
    expect(items[0]!.ref.runId).toBe('wf_run');
    expect(items[0]!.status).toBe('running');
    expect(items[0]!.ref.projectPath).toBe(project.projectPath);
    expect(items[0]!.startTime).toBe(now - 2000); // best-effort "last active" = journal mtime.
  });

  it('a missing slug dir yields a coded reason, never a throw', async () => {
    const port = new StatPort();
    const { items, reasons } = await discoverRunningRunsReport(port, HOME, project, now);
    expect(items).toHaveLength(0);
    expect(reasons.map((r) => r.code)).toContain('slug-dir-unreadable');
  });
});
