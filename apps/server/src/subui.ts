// @argus/server — Generative sub-UI engine (#9). Claude builds a TAILORED rendering for a
// node's result: it emits a CONSTRAINED "panel spec" (sections from a fixed vocabulary),
// which the web renders with trusted React components (all values as text nodes). The LLM
// never emits executable markup, so there is NO injection surface — this is "generative UI"
// with the safety of a fixed grammar. Generated on demand, content-addressed-cached.
//
// Reuses the `claude -p` runner + the disk-cache shape from explain.ts. Degrades to
// `unavailable` when claude is absent (the web falls back to R1's readable result view).

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PanelSpec, PanelSection, CalloutTone, SubUiStatus } from '@argus/contract';
import { defaultClaudeRunner, type ClaudeRunner } from './explain.ts';

/** Bump to bust ALL cached panels when the prompt/grammar changes. */
export const SUBUI_PROMPT_VERSION = 'subui-v2';

const CALLOUT_TONES: readonly CalloutTone[] = ['info', 'success', 'warn', 'danger'];
const MAX_SECTIONS = 12;
const MAX_ITEMS = 40;
const MAX_ROWS = 40;
const MAX_COLS = 8;
const MAX_STR = 2000;

/** Coerce any leaf to a capped plain string (text-node safe). */
function s(v: unknown): string {
  const str = typeof v === 'string' ? v : v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return str.length > MAX_STR ? str.slice(0, MAX_STR) + '…' : str;
}

/** Build the prompt: emit ONLY a PanelSpec JSON best-presenting the result as a panel. */
export function buildSubUiPrompt(result: unknown): string {
  const resultText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  return [
    'You design a compact READ-ONLY dashboard panel that best presents the given Claude Code',
    'workflow CONTENT — either one agent\'s result, or a whole-run digest (describe what the',
    'workflow did). Choose the clearest layout for THIS content.',
    '',
    'Reply with ONLY a JSON object (no prose, no markdown fences) of this exact shape:',
    '{ "title": string, "sections": Section[] }',
    'where each Section is ONE of:',
    '  { "kind":"callout", "tone":"info|success|warn|danger", "text": string }',
    '  { "kind":"metrics", "items":[{ "label": string, "value": string }] }',
    '  { "kind":"keyvalue", "items":[{ "key": string, "value": string }] }',
    '  { "kind":"list", "ordered": boolean, "items": string[] }',
    '  { "kind":"table", "columns": string[], "rows": string[][] }',
    '  { "kind":"text", "text": string }',
    'Rules: 1-6 sections; lead with a one-line callout summarizing the outcome; surface the',
    'most useful structure (a verdict→metrics→key facts, a findings list, or a comparison',
    'table). Keep strings short. ALL values must be strings. Output JSON ONLY.',
    '',
    'RESULT:',
    resultText.length > 12000 ? resultText.slice(0, 12000) : resultText,
  ].join('\n');
}

/** STRICTLY validate untrusted LLM output into a PanelSpec (drop anything off-grammar). */
export function parseSubUiSpec(raw: string | null): PanelSpec | null {
  if (raw === null) return null;
  // Tolerate accidental ```json fences / leading prose: extract the outermost {...}.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const rawSections = Array.isArray(o.sections) ? o.sections.slice(0, MAX_SECTIONS) : [];
  const sections: PanelSection[] = [];
  for (const rs of rawSections) {
    if (!rs || typeof rs !== 'object') continue;
    const sec = rs as Record<string, unknown>;
    switch (sec.kind) {
      case 'callout': {
        const tone = (CALLOUT_TONES as readonly string[]).includes(sec.tone as string)
          ? (sec.tone as CalloutTone)
          : 'info';
        sections.push({ kind: 'callout', tone, text: s(sec.text) });
        break;
      }
      case 'text':
        sections.push({ kind: 'text', text: s(sec.text) });
        break;
      case 'metrics': {
        const items = (Array.isArray(sec.items) ? sec.items : [])
          .slice(0, MAX_ITEMS)
          .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
          .map((i) => ({ label: s(i.label), value: s(i.value) }));
        if (items.length) sections.push({ kind: 'metrics', items });
        break;
      }
      case 'keyvalue': {
        const items = (Array.isArray(sec.items) ? sec.items : [])
          .slice(0, MAX_ITEMS)
          .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
          .map((i) => ({ key: s(i.key), value: s(i.value) }));
        if (items.length) sections.push({ kind: 'keyvalue', items });
        break;
      }
      case 'list': {
        const items = (Array.isArray(sec.items) ? sec.items : []).slice(0, MAX_ITEMS).map(s);
        if (items.length) sections.push({ kind: 'list', ordered: sec.ordered === true, items });
        break;
      }
      case 'table': {
        const columns = (Array.isArray(sec.columns) ? sec.columns : []).slice(0, MAX_COLS).map(s);
        const rows = (Array.isArray(sec.rows) ? sec.rows : [])
          .slice(0, MAX_ROWS)
          .filter((r): r is unknown[] => Array.isArray(r))
          .map((r) => r.slice(0, MAX_COLS).map(s));
        if (columns.length && rows.length) sections.push({ kind: 'table', columns, rows });
        break;
      }
      default:
        break; // unknown kind → dropped
    }
  }
  if (sections.length === 0) return null;
  return { title: s(o.title) || 'result', sections };
}

interface CachedPanel {
  spec: PanelSpec;
  version: string;
}

/** The on-demand sub-UI engine: content-addressed disk cache + a `claude -p` runner. */
export class SubUiEngine {
  private readonly runner: ClaudeRunner;
  private readonly dirAbs: string;
  private readonly mem = new Map<string, PanelSpec>();

  constructor(opts: { cacheDir: string; runner?: ClaudeRunner }) {
    this.runner = opts.runner ?? defaultClaudeRunner();
    this.dirAbs = resolve(opts.cacheDir);
  }

  private keyFor(result: unknown): string {
    return createHash('sha256').update(JSON.stringify(result) + SUBUI_PROMPT_VERSION).digest('hex');
  }
  private pathFor(hash: string): string | null {
    if (!/^[0-9a-f]{64}$/.test(hash)) return null;
    const p = resolve(this.dirAbs, `${hash}.json`);
    return p === this.dirAbs || p.startsWith(this.dirAbs + '/') ? p : null;
  }

  /** Generate (or cache-hit) the panel for one result. NEVER throws. */
  async generate(result: unknown): Promise<{ status: SubUiStatus; spec: PanelSpec | null }> {
    if (result === null || result === undefined) return { status: 'error', spec: null };
    const hash = this.keyFor(result);
    const mem = this.mem.get(hash);
    if (mem) return { status: 'ready', spec: mem };

    const p = this.pathFor(hash);
    if (p) {
      try {
        const c = JSON.parse(await readFile(p, 'utf8')) as CachedPanel;
        if (c && c.version === SUBUI_PROMPT_VERSION && c.spec) {
          this.mem.set(hash, c.spec);
          return { status: 'ready', spec: c.spec };
        }
      } catch {
        /* miss */
      }
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
    if (p) {
      try {
        await mkdir(this.dirAbs, { recursive: true });
        await writeFile(p, JSON.stringify({ spec, version: SUBUI_PROMPT_VERSION } satisfies CachedPanel), 'utf8');
      } catch {
        /* cache-write failure is non-fatal */
      }
    }
    return { status: 'ready', spec };
  }
}

/** The default sub-UI cache dir (sibling of the explanations cache). */
export function subUiCacheDir(repoRoot: string): string {
  return resolve(repoRoot, '.argus', 'cache', 'subui');
}
