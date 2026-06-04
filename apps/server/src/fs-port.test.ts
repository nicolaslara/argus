import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { NodeFileSystemPort } from './fs-port.ts';
import { loadRun, ADAPTER_FORMAT, type AdapterContext } from '@argus/adapter';
import type { RunRef } from '@argus/contract';

// Port contract test (boundaries.md §2.1): exercise the real node FileSystemPort end
// to end with the adapter's loadRun, reading a real captured wf_*.json THROUGH the
// port — proving the injected disk seam works and the adapter never needs node:fs.

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, '..', '..', '..', '.argus', 'fixtures', 'finished');
const WF = join(FIXTURE_DIR, 'completed-14agents.wf.json');

const REF: RunRef = {
  projectPath: '/Users/nicolas/devel/modal-rust',
  slug: '-Users-nicolas-devel-modal-rust',
  sessionId: 'session-x',
  runId: 'wf_test',
};

describe('NodeFileSystemPort (port contract)', () => {
  const port = new NodeFileSystemPort();

  it('reads + normalizes a real wf_*.json THROUGH the port via loadRun', async () => {
    const ctx: AdapterContext = { ref: REF };
    const model = await loadRun(port, WF, ctx);
    expect(model.status).toBe('completed');
    expect(model.agents.length).toBe(14);
    expect(model.phases.length).toBeGreaterThan(0);
    expect(model.format).toBe(ADAPTER_FORMAT);
  });

  it('readJson parses; exists() is true for the fixture, false for a bogus path', async () => {
    expect(typeof (await port.readJson(WF))).toBe('object');
    expect(await port.exists(WF)).toBe(true);
    expect(await port.exists(join(FIXTURE_DIR, 'does-not-exist.json'))).toBe(false);
  });

  it('listDir lists the finished fixtures; stat returns size for a file, null for absent', async () => {
    const names = (await port.listDir(FIXTURE_DIR)).map((e) => e.name);
    expect(names).toContain('completed-14agents.wf.json');
    const s = await port.stat(WF);
    expect(s).not.toBeNull();
    expect(s!.size).toBeGreaterThan(0);
    expect(await port.stat(join(FIXTURE_DIR, 'nope.json'))).toBeNull();
  });

  it('is read-only — exposes no write method (read-only stance)', () => {
    expect((port as unknown as Record<string, unknown>).writeFile).toBeUndefined();
    expect((port as unknown as Record<string, unknown>).writeJson).toBeUndefined();
  });
});
