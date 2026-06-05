// @argus/web — small SHARED transcript-rendering helpers, extracted from DetailPanel so the
// TranscriptReader overlay (the full top-to-bottom read) reuses the SAME readable renderers /
// formatting rather than duplicating them. Pure presentation: text-only React nodes (never
// dangerouslySetInnerHTML — prompts/results echo the user's own run content; boundaries §4).

import type { AgentActivity } from '@argus/contract';

// R1: render an agent's prompt/result HUMAN-READABLY by default; raw JSON behind a toggle.
// A result is a string (text agent) or an object (schema agent). We show a readable view
// (prose, or a key→value table for an object) and let advanced users flip to raw JSON.
export type Readable = { kind: 'json'; value: unknown } | { kind: 'prose'; text: string };
export function tryReadable(v: unknown): Readable {
  if (v !== null && typeof v === 'object') return { kind: 'json', value: v };
  const text = typeof v === 'string' ? v : v == null ? '' : String(v);
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return { kind: 'json', value: JSON.parse(t) };
    } catch {
      // a TRUNCATED/invalid JSON string → fall back to prose (still readable as text).
      return { kind: 'prose', text };
    }
  }
  return { kind: 'prose', text };
}

/** One-line readable form of a value for a key→value row (nested data summarized). */
export function scalar(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.length} ${v.length === 1 ? 'item' : 'items'}]`;
  if (typeof v === 'object') return `{${Object.keys(v as object).length} fields}`;
  return String(v);
}

export function JsonReadable({ value }: { value: unknown }) {
  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.slice(0, 40).map((v, i) => [String(i), v] as [string, unknown])
    : value && typeof value === 'object'
      ? Object.entries(value as Record<string, unknown>)
      : [];
  if (entries.length === 0) return <div className="detail-summary">{scalar(value)}</div>;
  return (
    <div className="detail-kv">
      {entries.map(([k, v]) => (
        <div key={k} className="detail-kv-row">
          <span className="detail-kv-key">{k}</span>
          <span className="detail-kv-val">{scalar(v)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * R1 — the shared READABLE result body: a key→value table for an object/JSON-string, prose
 * otherwise, with an opt-in raw-JSON view. Used by DetailPanel's result block AND the
 * TranscriptReader's RESULT block so the two never drift. `raw` + `onToggleRaw` are lifted to
 * the caller so the "{ } json / ◧ readable" toggle can live in the block label.
 */
export function ReadableBody({ readable, raw }: { readable: Readable; raw: boolean }) {
  const rawText = readable.kind === 'json' ? JSON.stringify(readable.value, null, 2) : readable.text;
  if (readable.kind === 'json' && !raw) return <JsonReadable value={readable.value} />;
  return <pre className="detail-pre">{rawText || '—'}</pre>;
}

export function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
export function num(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}

export function fmtDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60).toString().padStart(2, '0')}s`;
}
export function fmtTime(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

/** A compact clock label (HH:MM:SS) for a transcript ISO timestamp; null when unparseable. */
export function clockTime(iso: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toLocaleTimeString();
  } catch {
    return null;
  }
}

/**
 * A relative offset (+Ns / +Nm Ss) of a transcript ISO timestamp from a baseline (the agent's
 * first event). Lets the TranscriptReader read the tool TIMELINE as a sequence in elapsed time
 * (e.g. "+0s … +12s … +1m 04s") rather than wall-clock-only. null when unparseable.
 */
export function relTime(iso: string, baseMs: number | null): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || baseMs === null || !Number.isFinite(baseMs)) return null;
  const delta = ms - baseMs;
  if (delta < 0) return null;
  const s = delta / 1000;
  if (s < 60) return `+${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `+${m}m ${Math.round(s % 60).toString().padStart(2, '0')}s`;
}

/** Σ of an activity's token usage (input+output+cacheRead), or null when no usage was seen. */
export function totalTokens(a: AgentActivity): number | null {
  if (!a.tokens) return null;
  return a.tokens.input + a.tokens.output + a.tokens.cacheRead;
}
