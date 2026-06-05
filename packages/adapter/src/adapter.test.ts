import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ADAPTER_FORMAT,
  deriveSlug,
  recoverProjectPath,
  parseFinalizedRun,
  perRunScriptBasename,
  loadRunPlan,
  PREVIEW_TRUNCATED_RAW_LEN,
  PREVIEW_EMIT_CAP,
  type AdapterContext,
  type FileSystemPort,
} from './index.ts';
import type { RunModel, RunRef } from '@argus/contract';

// --- fixture loading (read each .argus/fixtures/finished/*.wf.json) ---

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, '..', '..', '..', '.argus', 'fixtures', 'finished');

const FIXTURES = [
  'completed-14agents',
  'completed-3agents',
  'failed-1agent',
  'killed-9agents',
  'completed-resumed-13agents',
] as const;

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.wf.json`), 'utf8')) as unknown;
}

const REF: RunRef = {
  projectPath: '/Users/nicolas/devel/modal-rust',
  slug: '-Users-nicolas-devel-modal-rust',
  sessionId: 'session-x',
  runId: 'wf_test',
};
const CTX: AdapterContext = { ref: REF };

function parse(name: string): RunModel {
  return parseFinalizedRun(loadFixture(name), CTX);
}

// =========================================================================
// existing M0 surface
// =========================================================================

describe('adapter format pin', () => {
  it('is the observed-format constant', () => {
    expect(ADAPTER_FORMAT).toBe('cc-workflow/observed-2026-06-04');
  });
});

describe('deriveSlug', () => {
  it('replaces every non-alphanumeric char with "-" (verified rule)', () => {
    expect(deriveSlug('/Users/nicolas/devel/modal-rust')).toBe('-Users-nicolas-devel-modal-rust');
    expect(deriveSlug('/Users/nicolas/.config/ghostty')).toBe('-Users-nicolas--config-ghostty');
  });
});

describe('recoverProjectPath', () => {
  it('strips the trailing .claude/workflows/<file> to the project root', () => {
    expect(
      recoverProjectPath('/Users/nicolas/devel/modal-rust/.claude/workflows/plan-research.js'),
    ).toBe('/Users/nicolas/devel/modal-rust');
  });
  it('returns null when the script is not under .claude/workflows', () => {
    expect(recoverProjectPath('/tmp/whatever.js')).toBeNull();
  });
});

// =========================================================================
// parametrized: all 5 real fixtures normalize without throwing
// =========================================================================

describe('parseFinalizedRun over ALL 5 real fixtures', () => {
  it.each(FIXTURES)('%s normalizes to a valid RunModel (no throw, allowlisted)', (name) => {
    const m = parse(name);

    expect(m.format).toBe(ADAPTER_FORMAT);
    expect(m.incomplete).toBe(false);
    expect(['completed', 'failed', 'killed', 'running']).toContain(m.status);
    expect(m.ref).toBe(REF);
    expect(Array.isArray(m.phases)).toBe(true);
    expect(Array.isArray(m.agents)).toBe(true);
    expect(Array.isArray(m.edges)).toBe(true);
    expect(Array.isArray(m.logs)).toBe(true);
    expect(Array.isArray(m.warnings)).toBe(true);
    expect(typeof m.partialFailure.present).toBe('boolean');

    // edges are ONLY the synthesized phase_i -> phase_i+1 spine (no agent edges).
    for (const e of m.edges) {
      const fromPos = m.phases.findIndex((p) => p.index === e.from);
      expect(fromPos).toBeGreaterThanOrEqual(0);
      expect(m.phases[fromPos + 1]?.index).toBe(e.to);
    }

    // every agent's phaseIndex resolves to a real phase (else it'd be dropped).
    const phaseIndexes = new Set(m.phases.map((p) => p.index));
    for (const a of m.agents) {
      expect(phaseIndexes.has(a.phaseIndex)).toBe(true);
    }

    // EMIT-ALLOWLIST: no raw-format-only field leaked into the model.
    const keys = Object.keys(m);
    expect(keys).not.toContain('script');
    expect(keys).not.toContain('scriptPath');
    expect(keys).not.toContain('result');
    expect(keys).not.toContain('workflowProgress');
    expect(keys).not.toContain('timestamp');

    // $bunfs (Claude's internal cli.js bundle path) must not appear in any field
    // rendered by default. It is allowed ONLY in the collapsed error.internalDetail
    // (boundaries §2.3 keeps the stack there, never rendered raw), so strip that
    // before the leak check. /Users/ paths are the user's OWN content (in previews,
    // logs, args) shown back to them locally and are intentionally preserved verbatim.
    const visible = { ...m, error: m.error ? { message: m.error.message } : null };
    expect(JSON.stringify(visible)).not.toContain('$bunfs');
  });
});

// =========================================================================
// 14-agent: run-level partialFailure from a HIDDEN log line, zero mis-attribution
// =========================================================================

describe('completed-14agents: hidden parallel[0] failed', () => {
  const m = parse('completed-14agents');

  it('is status=completed yet raises run-level partialFailure with the verbatim line', () => {
    expect(m.status).toBe('completed');
    expect(m.partialFailure.present).toBe(true);
    expect(m.partialFailure.lines).toContain(
      'parallel[0] failed: agent({schema}): subagent completed without calling StructuredOutput (after 2 in-conversation nudges)',
    );
  });

  it('mis-attributes ZERO agents (every agent.failedInLogs === false)', () => {
    expect(m.agents.length).toBe(14);
    for (const a of m.agents) {
      expect(a.failedInLogs).toBe(false);
    }
  });

  it('completed run has error === null', () => {
    expect(m.error).toBeNull();
  });
});

// =========================================================================
// killed-9: progress -> interrupted (static), error + parallel failed logs surfaced
// =========================================================================

describe('killed-9agents: interrupted agents + surfaced abort/failures', () => {
  const m = parse('killed-9agents');

  it('maps state:progress agents to interrupted (static, not a live pulse)', () => {
    expect(m.status).toBe('killed');
    const interrupted = m.agents.filter((a) => a.state === 'interrupted');
    expect(interrupted.length).toBe(2);
    // none are left as a live 'running' pulse.
    expect(m.agents.some((a) => a.state === 'running')).toBe(false);
  });

  it("surfaces the 'Workflow aborted' error with the bunfs stack hidden in internalDetail", () => {
    expect(m.error).not.toBeNull();
    expect(m.error?.message).toBe('Error: Workflow aborted');
    expect(m.error?.message).not.toContain('$bunfs');
    expect(m.error?.internalDetail ?? '').toContain('$bunfs');
  });

  it("surfaces the 'parallel[N] failed' log lines via partialFailure", () => {
    expect(m.partialFailure.present).toBe(true);
    expect(m.partialFailure.lines.some((l) => /parallel\[0\] failed/.test(l))).toBe(true);
    expect(m.partialFailure.lines.some((l) => /parallel\[2\] failed/.test(l))).toBe(true);
  });

  it('does NOT mis-attribute the empty parallel[N] failed lines to any agent', () => {
    for (const a of m.agents) expect(a.failedInLogs).toBe(false);
  });
});

// =========================================================================
// error sanitization: bunfs stack hidden; message clean; no raw path leak anywhere
// =========================================================================

describe('error sanitization (failed-1agent + killed-9agents)', () => {
  it('failed-1agent: message clean, bunfs stack in internalDetail, no raw leak in emitted fields', () => {
    const m = parse('failed-1agent');
    expect(m.status).toBe('failed');
    expect(m.error).not.toBeNull();
    expect(m.error?.message).toMatch(/subagent completed without calling StructuredOutput/);
    expect(m.error?.message).not.toContain('$bunfs');
    expect(m.error?.message).not.toContain('/$bunfs/');
    expect(m.error?.internalDetail).toContain('/$bunfs/root/src/entrypoints/cli.js');

    // $bunfs must not leak into ANY default-rendered field (message/summary/warnings/
    // previews/labels). It is allowed ONLY in the collapsed error.internalDetail.
    const renderedTexts = [
      m.error?.message ?? '',
      m.summary,
      ...m.warnings.map((w) => `${w.code} ${w.detail ?? ''}`),
      ...m.agents.flatMap((a) => [
        a.promptPreview?.text ?? '',
        a.resultPreview?.text ?? '',
        a.label,
      ]),
    ];
    for (const t of renderedTexts) expect(t).not.toContain('$bunfs');
    // Diagnostic fields (the error message + warning codes) carry no absolute home
    // path. Previews/labels/logs are the user's OWN content, shown verbatim (capped),
    // so they legitimately contain /Users/ paths and are NOT scrubbed.
    for (const t of [m.error?.message ?? '', ...m.warnings.map((w) => w.detail ?? '')]) {
      expect(t).not.toContain('/Users/');
    }
  });
});

// =========================================================================
// preview heuristic: len===401 => truncated; len===0 => NOT truncated; full result not inlined
// =========================================================================

describe('preview truncation heuristic + lazy full result', () => {
  it('real fixture previews of raw length 401 are truncated:true', () => {
    const m = parse('completed-3agents');
    const previews = m.agents.flatMap((a) => [a.promptPreview, a.resultPreview]).filter(Boolean);
    expect(previews.length).toBeGreaterThan(0);
    // every one of these fixtures' previews is exactly 401 chars => truncated.
    for (const p of previews) expect(p!.truncated).toBe(true);
  });

  it('synthetic: raw len === 401 => truncated; len === 0 => NOT truncated', () => {
    const make = (raw: string): RunModel =>
      parseFinalizedRun(
        {
          status: 'completed',
          workflowProgress: [
            { type: 'workflow_phase', index: 1, title: 'P1' },
            {
              type: 'workflow_agent',
              agentId: 'a1',
              index: 1,
              label: 'x',
              phaseIndex: 1,
              state: 'done',
              resultPreview: raw,
            },
          ],
        },
        CTX,
      );

    const len401 = make('z'.repeat(PREVIEW_TRUNCATED_RAW_LEN));
    expect(len401.agents[0]!.resultPreview!.truncated).toBe(true);

    const len0 = make('');
    expect(len0.agents[0]!.resultPreview).not.toBeNull();
    expect(len0.agents[0]!.resultPreview!.truncated).toBe(false);
    expect(len0.agents[0]!.resultPreview!.text).toBe('');

    // length 400 (one less) is NOT truncated.
    const len400 = make('z'.repeat(400));
    expect(len400.agents[0]!.resultPreview!.truncated).toBe(false);
  });

  it('the full result is never inlined into RunModel (only capped previews exist)', () => {
    const hugeResult = 'SECRET'.repeat(100000); // ~600 KB
    const m = parseFinalizedRun(
      {
        status: 'completed',
        result: hugeResult,
        workflowProgress: [{ type: 'workflow_phase', index: 1, title: 'P1' }],
      },
      CTX,
    );
    const serialized = JSON.stringify(m);
    expect(serialized).not.toContain('SECRET');
    expect(Object.keys(m)).not.toContain('result');
  });

  it('emitted preview text is hard-capped (full text not inlined)', () => {
    const huge = 'q'.repeat(PREVIEW_EMIT_CAP * 4);
    const m = parseFinalizedRun(
      {
        status: 'completed',
        workflowProgress: [
          { type: 'workflow_phase', index: 1, title: 'P1' },
          {
            type: 'workflow_agent',
            agentId: 'a1',
            index: 1,
            label: 'x',
            phaseIndex: 1,
            state: 'done',
            resultPreview: huge,
          },
        ],
      },
      CTX,
    );
    expect(m.agents[0]!.resultPreview!.text.length).toBeLessThanOrEqual(PREVIEW_EMIT_CAP);
  });
});

// =========================================================================
// phase join: unresolvable phaseIndex dropped-with-warning; edges-only-spine
// =========================================================================

describe('phase join + edges', () => {
  it('killed-9 resolves 7 phase nodes; agents reference existing phases only', () => {
    const m = parse('killed-9agents');
    // 7 workflow_phase nodes (index 1..7); phases[] has only 4 detail entries.
    expect(m.phases.map((p) => p.index)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // detail enrichment: phases 1..4 get detail; 5..7 are null (out of phases[] range).
    expect(m.phases[0]!.detail).not.toBeNull();
    expect(m.phases[6]!.detail).toBeNull();
    // length mismatch is a counted warning, not a crash.
    expect(m.warnings.some((w) => w.code === 'phase-detail-length-mismatch')).toBe(true);
  });

  it('synthetic: an unresolvable phaseIndex node is DROPPED-with-warning (no phase 0, no 0->1 edge)', () => {
    const m = parseFinalizedRun(
      {
        status: 'completed',
        // phases[] present but one workflow_phase node has a garbage index.
        phases: [{ title: 'A', detail: 'a' }, { title: 'B', detail: 'b' }],
        workflowProgress: [
          { type: 'workflow_phase', index: 1, title: 'A' },
          { type: 'workflow_phase', index: 'not-a-number', title: 'BOGUS' }, // unresolvable
          { type: 'workflow_phase', index: 2, title: 'B' },
          // an agent pointing at the dropped/garbage phase is itself dropped.
          { type: 'workflow_agent', agentId: 'g', index: 9, label: 'ghost', phaseIndex: 0, state: 'done' },
          { type: 'workflow_agent', agentId: 'a1', index: 1, label: 'real', phaseIndex: 1, state: 'done' },
        ],
      },
      CTX,
    );

    // phase 0 must NOT exist; only the two real phases (1, 2).
    expect(m.phases.map((p) => p.index)).toEqual([1, 2]);
    expect(m.phases.some((p) => p.index === 0)).toBe(false);

    // edges are ONLY phase_i -> phase_i+1: exactly [{from:1,to:2}]. No 0->1.
    expect(m.edges).toEqual([{ from: 1, to: 2 }]);
    expect(m.edges.some((e) => e.from === 0 || e.to === 0)).toBe(false);

    // the dropped phase node AND the ghost agent are counted in warnings.
    expect(m.warnings.some((w) => w.code === 'phase-node-dropped-unresolvable-index')).toBe(true);
    expect(m.warnings.some((w) => w.code === 'agent-node-dropped-unresolvable-phaseindex')).toBe(true);

    // only the real agent survived.
    expect(m.agents.map((a) => a.label)).toEqual(['real']);
  });

  it('synthesizes edges only as phase_i -> phase_i+1 (a 3-phase run => 2 edges)', () => {
    const m = parse('completed-3agents');
    expect(m.phases.map((p) => p.index)).toEqual([1, 2, 3]);
    expect(m.edges).toEqual([
      { from: 1, to: 2 },
      { from: 2, to: 3 },
    ]);
  });
});

// =========================================================================
// args parsed defensively (JSON-string | null | raw-string fallback)
// =========================================================================

describe('args parsing (defensive)', () => {
  it('killed-9: JSON-string args are parsed into an object', () => {
    const m = parse('killed-9agents');
    expect(m.args).toEqual({ workpad: 'prototype', maxRounds: 3 });
  });

  it('completed-3agents: null args => null', () => {
    const m = parse('completed-3agents');
    expect(m.args).toBeNull();
  });

  it('a non-JSON string falls back to the raw string (never throws)', () => {
    const m = parseFinalizedRun({ status: 'completed', args: 'just a plain string' }, CTX);
    expect(m.args).toBe('just a plain string');
  });
});

// =========================================================================
// unknown-field tolerated; missing-field defaulted
// =========================================================================

describe('defensive parsing: unknown + missing fields', () => {
  it('tolerates UNKNOWN extra fields (passthrough) without emitting them', () => {
    const m = parseFinalizedRun(
      {
        status: 'completed',
        futureSecretField: 'TOPSECRET',
        workflowProgress: [
          { type: 'workflow_phase', index: 1, title: 'P1' },
          {
            type: 'workflow_agent',
            agentId: 'a1',
            index: 1,
            label: 'x',
            phaseIndex: 1,
            state: 'done',
            unknownAgentField: 'ALSO_SECRET',
          },
        ],
      },
      CTX,
    );
    const serialized = JSON.stringify(m);
    expect(serialized).not.toContain('TOPSECRET');
    expect(serialized).not.toContain('ALSO_SECRET');
    expect(serialized).not.toContain('futureSecretField');
    // the run still parsed correctly.
    expect(m.agents.length).toBe(1);
  });

  it('tolerates an unknown node type (drop-with-warning) and unknown agent state (=> unknown)', () => {
    const m = parseFinalizedRun(
      {
        status: 'completed',
        workflowProgress: [
          { type: 'workflow_phase', index: 1, title: 'P1' },
          { type: 'workflow_mystery_node', index: 99 }, // unknown type
          { type: 'workflow_agent', agentId: 'a1', index: 1, label: 'x', phaseIndex: 1, state: 'levitating' },
        ],
      },
      CTX,
    );
    expect(m.warnings.some((w) => w.code === 'unknown-progress-node-type')).toBe(true);
    expect(m.agents[0]!.state).toBe('unknown');
    expect(m.warnings.some((w) => w.code === 'unknown-agent-state')).toBe(true);
  });

  it('defaults MISSING fields without throwing (empty input => empty-but-valid model)', () => {
    const m = parseFinalizedRun({}, CTX);
    expect(m.status).toBe('completed'); // finalized; flagged via warning
    expect(m.warnings.some((w) => w.code === 'unknown-run-status')).toBe(false); // undefined status is tolerated silently
    expect(m.workflowName).toBe('');
    expect(m.summary).toBe('');
    expect(m.phases).toEqual([]);
    expect(m.agents).toEqual([]);
    expect(m.edges).toEqual([]);
    expect(m.logs).toEqual([]);
    expect(m.args).toBeNull();
    expect(m.error).toBeNull();
    expect(m.startTime).toBeNull();
    expect(m.durationMs).toBeNull();
    expect(m.defaultModel).toBeNull();
    expect(m.partialFailure).toEqual({ present: false, lines: [] });
  });

  it('a missing resultPreview => null (not an empty Preview); 0 tokens preserved', () => {
    const m = parse('completed-resumed-13agents');
    // the resumed fixture has one agent with a null resultPreview.
    expect(m.agents.some((a) => a.resultPreview === null)).toBe(true);
    // cached agents are flagged.
    expect(m.agents.some((a) => a.cached === true)).toBe(true);
  });

  it('never throws on totally malformed (non-object) input', () => {
    expect(() => parseFinalizedRun('garbage', CTX)).not.toThrow();
    expect(() => parseFinalizedRun(null, CTX)).not.toThrow();
    expect(() => parseFinalizedRun(42, CTX)).not.toThrow();
    expect(() => parseFinalizedRun([], CTX)).not.toThrow();
    const m = parseFinalizedRun('garbage', CTX);
    expect(m.format).toBe(ADAPTER_FORMAT);
  });
});

// =========================================================================
// port contract test THROUGH a fake in-memory port (the adapter never touches node:fs)
// =========================================================================

describe('loadRun through an injected FileSystemPort (fake)', () => {
  it('reads a real wf_*.json THROUGH the port and produces a valid RunModel', async () => {
    const { loadRun } = await import('./index.ts');
    const raw = readFileSync(join(FIXTURE_DIR, 'completed-3agents.wf.json'), 'utf8');

    const reads: string[] = [];
    const fakePort = {
      readFile: async (p: string) => {
        reads.push(p);
        return raw;
      },
      readJson: async (p: string) => {
        reads.push(p);
        return JSON.parse(raw) as unknown;
      },
      listDir: async () => [],
      stat: async () => null,
      exists: async () => true,
      watch: () => () => {},
    };

    const m = await loadRun(fakePort, '/abs/path/wf_44a38dc4-723.json', CTX);
    expect(reads).toEqual(['/abs/path/wf_44a38dc4-723.json']); // read THROUGH the port
    expect(m.format).toBe(ADAPTER_FORMAT);
    expect(m.status).toBe('completed');
    expect(m.agents.length).toBe(3);
  });
});

// =========================================================================
// the adapter package must NEVER import node:fs (format-isolation invariant)
// =========================================================================

describe('adapter source never imports node:fs', () => {
  it('NO non-test adapter source imports node:fs / node:fs/promises (all format-aware files)', () => {
    // arch-review #4: guard EVERY adapter src file, not just index.ts/raw.ts — live.ts,
    // plan.ts, discovery.ts are equally format-aware + fs-free in fact; lock the invariant.
    const files = readdirSync(HERE).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThanOrEqual(5); // index/raw/live/plan/discovery (+more)
    for (const file of files) {
      const src = readFileSync(join(HERE, file), 'utf8');
      expect(src, `${file} must not import node:fs`).not.toMatch(/from\s+['"]node:fs['"]/);
      expect(src, `${file} must not import node:fs/promises`).not.toMatch(/from\s+['"]node:fs\/promises['"]/);
      expect(src, `${file} must not require node:fs`).not.toMatch(/require\(['"]node:fs(\/promises)?['"]\)/);
    }
  });
});

// =========================================================================
// P2 — per-run persisted plan source (perRunScriptBasename + loadRunPlan)
// =========================================================================

describe('perRunScriptBasename — recover the per-run persisted script', () => {
  it('prefers the persisted scriptPath basename when it is the cache-shape (2) path', () => {
    const header = {
      workflowName: 'modal-rust-poc-loop',
      scriptPath:
        '/Users/nicolas/.claude/projects/-slug/sess/workflows/scripts/modal-rust-poc-loop-wf_c4c14a7c-058.js',
    };
    expect(perRunScriptBasename(header, 'wf_c4c14a7c-058')).toBe(
      'modal-rust-poc-loop-wf_c4c14a7c-058.js',
    );
  });

  it('falls back to `<workflowName>-<runId>.js` when scriptPath is the shape-(1) project path', () => {
    const header = {
      workflowName: 'modal-rust-plan-research',
      scriptPath: '/Users/nicolas/devel/modal-rust/.claude/workflows/plan-research.js',
    };
    expect(perRunScriptBasename(header, 'wf_9f32796b-c0b')).toBe(
      'modal-rust-plan-research-wf_9f32796b-c0b.js',
    );
  });

  it('returns null when neither a cache scriptPath nor a workflowName is present', () => {
    expect(perRunScriptBasename({}, 'wf_x')).toBeNull();
    expect(perRunScriptBasename(null, 'wf_x')).toBeNull();
  });
});

describe('loadRunPlan — parse a run’s persisted script THROUGH the port', () => {
  const SCRIPT = `
