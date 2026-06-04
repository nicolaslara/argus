import { describe, it, expect } from 'vitest';
import { ADAPTER_FORMAT, deriveSlug, recoverProjectPath } from './index.ts';

describe('adapter format pin', () => {
  it('is the observed-format constant', () => {
    expect(ADAPTER_FORMAT).toBe('cc-workflow/observed-2026-06-04');
  });
});

describe('deriveSlug', () => {
  it('replaces every non-alphanumeric char with "-" (verified rule)', () => {
    expect(deriveSlug('/Users/nicolas/devel/modal-rust')).toBe('-Users-nicolas-devel-modal-rust');
    // /.config -> "--config" (the slash and the dot each become a dash)
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
