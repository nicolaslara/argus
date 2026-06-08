// @argus/server — the ONE content-addressed disk cache shared by every llm/ engine (node-caption
// explanations, sub-UI panels, narrative summaries). Each of those features computes its OWN key
// (a feature-specific projection hashed with its own prompt version) and keeps its OWN typed
// validation on read — but the cache-file IO is identical, so it lives here once:
//   - the hex-hash + containment path guard (a hash can NEVER escape the cache dir — defense-in-depth),
//   - a never-throwing JSON read (a bad hash / miss / parse error → null),
//   - a swallow-on-failure write (mkdir + writeFile; a cache-write failure must never crash the server).
// This is the M4-prep follow-up: dedupe the explain + subui + narrative-summary cache copies.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** A cache-file name is always sha256 hex; anything else is rejected before it can build a path. */
const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * A content-addressed disk cache under `<cacheDir>/<hash>.json`. The `hash` is a caller-computed
 * sha256 (the engines fold their feature projection + prompt version into it). NEVER throws: a bad
 * hash / miss / parse error reads as null, and a write failure is swallowed (the value still serves
 * from the engine's in-memory map this session). `T` is the on-disk entry shape — the caller does
 * its own typed validation + prompt-version check on top of `read()`.
 */
export class DiskCache<T> {
  private readonly dirAbs: string;

  constructor(cacheDir: string) {
    this.dirAbs = resolve(cacheDir);
  }

  /**
   * The resolved `<cacheDir>/<hash>.json` path, or null when the hash is not sha256-hex or the
   * resolved path would escape the cache dir. The charset assert + containment check are the
   * load-bearing guard (an attacker-influenced hash can never traverse out of the cache dir).
   */
  pathFor(hash: string): string | null {
    if (!HASH_RE.test(hash)) return null;
    const p = resolve(this.dirAbs, `${hash}.json`);
    return p === this.dirAbs || p.startsWith(this.dirAbs + '/') ? p : null;
  }

  /** Parse `<hash>.json` as `T`, or null on a bad hash / miss / parse error. NEVER throws. */
  async read(hash: string): Promise<T | null> {
    const p = this.pathFor(hash);
    if (p === null) return null;
    try {
      return JSON.parse(await readFile(p, 'utf8')) as T;
    } catch {
      return null;
    }
  }

  /** Write `entry` to `<hash>.json` (best-effort; a failure is swallowed). NEVER throws. */
  async write(hash: string, entry: T): Promise<void> {
    const p = this.pathFor(hash);
    if (p === null) return;
    try {
      await mkdir(this.dirAbs, { recursive: true });
      await writeFile(p, JSON.stringify(entry), 'utf8');
    } catch {
      // Swallow: a cache-write failure must never crash the server.
    }
  }
}