export const meta = {
  name: 'modal-rust-poc-loop',
  description: 'loop the milestones',
  phases: [{ title: 'M0', detail: null }, { title: 'Record', detail: null }],
};
phase('M0')
const r = await agent('do M0', { label: 'M0', phase: 'M0' })
phase('Record')
const rec = await agent('record', { label: 'record', phase: 'Record' })
return { r, rec }
`;
  const SCRIPT_PATH = '/home/.claude/projects/-slug/sess/workflows/scripts/modal-rust-poc-loop-wf_x.js';

  function fakePort(): FileSystemPort {
    return {
      async readFile(path: string) {
        if (path === SCRIPT_PATH) return SCRIPT;
        throw new Error(`ENOENT: ${path}`);
      },
      async readJson() {
        throw new Error('unused');
      },
      async listDir() {
        return [];
      },
      async stat() {
        return null;
      },
      async exists(path: string) {
        return path === SCRIPT_PATH;
      },
      watch() {
        return () => {};
      },
    };
  }

  it('parses the persisted script into a static-source PlanModel (the per-run plan)', async () => {
    const plan = await loadRunPlan(fakePort(), SCRIPT_PATH, 'modal-rust-poc-loop-wf_x.js');
    expect(plan.derivedFrom).toBe('static-source');
    expect(plan.workflowName).toBe('modal-rust-poc-loop');
    expect(plan.lanes.map((l) => l.title)).toEqual(['M0', 'Record']);
    expect(plan.nodes.some((n) => n.kind === 'agent' && n.labelTemplate?.raw === 'record')).toBe(true);
    expect(plan.format).toBe(ADAPTER_FORMAT);
  });

  it('propagates a read miss (the route maps it to 404 — never a 500/leak)', async () => {
    await expect(loadRunPlan(fakePort(), '/home/.claude/projects/-slug/sess/workflows/scripts/missing.js')).rejects.toThrow();
  });
});
