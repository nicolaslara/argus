// @argus/server — the SUB-UI / DESCRIBE prompt (#9 + inspect I4). The model designs a compact
// READ-ONLY dashboard "panel spec" (a CONSTRAINED grammar) for one agent's result OR a whole-run
// digest; the web renders it with trusted components (all values text nodes → no injection). This
// file owns the prompt recipe + version + the STRICT off-grammar validator, so iterating on the
// layout vocabulary / wording is a single-file change. The engine (cache + runner) lives in
// ../../subui.ts and consumes this.

import type { PanelSpec, PanelSection, CalloutTone } from '@argus/contract';

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
