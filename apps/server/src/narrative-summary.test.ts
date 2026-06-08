import { describe, it, expect } from 'vitest';
import { NarrativeSummaryEngine, type SummaryInput } from './narrative-summary.ts';

// M4 narrative-summary ENGINE unit test (mirrors subui.test.ts / explain.test.ts). `claude` is
// STUBBED via an injected runner — NO real spawn. We exercise:
//   - MISS → the runner is called once, ready + a NarrativeSummary on the contract shape.
//   - HIT  → a 2nd call for the SAME input is a memory cache hit (no re-run) — the one-time invariant.
//   - DEGRADE → runner-returns-null → unavailable/null (the FE keeps the baseline).
//   - ERROR → an unparseable reply → error/null (NEVER throws).

const INPUT: SummaryInput = {
  topicLabel: 'A topic',
  promptText: 'Do the thing.',
  responseText: 'Did the thing.',
  toolCounts: { Edit: 2 },
};

const GOOD_REPLY = [
  'caption: Does the thing',
  'body: Performed the requested change.',
  'intent: complete the task',
  'pattern: feature implementation',
].join('\n');

describe('NarrativeSummaryEngine', () => {
  it('runs the claude runner once, returns ready + caches in memory (2nd call is a HIT)', async () => {
    let calls = 0;
    const runner = async () => {
      calls += 1;
      return GOOD_REPLY;
    };
    // A read-only/nonexistent cache dir forces the mem-cache path (disk write is swallowed).
    const engine = new NarrativeSummaryEngine({ cacheDir: '/nonexistent-readonly', runner });

    const a = await engine.generate(INPUT);
    expect(a.status).toBe('ready');
    expect(a.summary?.caption).toBe('Does the thing');
    expect(a.summary?.pattern).toBe('feature implementation');
    expect(a.summary?.promptVersion).toBeTruthy();

    const b = await engine.generate(INPUT); // SAME input → memory cache hit, no re-run
    expect(b.status).toBe('ready');
    expect(b.summary?.caption).toBe('Does the thing');
    expect(calls).toBe(1); // one-time: the 2nd call did NOT re-spawn
  });

  it('claude absent (runner null) → unavailable; the FE keeps the baseline', async () => {
    const absent = new NarrativeSummaryEngine({ cacheDir: '/x', runner: async () => null });
    const r = await absent.generate(INPUT);
    expect(r.status).toBe('unavailable');
    expect(r.summary).toBeNull();
  });

  it('unparseable reply → error/null (NEVER throws)', async () => {
    const bad = new NarrativeSummaryEngine({ cacheDir: '/x', runner: async () => 'no labels here' });
    const r = await bad.generate(INPUT);
    expect(r.status).toBe('error');
    expect(r.summary).toBeNull();
  });

  it('a runner that THROWS degrades to unavailable (never propagates)', async () => {
    const throwing = new NarrativeSummaryEngine({
      cacheDir: '/x',
      runner: async () => {
        throw new Error('spawn blew up');
      },
    });
    const r = await throwing.generate(INPUT);
    expect(r.status).toBe('unavailable');
    expect(r.summary).toBeNull();
  });
});
