// @argus/server — the Narrative Summary engine (M4 "Story" view). On-demand, LAZY per-block
// narrative summaries: Claude reads ONLY a block's bounded head+tail previews and emits a concise
// caption + body + intent + pattern. Generated when the FE requests it (block in view), content-
// addressed-cached so it is one-time, NEVER eager-warmed across all blocks.
//
// MIRRORS subui.ts EXACTLY (the on-demand engine shape): a content-addressed disk cache under
// .argus/cache/narrative-summaries/, the defaultClaudeRunner from ./llm/runner.ts, a mem + disk
// cache. The prompt recipe + version + parser live in ./llm/prompts/summary.ts; this module is the
// ENGINE (cache + runner). Re-exported so import sites (routes.ts, the tests) stay unchanged.
//
// LOCKED ARCHITECTURE (workpads/narrative/tasks.md §M4):
//   - Summaries are a SEPARATE async layer — they NEVER block or run inside segmentation/the
//     narrative endpoint. The narrative keeps returning blocks as today.
//   - LAZY / on-demand — generate a block's summary only when the FE asks; cache it (one-time).
//   - HEAD+TAIL ONLY input — the block's already-bounded previews, never full turns / raw transcript.
//   - DEGRADE — when `claude` is absent/errs, return unavailable/null; the FE keeps the baseline.
//
// Security/privacy (boundaries.md §4): the input is the user's OWN local content passed to their OWN
// local `claude` auth — never copied off-machine. The cache lives under gitignored .argus/. NEVER
// throws (a cache read/write failure or a runner error degrades to unavailable/null).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { NarrativeSummary } from '@argus/contract';
import { defaultClaudeRunner, type ClaudeRunner } from './llm/runner.ts';
// The summary prompt + its version + the parser live in ./llm/prompts/summary.ts; this module is the
// ENGINE (cache + runner). Re-exported so existing import sites (routes.ts, the tests) are unchanged.
import {
  SUMMARY_PROMPT_VERSION,
  buildSummaryPrompt,
  parseSummary,
  hashSummaryInput,
  type SummaryInput,
} from './llm/prompts/summary.ts';
export { SUMMARY_PROMPT_VERSION, buildSummaryPrompt, parseSummary, hashSummaryInput };
export type { SummaryInput };

/** The on-disk shape of a cached narrative-summary entry. */
interface CachedSummary {
  summary: NarrativeSummary;
  version: string;
}

/** ready = generated/cached; unavailable = claude absent/errored; error = bad/empty output. */
export type NarrativeSummaryStatus = 'ready' | 'unavailable' | 'error';

/** The on-demand narrative-summary engine: content-addressed disk cache + a `claude -p` runner. */
export class NarrativeSummaryEngine {
  private readonly runner: ClaudeRunner;
  private readonly dirAbs: string;
  private readonly mem = new Map<string, NarrativeSummary>();

  constructor(opts: { cacheDir: string; runner?: ClaudeRunner }) {
    this.runner = opts.runner ?? defaultClaudeRunner();
    this.dirAbs = resolve(opts.cacheDir);
  }

  /** Content-addressed key: sha256(stable input projection + SUMMARY_PROMPT_VERSION). */
  private keyFor(input: SummaryInput): string {
    return hashSummaryInput(input);
  }
  private pathFor(hash: string): string | null {
    if (!/^[0-9a-f]{64}$/.test(hash)) return null;
    const p = resolve(this.dirAbs, `${hash}.json`);
    return p === this.dirAbs || p.startsWith(this.dirAbs + '/') ? p : null;
  }

  /**
   * Generate (or cache-hit) the summary for ONE block's bounded head+tail input. On-demand only
   * (the FE asks per block); the 2nd call for the same input is a memory/disk cache hit (one-time).
   * NEVER throws — claude absent/errors → `unavailable`; an unparseable reply → `error` (the FE
   * keeps the baseline either way).
   */
  async generate(
    input: SummaryInput,
  ): Promise<{ status: NarrativeSummaryStatus; summary: NarrativeSummary | null }> {
    const hash = this.keyFor(input);
    const mem = this.mem.get(hash);
    if (mem) return { status: 'ready', summary: mem };

    const p = this.pathFor(hash);
    if (p) {
      try {
        const c = JSON.parse(await readFile(p, 'utf8')) as CachedSummary;
        if (c && c.version === SUMMARY_PROMPT_VERSION && c.summary && c.summary.caption) {
          this.mem.set(hash, c.summary);
          return { status: 'ready', summary: c.summary };
        }
      } catch {
        /* miss */
      }
    }

    let raw: string | null = null;
    try {
      raw = await this.runner(buildSummaryPrompt(input));
    } catch {
      raw = null;
    }
    if (raw === null) return { status: 'unavailable', summary: null };
    const summary = parseSummary(raw);
    if (!summary) return { status: 'error', summary: null };
    this.mem.set(hash, summary);
    if (p) {
      try {
        await mkdir(this.dirAbs, { recursive: true });
        await writeFile(
          p,
          JSON.stringify({ summary, version: SUMMARY_PROMPT_VERSION } satisfies CachedSummary),
          'utf8',
        );
      } catch {
        /* cache-write failure is non-fatal */
      }
    }
    return { status: 'ready', summary };
  }
}

/** The default narrative-summary cache dir (sibling of the explanations / subui caches). */
export function narrativeSummaryCacheDir(repoRoot: string): string {
  return resolve(repoRoot, '.argus', 'cache', 'narrative-summaries');
}
