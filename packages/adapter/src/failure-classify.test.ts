// Unit tests for the failure-cause classifier — the signatures are the REAL terminal-error
// strings extracted from failing agent transcripts in the run corpus (2026-06-07 scan).

import { describe, it, expect } from 'vitest';
import { classifyFailureText, transcriptTail } from './failure-classify.ts';

describe('classifyFailureText', () => {
  it('socket close → infra/socket (the dominant ~96% case)', () => {
    const c = classifyFailureText(
      'API Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true`',
    );
    expect(c).not.toBeNull();
    expect(c!.mode).toBe('infra');
    expect(c!.kind).toBe('socket');
  });

  it('session limit → infra/session-limit, with the reset time in detail', () => {
    const c = classifyFailureText("You've hit your session limit · resets 12:20pm (Europe/Stockholm)");
    expect(c!.mode).toBe('infra');
    expect(c!.kind).toBe('session-limit');
    expect(c!.detail).toContain('resets 12:20pm');
  });

  it('529 overloaded → infra/overloaded', () => {
    const c = classifyFailureText('API Error: 529 Overloaded. This is a server-side issue.');
    expect(c!.mode).toBe('infra');
    expect(c!.kind).toBe('overloaded');
  });

  it('schema rejection → model/schema-validation (the only genuine model fault), field in detail', () => {
    const c = classifyFailureText(
      'Output does not match required schema: /milestones/0: must NOT have additional properties, /milestones/1: must NOT have additional properties',
    );
    expect(c!.mode).toBe('model');
    expect(c!.kind).toBe('schema-validation');
    expect(c!.detail).toContain('/milestones/0');
  });

  it('no known signature → null (caller falls back to the model message)', () => {
    expect(classifyFailureText('just a normal final assistant message, all good')).toBeNull();
    expect(classifyFailureText('')).toBeNull();
  });

  it('classifies the TAIL: a long transcript whose terminal record is a socket error', () => {
    const body = Array.from({ length: 50 }, (_, i) => `{"type":"text","text":"working step ${i}"}`).join('\n');
    const tail = '{"type":"text","text":"API Error: The socket connection was closed unexpectedly"}';
    const c = classifyFailureText(transcriptTail(body + '\n' + tail));
    expect(c!.kind).toBe('socket');
  });
});

describe('transcriptTail', () => {
  it('returns the last N non-empty lines', () => {
    const text = 'a\n\nb\nc\n\n\nd\ne';
    expect(transcriptTail(text, 3)).toBe('c\nd\ne');
  });
  it('handles fewer lines than n', () => {
    expect(transcriptTail('only', 5)).toBe('only');
  });
});
