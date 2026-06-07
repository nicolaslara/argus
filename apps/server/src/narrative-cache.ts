// @argus/server — the Session Narrative ("Story" view) disk cache (M1). A precomputed
// `SessionNarrative` is content-addressed cached on disk so a re-open of a session is an
// instant read instead of a fresh 67 MB scan + segment pass. Mirrors explain.ts's
// `diskCacheIO` pattern EXACTLY (sha256(stable projection) + a VERSION pin ->
// `.argus/cache/narratives/<hash>.json`, graceful when absent — never throws).
//
// THE KEY DIFFERENCE from explain.ts: the cache key folds in the transcript's `stat`
// ({size, mtimeMs}) so a CHANGED transcript (a session that grew by an append) MISSES the
// cache and recomputes — the on-disk content is the authority, not the prompt recipe. We
// cannot hash the content (it is the 67 MB we are trying to avoid re-reading), so the
// (size, mtimeMs) pair stands in for it: any append moves both, so a stale entry is never
// served. Bump NARRATIVE_CACHE_VERSION to bust ALL entries when the segmenter changes.
//
// Security/privacy (boundaries.md §4 / knowledge.md decision 4): the cached narrative holds
// ONLY redact()-routed, head/tail-bounded previews + basenames + counts — no image bytes,
// no full bodies, no full paths. The cache lives under gitignored .argus/. A cache
// read/write failure is swallowed (the route recomputes from the transcript).

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SessionNarrative } from '@argus/contract';

/**
 * Cache-version pin: bump this to bust ALL narrative cache entries when the segmenter's
 * output shape changes (a new computed field, a different cut rule, a preview-bound tweak).
 * Folded into the cache key so a regenerated entry never collides with a stale-format one.
 * Distinct from NARRATIVE_FORMAT (the on-disk transcript pin) — this versions OUR output.
 */
export const NARRATIVE_CACHE_VERSION = 'narr-v1';

/** The transcript's filesystem identity used to detect an append (a changed file misses). */
export interface TranscriptStat {
  size: number;
  mtimeMs: number;
}

/**
 * The content-addressed cache key for ONE session's narrative. PURE. We hash a STABLE
 * projection: the slug + sessionId IDENTIFY the session, and the transcript stat
 * {size, mtimeMs} stands in for its content (we cannot hash the 67 MB we are avoiding) —
 * so an APPEND (which moves size + mtimeMs) yields a NEW key and forces a recompute, while
 * an unchanged transcript re-opens to the same key (a hit). NARRATIVE_CACHE_VERSION busts.
 */
export function narrativeCacheKey(
  slug: string,
  sessionId: string,
  stat: TranscriptStat,
): string {
  const stable = {
    slug,
    sessionId,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
  return createHash('sha256')
    .update(JSON.stringify(stable) + ' ' + NARRATIVE_CACHE_VERSION)
    .digest('hex');
}

/**
 * The cache IO seam (mirrors explain.ts's ExplainCacheIO) so tests can stub it without
 * touching disk. `read` returns the cached narrative or null on a miss/parse error;
 * `write` persists it (best-effort, swallowed on failure).
 */
export interface NarrativeCacheIO {
  read(hash: string): Promise<SessionNarrative | null>;
  write(hash: string, entry: SessionNarrative): Promise<void>;
}

/**
 * The default disk-backed narrative cache under `<cacheDir>/<hash>.json`. The path is built
 * with resolve() and the hash charset is asserted hex (defense-in-depth: a hash can never
 * escape the cache dir). NEVER throws — a read miss/parse error / version drift returns null;
 * a write failure is swallowed (the route just recomputes from the transcript this session).
 */
export function diskNarrativeCacheIO(cacheDir: string): NarrativeCacheIO {
  const dirAbs = resolve(cacheDir);
  const HEX_RE = /^[0-9a-f]{64}$/;
  function pathFor(hash: string): string | null {
    if (!HEX_RE.test(hash)) return null;
    const p = resolve(dirAbs, `${hash}.json`);
    if (p !== dirAbs && !p.startsWith(dirAbs + '/')) return null;
    return p;
  }
  return {
    async read(hash: string): Promise<SessionNarrative | null> {
      const p = pathFor(hash);
      if (p === null) return null;
      try {
        const text = await readFile(p, 'utf8');
        const o = JSON.parse(text) as unknown;
        if (!o || typeof o !== 'object') return null;
        const c = o as Record<string, unknown>;
        // Defensive shape check: a malformed/partial entry is a miss (recompute), not a throw.
        // The key already folds in the transcript stat + version, so a hit IS the right shape;
        // this guards a hand-edited / truncated cache file.
        if (typeof c.sessionId !== 'string' || !Array.isArray(c.blocks)) return null;
        return c as unknown as SessionNarrative;
      } catch {
        return null;
      }
    },
    async write(hash: string, entry: SessionNarrative): Promise<void> {
      const p = pathFor(hash);
      if (p === null) return;
      try {
        await mkdir(dirAbs, { recursive: true });
        await writeFile(p, JSON.stringify(entry), 'utf8');
      } catch {
        // Swallow: a cache-write failure must never crash the server (the narrative still
        // serves from the in-memory compute this session).
      }
    },
  };
}

/** Where the narrative cache lives (gitignored, sibling to the explanations cache). */
export function narrativesCacheDir(repoRoot: string): string {
  return join(repoRoot, '.argus', 'cache', 'narratives');
}
