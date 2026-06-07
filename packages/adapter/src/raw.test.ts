import { describe, it, expect } from 'vitest';
import {
  makePreview,
  agentFailedInLogs,
  deriveAgentState,
  deriveRunStatus,
  leaksInternalPath,
  findFailureLogLines,
  PREVIEW_TRUNCATED_RAW_LEN,
  PREVIEW_EMIT_CAP,
} from './raw.ts';

// Unit tests for the defensive parsing helpers in raw.ts. Every exported helper
// here is PURE (no I/O) and contractually NEVER throws — the tests focus on the
// boundary semantics documented in boundaries.md §2.3 / §3.

describe('makePreview', () => {
  it('returns null for non-string raw (absent / wrong-typed)', () => {
    expect(makePreview(undefined)).toBeNull();
    expect(makePreview(null)).toBeNull();
    expect(makePreview(42)).toBeNull();
    expect(makePreview({})).toBeNull();
  });

  it('marks an empty preview as NOT truncated (empty is a real signal)', () => {
    expect(makePreview('')).toEqual({ text: '', truncated: false });
  });

  it('is truncated IFF raw length === PREVIEW_TRUNCATED_RAW_LEN (401)', () => {
    const atCap = 'a'.repeat(PREVIEW_TRUNCATED_RAW_LEN); // 401
    const belowCap = 'a'.repeat(PREVIEW_TRUNCATED_RAW_LEN - 1); // 400
    const aboveCap = 'a'.repeat(PREVIEW_TRUNCATED_RAW_LEN + 1); // 402

    expect(makePreview(atCap)!.truncated).toBe(true);
    expect(makePreview(belowCap)!.truncated).toBe(false);
    // The flag is an EXACT-equality check (the upstream reads cap+1 = 401 chars to detect
    // overflow, so === 401 means "was truncated"; a 402-char raw never actually reaches here).
    expect(makePreview(aboveCap)!.truncated).toBe(false);
  });

  it('passes short text through verbatim without an emit cap', () => {
    const p = makePreview('hello world');
    expect(p).toEqual({ text: 'hello world', truncated: false });
  });

  it('hard-caps emitted text at PREVIEW_EMIT_CAP without flagging truncated', () => {
    const huge = 'x'.repeat(PREVIEW_EMIT_CAP + 100);
    const p = makePreview(huge)!;
    expect(p.text.length).toBe(PREVIEW_EMIT_CAP);
    // emit-cap slicing is unrelated to the raw-length `truncated` heuristic.
    expect(p.truncated).toBe(false);
  });

  it('emits exactly the cap length unchanged (cap is inclusive boundary)', () => {
    const exactly = 'y'.repeat(PREVIEW_EMIT_CAP);
    const p = makePreview(exactly)!;
    // length > CAP is the slice condition, so length === CAP is left untouched.
    expect(p.text.length).toBe(PREVIEW_EMIT_CAP);
    expect(p.text).toBe(exactly);
  });
});

describe('deriveRunStatus', () => {
  it('passes through the four known statuses verbatim', () => {
    expect(deriveRunStatus('completed')).toBe('completed');
    expect(deriveRunStatus('failed')).toBe('failed');
    expect(deriveRunStatus('killed')).toBe('killed');
    expect(deriveRunStatus('running')).toBe('running');
  });

  it("defaults unknown / missing / non-string to 'completed'", () => {
    expect(deriveRunStatus('weird')).toBe('completed');
    expect(deriveRunStatus(undefined)).toBe('completed');
    expect(deriveRunStatus(null)).toBe('completed');
    expect(deriveRunStatus(123)).toBe('completed');
  });
});

describe('deriveAgentState', () => {
  it("maps raw 'done' -> 'done' regardless of run status", () => {
    expect(deriveAgentState('done', 'completed')).toBe('done');
    expect(deriveAgentState('done', 'killed')).toBe('done');
  });

  it("maps 'progress'/'running' -> 'running' on a live run", () => {
    expect(deriveAgentState('progress', 'running')).toBe('running');
    expect(deriveAgentState('running', 'completed')).toBe('running');
  });

  it("overrides 'progress'/'running' -> 'interrupted' on a dead run (killed/failed)", () => {
    expect(deriveAgentState('progress', 'killed')).toBe('interrupted');
    expect(deriveAgentState('progress', 'failed')).toBe('interrupted');
    expect(deriveAgentState('running', 'killed')).toBe('interrupted');
    expect(deriveAgentState('running', 'failed')).toBe('interrupted');
  });

  it("maps 'queued' -> 'queued' and 'error' -> 'error'", () => {
    expect(deriveAgentState('queued', 'running')).toBe('queued');
    expect(deriveAgentState('error', 'completed')).toBe('error');
  });

  it("maps raw 'interrupted' -> 'interrupted' directly", () => {
    expect(deriveAgentState('interrupted', 'completed')).toBe('interrupted');
  });

  it("maps anything else -> 'unknown' (never crashes)", () => {
    expect(deriveAgentState('mystery', 'completed')).toBe('unknown');
    expect(deriveAgentState(undefined, 'running')).toBe('unknown');
    expect(deriveAgentState(null, 'killed')).toBe('unknown');
    expect(deriveAgentState(99, 'failed')).toBe('unknown');
  });
});

