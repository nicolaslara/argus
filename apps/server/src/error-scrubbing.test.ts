import { describe, it, expect } from 'vitest';
import type { FileSystemPort } from '@argus/adapter';
import { handleRunSnapshot, type RouteDeps } from './routes.ts';
import { scrubError } from './error-redaction.ts';

// Integration: the FULL stack from a throwing route → the index.ts dispatch catch → a coded
// 500 body. The route layer is designed to catch internally and return a coded `err()`, but
// the dispatch catch-all is the LAST line of defence against an unexpected throw. These tests
// prove that whatever bubbles up, the body the client sees carries no path / stack / $bunfs /
// token. (index.ts's `.catch((err) => send(res, 500, scrubError(err)))` is reproduced here.)

const CLAUDE_HOME = '/home/.claude';
const PATHY = `${CLAUDE_HOME}/projects/-slug/session/workflows/wf_secret.json`;

/** A port that throws an error whose message carries an absolute path on EVERY read. */
function throwingPort(): FileSystemPort {
  const boom = (): never => {
    throw new Error(`EACCES, open '${PATHY}' at $bunfs/root/cli.js:1:1`);
  };
  return {
    async readFile() {
      return boom();
    },
    async readJson() {
      return boom();
    },
    async listDir() {
      return boom();
    },
    async stat() {
      return boom();
    },
    async exists() {
      return boom();
    },
    watch() {
      return () => {};
    },
  };
}

/** Reproduce index.ts's dispatch promise chain (success → body, throw → scrubbed 500). */
async function dispatchWithScrub(
  run: () => Promise<{ status: number; body: unknown }>,
): Promise<{ status: number; body: unknown }> {
  try {
    return await run();
  } catch (err) {
    return { status: 500, body: scrubError(err) };
  }
}

function assertNoLeak(body: unknown): void {
  const serialized = JSON.stringify(body);
  expect(serialized.includes(PATHY)).toBe(false);
  expect(serialized.includes('$bunfs')).toBe(false);
  expect(serialized.includes('EACCES')).toBe(false);
  expect(serialized.includes(CLAUDE_HOME)).toBe(false);
}

describe('error scrubbing (route throw → dispatch catch → coded body)', () => {
  it('handleRunSnapshot still returns a coded body when the port throws path-bearing errors', async () => {
    const deps: RouteDeps = { port: throwingPort(), claudeHome: CLAUDE_HOME };
    // The snapshot route catches readJson failures internally and returns a coded 404 — prove
    // that even the route's OWN body never echoes the thrown path, AND the dispatch wrapper is
    // a no-op (the route did not throw).
    const res = await dispatchWithScrub(() =>
      handleRunSnapshot(deps, '-slug', 'session', 'wf_secret'),
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
    assertNoLeak(res.body);
  });

  it('a synthetic route throw with a stack + token is collapsed to the coded body', async () => {
    const res = await dispatchWithScrub(async () => {
      const e = new Error(`leak ${PATHY} Bearer abc123`);
      e.stack = `Error\n    at $bunfs/root/cli.js:9:9`;
      throw e;
    });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal_error' });
    assertNoLeak(res.body);
    expect(JSON.stringify(res.body).includes('Bearer')).toBe(false);
  });
});
