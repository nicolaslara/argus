import { describe, it, expect } from 'vitest';
import { parseSubUiSpec, buildSubUiPrompt, SubUiEngine } from './subui.ts';

describe('parseSubUiSpec — STRICT validation of untrusted LLM output', () => {
  it('accepts a valid spec and keeps the section grammar', () => {
    const raw = JSON.stringify({
      title: 'Research findings',
      sections: [
        { kind: 'callout', tone: 'success', text: 'Verified end to end.' },
        { kind: 'metrics', items: [{ label: 'facts', value: '14' }] },
        { kind: 'list', ordered: true, items: ['a', 'b'] },
        { kind: 'table', columns: ['c1', 'c2'], rows: [['x', 'y']] },
      ],
    });
    const spec = parseSubUiSpec(raw)!;
    expect(spec.title).toBe('Research findings');
    expect(spec.sections.map((s) => s.kind)).toEqual(['callout', 'metrics', 'list', 'table']);
  });

  it('tolerates code fences / leading prose around the JSON', () => {
    const raw = 'Here you go:\n```json\n{"title":"T","sections":[{"kind":"text","text":"hi"}]}\n```';
    expect(parseSubUiSpec(raw)?.sections[0]).toEqual({ kind: 'text', text: 'hi' });
  });

  it('DROPS unknown section kinds and coerces non-string leaves to strings', () => {
    const raw = JSON.stringify({
      title: 7,
      sections: [
        { kind: 'script', src: 'alert(1)' }, // unknown → dropped (no injection surface)
        { kind: 'metrics', items: [{ label: 'n', value: 42 }] }, // 42 → "42"
      ],
    });
    const spec = parseSubUiSpec(raw)!;
    expect(spec.title).toBe('7');
    expect(spec.sections).toHaveLength(1);
    expect(spec.sections[0]).toEqual({ kind: 'metrics', items: [{ label: 'n', value: '42' }] });
  });

  it('returns null for non-JSON / a spec with no valid section', () => {
    expect(parseSubUiSpec('not json')).toBeNull();
    expect(parseSubUiSpec('{"sections":[{"kind":"bogus"}]}')).toBeNull();
    expect(parseSubUiSpec(null)).toBeNull();
  });
});

describe('buildSubUiPrompt', () => {
  it('embeds the result + asks for JSON-only of the section grammar', () => {
    const p = buildSubUiPrompt({ verdict: 'sound' });
    expect(p).toContain('"verdict": "sound"');
    expect(p).toContain('"kind":"callout"');
    expect(p).toContain('Output JSON ONLY');
  });
});

describe('SubUiEngine', () => {
  it('runs the claude runner once, returns ready + caches in memory (no re-run)', async () => {
    let calls = 0;
    const runner = async () => {
      calls += 1;
      return '{"title":"T","sections":[{"kind":"text","text":"ok"}]}';
    };
    const engine = new SubUiEngine({ cacheDir: '/nonexistent-readonly', runner });
    const a = await engine.generate({ x: 1 });
    expect(a.status).toBe('ready');
    expect(a.spec?.sections[0]).toEqual({ kind: 'text', text: 'ok' });
    const b = await engine.generate({ x: 1 }); // same input → memory cache hit, no re-run
    expect(b.status).toBe('ready');
    expect(calls).toBe(1);
  });

  it('claude absent → unavailable; invalid output → error (web falls back to R1)', async () => {
    const absent = new SubUiEngine({ cacheDir: '/x', runner: async () => null });
    expect((await absent.generate({ x: 2 })).status).toBe('unavailable');
    const bad = new SubUiEngine({ cacheDir: '/x', runner: async () => 'garbage' });
    expect((await bad.generate({ x: 3 })).status).toBe('error');
  });
});
