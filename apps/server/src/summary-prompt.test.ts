import { describe, it, expect } from 'vitest';
import {
  SUMMARY_PROMPT_VERSION,
  buildSummaryPrompt,
  parseSummary,
  hashSummaryInput,
  type SummaryInput,
} from './llm/prompts/summary.ts';

// M4 narrative-summary prompt unit test (mirrors the caption/panel prompt tests). The input is the
// block's already-bounded HEAD+TAIL previews ONLY — never the full turns / raw transcript. We assert:
//   - the prompt embeds ONLY the bounded previews + the top tool counts (head+tail invariant),
//   - a well-formed reply parses to a capped NarrativeSummary on the contract shape,
//   - junk / a reply with no caption → null (NEVER throws),
//   - the content-addressed key is stable + folds in the prompt version.

const INPUT: SummaryInput = {
  topicLabel: 'Wire the M4 summary route',
  promptText: 'Implement M4: lazy per-block narrative summaries with a content-addressed cache.',
  responseText: 'Added summary.ts (prompt + parser), the engine, the route, and the FE fetch.',
  toolCounts: { Edit: 5, Read: 3, Bash: 2, Write: 1 },
};

describe('buildSummaryPrompt — head+tail input only', () => {
  it('embeds the bounded previews + top tool counts and asks for the four labeled lines', () => {
    const p = buildSummaryPrompt(INPUT);
    expect(p).toContain(INPUT.promptText);
    expect(p).toContain(INPUT.responseText);
    expect(p).toContain('topic: Wire the M4 summary route');
    // The four required fields are requested.
    expect(p).toContain('caption:');
    expect(p).toContain('body:');
    expect(p).toContain('intent:');
    expect(p).toContain('pattern:');
    // Top tool counts are surfaced (descending), so the model sees the work shape.
    expect(p).toContain('Edit×5');
    expect(p).toContain('Read×3');
  });

  it('does NOT carry full turns / raw transcript — only the given bounded previews', () => {
    const p = buildSummaryPrompt({
      topicLabel: null,
      promptText: 'short prompt',
      responseText: 'short response',
      toolCounts: {},
    });
    // No topic line when null; no tools line when empty.
    expect(p).not.toContain('topic:');
    expect(p).not.toContain('tools used:');
    expect(p).toContain('short prompt');
    expect(p).toContain('short response');
  });
});

describe('parseSummary — maps the reply onto NarrativeSummary, NEVER throws', () => {
  it('parses a well-formed four-line reply onto the contract shape', () => {
    const raw = [
      'caption: Implements lazy per-block narrative summaries',
      'body: Added the prompt, the engine, the route, and the lazy FE fetch. Gates stay green.',
      'intent: ship the M4 async summary layer',
      'pattern: feature implementation',
    ].join('\n');
    const s = parseSummary(raw)!;
    expect(s.caption).toBe('Implements lazy per-block narrative summaries');
    expect(s.body).toContain('Added the prompt');
    expect(s.intent).toBe('ship the M4 async summary layer');
    expect(s.pattern).toBe('feature implementation');
    expect(s.promptVersion).toBe(SUMMARY_PROMPT_VERSION);
  });

  it('is line-order-independent and strips quotes / a trailing period', () => {
    const raw = [
      'pattern: "bug fix"',
      'intent: fix the regression',
      'caption: "Fixes the off-by-one."',
      'body: Corrected the loop bound.',
    ].join('\n');
    const s = parseSummary(raw)!;
    expect(s.caption).toBe('Fixes the off-by-one');
    expect(s.pattern).toBe('bug fix');
  });

  it('caps the caption at ~12 words and the pattern at 4 lowercase words', () => {
    const longCaption = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ');
    const raw = [
      `caption: ${longCaption}`,
      'pattern: One TWO three four FIVE six',
    ].join('\n');
    const s = parseSummary(raw)!;
    expect(s.caption.split(/\s+/).length).toBeLessThanOrEqual(12);
    expect(s.pattern!.split(/\s+/).length).toBeLessThanOrEqual(4);
    expect(s.pattern).toBe(s.pattern!.toLowerCase());
  });

  it('caps the pattern on a WORD BOUNDARY — never a mid-word "…" chop (observed live)', () => {
    // The model returned a comma-joined two-concept pattern; the old char-cap chopped it to
    // "documentation, screenshot c…". The fix drops whole trailing words to fit instead.
    const s = parseSummary('caption: Refresh README screenshots\npattern: documentation, screenshot capture, retina exports')!;
    expect(s.pattern).not.toContain('…');
    expect(s.pattern!.split(/\s+/).length).toBeLessThanOrEqual(4);
    // every emitted word is whole (no trailing partial token)
    for (const w of s.pattern!.split(/\s+/)) expect(w).not.toMatch(/…$/);
  });

  it('"pattern: none" → null pattern; a missing body/intent → empty strings (not throw)', () => {
    const s = parseSummary('caption: A bare caption\npattern: none')!;
    expect(s.pattern).toBeNull();
    expect(s.body).toBe('');
    expect(s.intent).toBe('');
  });

  it('returns null for junk / a reply with no caption / null input', () => {
    expect(parseSummary(null)).toBeNull();
    expect(parseSummary('')).toBeNull();
    expect(parseSummary('total nonsense with no labels')).toBeNull();
    expect(parseSummary('body: there is a body but no caption')).toBeNull();
    expect(parseSummary('caption:   ')).toBeNull(); // empty caption → null
  });
});

describe('hashSummaryInput — content-addressed key', () => {
  it('is a stable 64-hex digest for identical input + tool-order-independent', () => {
    const a = hashSummaryInput(INPUT);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSummaryInput({ ...INPUT })).toBe(a);
    // Reordering the tool map keys must NOT change the key (projection sorts by count).
    const reordered: SummaryInput = {
      ...INPUT,
      toolCounts: { Write: 1, Bash: 2, Read: 3, Edit: 5 },
    };
    expect(hashSummaryInput(reordered)).toBe(a);
  });

  it('shifts when the previews change', () => {
    const a = hashSummaryInput(INPUT);
    expect(hashSummaryInput({ ...INPUT, promptText: 'different' })).not.toBe(a);
    expect(hashSummaryInput({ ...INPUT, responseText: 'different' })).not.toBe(a);
  });
});
