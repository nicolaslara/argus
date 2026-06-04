import { describe, it, expect } from 'vitest';
import {
  ExplanationEngine,
  hashArtifact,
  cleanCaption,
  buildPrompt,
  planArtifacts,
  runArtifacts,
  type CachedExplanation,
  type ExplainCacheIO,
  type ClaudeRunner,
  type NodeArtifact,
} from './explain.ts';
import type { PlanModel, RunModel } from '@argus/contract';

// PX server cache unit test (boundaries.md §4 / design §10.3). `claude` is STUBBED via an
// injected ClaudeRunner — NO real spawn ever happens in tests. We exercise:
//   - MISS  → the runner is called, the caption is cached + served.
//   - HIT   → a reload (a fresh engine sharing the same cache) serves WITHOUT re-spawning.
//   - HASH-CHANGE → editing the artifact busts the cache → a new spawn.
//   - GRACEFUL DEGRADE → a null-returning runner keeps the baseline, never crashes.

const ARTIFACT: NodeArtifact = {
  id: 'research:a',
  kind: 'agent',
  label: 'research:a',
  phase: 'Research',
  role: '×3',
  evidence: 'workflow: plan-research\nlabel: research:${r.key}\nmultiplicity: fixed',
  baseline: 'parallel primary-source research',
};

/** An in-memory cache shared across "reloads" (separate engine instances). */
function memCache(): { io: ExplainCacheIO; store: Map<string, CachedExplanation> } {
  const store = new Map<string, CachedExplanation>();
  const io: ExplainCacheIO = {
    async read(hash) {
      return store.get(hash) ?? null;
    },
    async write(hash, entry) {
      store.set(hash, entry);
    },
  };
  return { io, store };
}

/** A counting runner that returns a deterministic caption (so we can assert spawn counts). */
function countingRunner(caption: string | null): { runner: ClaudeRunner; calls: () => number } {
  let calls = 0;
  const runner: ClaudeRunner = async () => {
    calls += 1;
    return caption;
  };
  return { runner, calls: () => calls };
}

/** Poll the engine's batch until no node is pending (or a bounded number of ticks). */
async function settle(engine: ExplanationEngine, target: string, ticks = 50): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    if (!engine.batch(target).pending) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('hashArtifact (content-addressed key)', () => {
  it('is stable for identical artifacts and ignores the node id', () => {
    const h1 = hashArtifact(ARTIFACT);
    const h2 = hashArtifact({ ...ARTIFACT, id: 'a-different-id' });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the artifact evidence changes (bust + regenerate)', () => {
    const h1 = hashArtifact(ARTIFACT);
    const h2 = hashArtifact({ ...ARTIFACT, evidence: ARTIFACT.evidence + ' EDITED' });
    expect(h1).not.toBe(h2);
  });
});

describe('cleanCaption', () => {
  it('takes the first line, strips quotes and a trailing period', () => {
    expect(cleanCaption('"Fans out a verifier per claim."\nextra')).toBe('Fans out a verifier per claim');
    expect(cleanCaption('  fresh agent — pairwise compare  ')).toBe('fresh agent — pairwise compare');
  });
  it('returns null for null / empty input (→ baseline fallback)', () => {
    expect(cleanCaption(null)).toBeNull();
    expect(cleanCaption('   ')).toBeNull();
  });
});

describe('buildPrompt', () => {
  it('grounds the prompt in BOTH identity and artifact evidence', () => {
    const p = buildPrompt(ARTIFACT);
    expect(p).toContain('node kind: agent');
    expect(p).toContain('label: research:a');
    expect(p).toContain('phase: Research');
    expect(p).toContain('multiplicity: fixed'); // the artifact evidence
  });
});

describe('ExplanationEngine — cache hit / miss / hash-change (claude stubbed)', () => {
  const target = 'plan:slug:plan-research.js';

  it('MISS: spawns once, serves the llm caption, then caches it', async () => {
    const { io, store } = memCache();
    const { runner, calls } = countingRunner('Fans out a verifier per claim');
    const engine = new ExplanationEngine({ cacheDir: '/unused', runner, cacheIO: io });

    // baseline available immediately (does not block).
    engine.warm(target, [ARTIFACT]);
    const immediate = engine.batch(target);
    expect(immediate.explanations[0]).toMatchObject({
      id: 'research:a',
      caption: 'parallel primary-source research',
      source: 'baseline',
    });

    await settle(engine, target);
    const after = engine.batch(target);
    expect(calls()).toBe(1); // exactly one spawn on a miss
    expect(after.explanations[0]).toMatchObject({
      caption: 'Fans out a verifier per claim',
      status: 'ready',
      source: 'llm',
    });
    expect(store.size).toBe(1); // written to the cache, keyed by the artifact hash
    expect([...store.keys()][0]).toBe(hashArtifact(ARTIFACT));
  });

  it('HIT: a reload (fresh engine, shared cache) serves WITHOUT re-spawning', async () => {
    const { io } = memCache();
    const first = countingRunner('cached-caption');
    const engineA = new ExplanationEngine({ cacheDir: '/unused', runner: first.runner, cacheIO: io });
    engineA.warm(target, [ARTIFACT]);
    await settle(engineA, target);
    expect(first.calls()).toBe(1);

    // "Reload": a brand-new engine over the SAME cache + a runner that MUST NOT be called.
    const second = countingRunner('SHOULD-NOT-RUN');
    const engineB = new ExplanationEngine({ cacheDir: '/unused', runner: second.runner, cacheIO: io });
    engineB.warm(target, [ARTIFACT]);
    await settle(engineB, target);

    expect(second.calls()).toBe(0); // CACHE HIT → no spawn on reload
    expect(engineB.batch(target).explanations[0]).toMatchObject({
      caption: 'cached-caption',
      status: 'ready',
      source: 'llm',
    });
  });

  it('HASH-CHANGE: editing the artifact busts the cache → a new spawn', async () => {
    const { io, store } = memCache();
    const r = countingRunner('v1');
    const engine = new ExplanationEngine({ cacheDir: '/unused', runner: r.runner, cacheIO: io });
    engine.warm(target, [ARTIFACT]);
    await settle(engine, target);
    expect(r.calls()).toBe(1);

    // Edit the underlying artifact (e.g. the workflow source changed) → new hash → miss.
    const edited: NodeArtifact = { ...ARTIFACT, evidence: ARTIFACT.evidence + '\nNEW STEP' };
    engine.warm(target, [edited]);
    await settle(engine, target);

    expect(r.calls()).toBe(2); // the changed hash forced a regenerate
    expect(store.size).toBe(2); // both the old and the new entry are cached
    expect(store.has(hashArtifact(edited))).toBe(true);
  });
});

