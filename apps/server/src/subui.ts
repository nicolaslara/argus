// @argus/server — Generative sub-UI engine (#9). Claude builds a TAILORED rendering for a
// node's result: it emits a CONSTRAINED "panel spec" (sections from a fixed vocabulary),
// which the web renders with trusted React components (all values as text nodes). The LLM
// never emits executable markup, so there is NO injection surface — this is "generative UI"
// with the safety of a fixed grammar. Generated on demand, content-addressed-cached.
//
// Reuses the `claude -p` runner + the disk-cache shape from explain.ts. Degrades to
// `unavailable` when claude is absent (the web falls back to R1's readable result view).

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { PanelSpec, SubUiStatus } from '@argus/contract';
import { defaultClaudeRunner, type ClaudeRunner } from './llm/runner.ts';
import { DiskCache } from './llm/cache.ts';
// The panel prompt + its strict validator now live in ./llm/prompts/panel.ts; this module is the
// ENGINE (cache + runner). Re-exported so existing import sites (routes.ts, the tests) are unchanged.
import { SUBUI_PROMPT_VERSION, buildSubUiPrompt, parseSubUiSpec } from './llm/prompts/panel.ts';
export { SUBUI_PROMPT_VERSION, buildSubUiPrompt, parseSubUiSpec };

interface CachedPanel {
  spec: PanelSpec;
  version: string;
}

/** The on-demand sub-UI engine: content-addressed disk cache + a `claude -p` runner. */
export class SubUiEngine {
  private readonly runner: ClaudeRunner;
  private readonly cache: DiskCache<CachedPanel>;
  private readonly mem = new Map<string, PanelSpec>();

  constructor(opts: { cacheDir: string; runner?: ClaudeRunner }) {
    this.runner = opts.runner ?? defaultClaudeRunner();
    this.cache = new DiskCache<CachedPanel>(opts.cacheDir);
  }

  private keyFor(result: unknown): string {
    return createHash('sha256').update(JSON.stringify(result) + SUBUI_PROMPT_VERSION).digest('hex');
  }

  /** Generate (or cache-hit) the panel for one result. NEVER throws. */
  async generate(result: unknown): Promise<{ status: SubUiStatus; spec: PanelSpec | null }> {
    if (result === null || result === undefined) return { status: 'error', spec: null };
    const hash = this.keyFor(result);
    const mem = this.mem.get(hash);
    if (mem) return { status: 'ready', spec: mem };

    const c = await this.cache.read(hash);
    if (c && c.version === SUBUI_PROMPT_VERSION && c.spec) {
      this.mem.set(hash, c.spec);
      return { status: 'ready', spec: c.spec };
    }

    let raw: string | null = null;
    try {
      raw = await this.runner(buildSubUiPrompt(result));
    } catch {
      raw = null;
    }
    if (raw === null) return { status: 'unavailable', spec: null };
    const spec = parseSubUiSpec(raw);
    if (!spec) return { status: 'error', spec: null };
    this.mem.set(hash, spec);
    await this.cache.write(hash, { spec, version: SUBUI_PROMPT_VERSION });
    return { status: 'ready', spec };
  }
}

/** The default sub-UI cache dir (sibling of the explanations cache). */
export function subUiCacheDir(repoRoot: string): string {
  return resolve(repoRoot, '.argus', 'cache', 'subui');
}
