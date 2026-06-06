import { describe, it, expect } from 'vitest';
import { scrubError } from './error-redaction.ts';

// boundaries.md §4 redaction: the dispatch catch-all must collapse ANY thrown value into a
// coded body that leaks no path, stack, $bunfs runtime path, bearer token, or file content.
// scrubError is the pure chokepoint; these tests pin the invariant so a future drift (echoing
// err.message into the body) is caught here, not in production.

// The shapes a leak would take. We assert NONE of these substrings appear in any output.
const SECRETS = [
  '/Users/nicolas/devel/argus/apps/server/src/routes.ts', // absolute path
  '/home/.claude/projects/-slug/session/workflows/wf_x.json', // claudeHome path
  '$bunfs/root/cli.js', // bun runtime path
  'at Object.<anonymous> (/app/index.ts:42:13)', // stack frame
  'Bearer 0123456789abcdef0123456789abcdef', // a fake bearer token
  'ARGUS_TOKEN=deadbeefcafe', // env-style token
  'the quick brown fox file contents', // file contents
];

function assertScrubbed(out: unknown): void {
  expect(out).toEqual({ error: 'internal_error' });
  const serialized = JSON.stringify(out);
  for (const secret of SECRETS) {
    expect(serialized.includes(secret)).toBe(false);
  }
}

describe('scrubError (pure redaction chokepoint)', () => {
  it('an Error whose message holds an absolute path → coded body only', () => {
    assertScrubbed(scrubError(new Error(SECRETS[0])));
  });

  it('an Error whose message holds a claudeHome path → coded body only', () => {
    assertScrubbed(scrubError(new Error(`ENOENT, open '${SECRETS[1]}'`)));
  });

  it('an Error carrying a $bunfs stack → coded body only', () => {
    const err = new Error('boom');
    err.stack = `Error: boom\n    at ${SECRETS[2]}\n    ${SECRETS[3]}`;
    assertScrubbed(scrubError(err));
  });

  it('a raw string error holding a bearer token → coded body only', () => {
    assertScrubbed(scrubError(SECRETS[4]));
    assertScrubbed(scrubError(SECRETS[5]));
  });

  it('a structured object holding file contents + a path → coded body only', () => {
    assertScrubbed(scrubError({ message: SECRETS[6], path: SECRETS[1], stack: SECRETS[3] }));
  });

  it('null / undefined / number → coded body only (total, never throws)', () => {
    assertScrubbed(scrubError(null));
    assertScrubbed(scrubError(undefined));
    assertScrubbed(scrubError(500));
  });

  it('an object with a throwing getter is still scrubbed (never re-throws)', () => {
    const hostile = {
      get message(): string {
        throw new Error('side-effect on read');
      },
    };
    expect(() => scrubError(hostile)).not.toThrow();
    assertScrubbed(scrubError(hostile));
  });

  it('is deterministic — same input gives an equal output every call', () => {
    const err = new Error(SECRETS[0]);
    expect(scrubError(err)).toEqual(scrubError(err));
    expect(scrubError('anything')).toEqual(scrubError(42));
  });
});