describe('leaksInternalPath', () => {
  it('is true when the $bunfs bundle marker is present', () => {
    expect(leaksInternalPath('at run (/$bunfs/root/cli.js:1:2)')).toBe(true);
    // marker anywhere in the string still leaks.
    expect(leaksInternalPath('/$bunfs/')).toBe(true);
  });

  it('is false for ordinary text with no bundle marker', () => {
    expect(leaksInternalPath('')).toBe(false);
    expect(leaksInternalPath('just a normal error message')).toBe(false);
    // a similar-but-different path is NOT the marker.
    expect(leaksInternalPath('/usr/local/bin/cli.js')).toBe(false);
    expect(leaksInternalPath('bunfs')).toBe(false);
  });
});

describe('findFailureLogLines', () => {
  it('returns only the verbatim lines containing "failed" (case-insensitive)', () => {
    const logs = [
      'agent started',
      'task FAILED with code 1',
      'all good here',
      'something Failed quietly',
      'recovered',
    ];
    expect(findFailureLogLines(logs)).toEqual(['task FAILED with code 1', 'something Failed quietly']);
  });

  it('matches "failed" as an incidental substring too (it is a plain /failed/i test)', () => {
    expect(findFailureLogLines(['unfailed-check'])).toEqual(['unfailed-check']);
  });

  it('ignores non-string entries without throwing', () => {
    const logs = [null, undefined, 42, { failed: true }, ['failed'], 'real failed line'];
    expect(findFailureLogLines(logs)).toEqual(['real failed line']);
  });

  it('returns an empty array when nothing matches', () => {
    expect(findFailureLogLines(['ok', 'fine', 'success'])).toEqual([]);
    expect(findFailureLogLines([])).toEqual([]);
  });
});

describe('agentFailedInLogs', () => {
  const lines = ['plan-research failed: timeout', 'agent_07 failed', 'phase:build:compile failed'];

  it('returns false when neither label nor agentId is a usable string', () => {
    expect(agentFailedInLogs(undefined, undefined, lines)).toBe(false);
    expect(agentFailedInLogs('', '', lines)).toBe(false);
  });

  it('matches a hyphenated label as a whole token', () => {
    expect(agentFailedInLogs('plan-research', undefined, lines)).toBe(true);
  });

  it('matches an underscore agentId as a whole token', () => {
    expect(agentFailedInLogs(undefined, 'agent_07', lines)).toBe(true);
  });

  it('matches a colon-delimited sub-label like x:y:z', () => {
    expect(agentFailedInLogs('phase:build:compile', undefined, lines)).toBe(true);
  });

  it('matches if EITHER label or agentId hits (label miss, agentId hit)', () => {
    expect(agentFailedInLogs('not-present', 'agent_07', lines)).toBe(true);
  });

  it('does NOT match an incidental substring (no false slander)', () => {
    // 'research' is a substring of 'plan-research' but not a whole token there.
    expect(agentFailedInLogs('research', undefined, lines)).toBe(false);
    // 'plan' is the prefix of 'plan-research' but a hyphen is part of the token class.
    expect(agentFailedInLogs('plan', undefined, lines)).toBe(false);
    // 'build' is an inner segment of 'phase:build:compile'; colon is in the token class.
    expect(agentFailedInLogs('build', undefined, lines)).toBe(false);
  });

  it('returns false when the candidate never appears at all', () => {
    expect(agentFailedInLogs('totally-absent', 'ghost_id', lines)).toBe(false);
  });

  it('returns false against an empty failure-line set', () => {
    expect(agentFailedInLogs('plan-research', 'agent_07', [])).toBe(false);
  });

  it('treats regex-special characters in the id literally (escaped)', () => {
    const special = ['parallel[0] failed: agent({schema})'];
    // The bracketed id is matched literally, bounded by non-word/non-(:|-) chars.
    expect(agentFailedInLogs('parallel[0]', undefined, special)).toBe(true);
    // A different literal id with special chars that is not present stays false.
    expect(agentFailedInLogs('parallel[1]', undefined, special)).toBe(false);
  });

  it('matches a token at the very start or end of a line', () => {
    expect(agentFailedInLogs('agent_07', undefined, ['agent_07 failed'])).toBe(true);
    expect(agentFailedInLogs('agent_07', undefined, ['build failed agent_07'])).toBe(true);
  });
});