describe('ExplanationEngine — graceful degradation (claude absent / errors)', () => {
  const target = 'plan:slug:x.js';

  it('keeps the baseline caption and reports engine-unavailable when the runner returns null', async () => {
    const { io } = memCache();
    const { runner, calls } = countingRunner(null); // simulates `claude` absent / error / timeout
    const engine = new ExplanationEngine({ cacheDir: '/unused', runner, cacheIO: io });
    engine.warm(target, [ARTIFACT]);
    await settle(engine, target);

    expect(calls()).toBe(1); // attempted once
    const batch = engine.batch(target);
    expect(batch.engineAvailable).toBe(false);
    expect(batch.explanations[0]).toMatchObject({
      caption: 'parallel primary-source research', // baseline retained
      source: 'baseline',
      status: 'error',
    });
  });

  it('a throwing runner never crashes the engine (still baseline)', async () => {
    const { io } = memCache();
    const runner: ClaudeRunner = async () => {
      throw new Error('boom');
    };
    const engine = new ExplanationEngine({ cacheDir: '/unused', runner, cacheIO: io });
    engine.warm(target, [ARTIFACT]);
    await settle(engine, target);
    expect(engine.batch(target).explanations[0]).toMatchObject({ source: 'baseline' });
  });
});

describe('artifact extraction (annotation-only — reads only emitted fields)', () => {
  it('planArtifacts captions agent + process nodes with an instant baseline', () => {
    const plan: PlanModel = {
      workflowFile: 'plan-research.js',
      workflowName: 'modal-rust-plan-research',
      lanes: [{ index: 1, title: 'Research', detail: 'do research', confidence: 'declared' }],
      nodes: [
        {
          id: 'research:${r.key}',
          kind: 'agent',
          title: 'research',
          labelTemplate: { literalPrefix: 'research:', holes: ['r.key'], raw: 'research:${r.key}' },
          agentType: null,
          phaseRef: 1,
          multiplicity: { kind: 'fixed', n: 3 },
          optional: false,
          loopRef: null,
          parentDecisionId: null,
          annotation: { subtitle: 'verifies the claim', typed: true, source: 'static' },
          confidence: 'static',
        },
      ],
      edges: [],
      containers: [],
      warnings: [],
      derivedFrom: 'static-source',
      coverageRatio: 1,
      format: 'cc-workflow/observed-2026-06-04',
    };
    const arts = planArtifacts(plan);
    expect(arts).toHaveLength(1);
    expect(arts[0]).toMatchObject({ id: 'research:${r.key}', kind: 'agent', phase: 'Research', role: '×3' });
    expect(arts[0]!.baseline).toBe('verifies the claim'); // declared detail → instant baseline
    expect(arts[0]!.evidence).toContain('has StructuredOutput schema');
  });

  it('runArtifacts uses the prompt first line as the baseline and keys on agentId', () => {
    const run = {
      ref: { projectPath: '/p', slug: 's', sessionId: 'sess', runId: 'wf_1' },
      workflowName: 'wf',
      status: 'completed',
      incomplete: false,
      startTime: 1,
      durationMs: 2,
      defaultModel: 'opus',
      summary: 's',
      phases: [{ index: 1, title: 'Research', detail: null }],
      agents: [
        {
          agentId: 'a1',
          index: 0,
          label: 'research:a',
          phaseIndex: 1,
          model: 'opus',
          state: 'done',
          cached: false,
          agentType: null,
          attempt: null,
          failedInLogs: false,
          tokens: 100,
          toolCalls: 2,
          durationMs: 5,
          queuedAt: null,
          startedAt: null,
          lastProgressAt: null,
          lastToolName: null,
          lastToolSummary: null,
          promptPreview: { text: 'Research the foo subsystem\nmore detail', truncated: false },
          resultPreview: null,
        },
      ],
      edges: [],
      logs: [],
      partialFailure: { present: false, lines: [] },
      error: null,
      args: null,
      warnings: [],
      format: 'cc-workflow/observed-2026-06-04',
    } as unknown as RunModel;
    const arts = runArtifacts(run);
    expect(arts).toHaveLength(1);
    expect(arts[0]).toMatchObject({ id: 'a1', kind: 'execution-agent', phase: 'Research' });
    expect(arts[0]!.baseline).toBe('Research the foo subsystem'); // prompt first line
    expect(arts[0]!.evidence).toContain('prompt: Research the foo subsystem');
  });
});
