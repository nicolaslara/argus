// @argus/web — the node DETAIL PANEL (inspect I1). A right-hand panel filled INSTANTLY
// from the clicked node's `data` (no fetch — I1 plumbed the full AgentNode scalars +
// plan-node fields onto node.data; boundaries §7 "filled from card data"). Reachable
// from all three views (Execution / Plan / Morph). Closes on the × button or a pane click.
//
// ALL text is rendered as React text nodes (never dangerouslySetInnerHTML): previews /
// results / labels can echo the user's own run content (boundaries §4).

import { memo, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Node } from '@xyflow/react';
import { fetchAgentResult, fetchSubUi } from '../api.ts';
import { GenerativePanel } from './GenerativePanel.tsx';

interface Preview {
  text: string;
  truncated: boolean;
}

function isPreview(v: unknown): v is Preview {
  return !!v && typeof v === 'object' && typeof (v as Preview).text === 'string';
}

// R1: render an agent's prompt/result HUMAN-READABLY by default; raw JSON behind a toggle.
// A result is a string (text agent) or an object (schema agent). We show a readable view
// (prose, or a key→value table for an object) and let advanced users flip to raw JSON.
type Readable = { kind: 'json'; value: unknown } | { kind: 'prose'; text: string };
function tryReadable(v: unknown): Readable {
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
function scalar(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.length} ${v.length === 1 ? 'item' : 'items'}]`;
  if (typeof v === 'object') return `{${Object.keys(v as object).length} fields}`;
  return String(v);
}
function JsonReadable({ value }: { value: unknown }) {
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
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}

function fmtDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60).toString().padStart(2, '0')}s`;
}
function fmtTime(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

function Row({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className="detail-row">
      <span className="detail-row-label">{label}</span>
      <span className="detail-row-value">{String(value)}</span>
    </div>
  );
}

function PreviewBlock({
  label,
  preview,
  full,
  loading,
}: {
  label: string;
  preview: unknown;
  /** The lazily-fetched FULL value (string or object); undefined = not fetched. */
  full?: unknown;
  loading?: boolean;
}) {
  const [raw, setRaw] = useState(false);
  const pv = isPreview(preview) ? preview : null;
  const hasFull = full !== undefined && full !== null;
  const source: unknown = hasFull ? full : (pv?.text ?? '');
  const readable = useMemo(() => tryReadable(source), [source]);
  if (!pv && !hasFull) return null;

  const truncated = !hasFull && !!pv?.truncated; // a capped preview; the full value isn't truncated
  const rawText = readable.kind === 'json' ? JSON.stringify(readable.value, null, 2) : readable.text;
  return (
    <div className="detail-block">
      <div className="detail-block-label">
        {label}
        {loading ? <span className="detail-trunc detail-loading">loading…</span> : null}
        {truncated ? <span className="detail-trunc">preview</span> : null}
        {readable.kind === 'json' ? (
          <button type="button" className="detail-toggle" onClick={() => setRaw((v) => !v)}>
            {raw ? '◧ readable' : '{ } json'}
          </button>
        ) : null}
      </div>
      {readable.kind === 'json' && !raw ? (
        <JsonReadable value={readable.value} />
      ) : (
        <pre className="detail-pre">{rawText || '—'}</pre>
      )}
    </div>
  );
}

export const DetailPanel = memo(function DetailPanel({
  node,
  runRef,
  onClose,
}: {
  node: Node | null;
  /** The current run's ref — lets an execution agent lazily fetch its FULL result (R1). */
  runRef?: { slug: string; sessionId: string; runId: string } | null;
  onClose: () => void;
}) {
  // Hooks must run unconditionally (before the early return). Derive from a possibly-null node.
  const dMaybe = (node?.data ?? {}) as Record<string, unknown>;
  const isAgent = (node?.type ?? '') === 'agentCard';
  const agentId = isAgent ? str(dMaybe.agentId) : null;
  const resultQ = useQuery({
    queryKey: ['agent-result', runRef?.slug, runRef?.sessionId, runRef?.runId, agentId],
    queryFn: () => fetchAgentResult(runRef!, agentId!),
    enabled: !!node && !!runRef && !!agentId,
    staleTime: Infinity,
  });
  // #9: a Claude-generated sub-UI for this result — opt-in (spends a claude call), cached.
  const [showSubUi, setShowSubUi] = useState(false);
  const subUiQ = useQuery({
    queryKey: ['subui', runRef?.slug, runRef?.sessionId, runRef?.runId, agentId],
    queryFn: () => fetchSubUi(runRef!, agentId!),
    enabled: !!node && !!runRef && !!agentId && showSubUi,
    staleTime: Infinity,
  });

  if (!node) return null;
  const d = node.data as Record<string, unknown>;
  const type = node.type ?? 'node';

  // Title: prefer the fullest label we have. Plan agents carry the authored template in
  // `labelRaw` ("research:${r.key}") — richer than the static-prefix `title` the card splits
  // out; exec agents carry the concrete `label` ("research:modal-rs-surface") and no labelRaw.
  const title =
    str(d.labelRaw) ?? str(d.label) ?? str(d.title) ?? str(d.conditionLabel) ?? type;
  const caption = str(d.caption) ?? str(d.subtitle);
  // PX-fit: the panel is the canonical EXPAND surface — it shows the FULL caption (the
  // node clamps to 2 lines). Surface its provenance: a baseline (deterministic) caption vs
  // an LLM-enriched one (overlayExplanations stamps captionSource:'llm' + an optional
  // short patternName) so "✨ llm" reads as a real explanation, not just the label echo.
  const captionLlm = str(d.captionSource) === 'llm';
  const captionPattern = str(d.captionPattern);

  // A run agent (execution) vs a plan node — both filled from node.data.
  const isExecAgent = type === 'agentCard';

  // Morph binding (paintOverlay stamps these onto plan nodes in overlay mode).
  const bindStatus = str(d.bindStatus) ?? str(d.status);
  const succeeded = num(d.succeeded);
  const total = d.total === 'N' ? 'N' : num(d.total);
  const failed = num(d.failed);

  return (
    <aside className="detail-panel" role="complementary" aria-label="node detail">
      <div className="detail-panel-head">
        <span className="detail-kind">{type.replace(/^plan/, 'plan ')}</span>
        <button type="button" className="detail-close" onClick={onClose} aria-label="close">
          ×
        </button>
      </div>
      <div className="detail-title" title={str(d.labelRaw) ?? title}>
        {title}
      </div>
      {caption ? (
        <div className="detail-explain">
          <div className="detail-block-label">
            explanation
            {captionPattern ? <span className="detail-pattern">{captionPattern}</span> : null}
            <span className={`detail-cap-source detail-cap-${captionLlm ? 'llm' : 'baseline'}`}>
              {captionLlm ? '✨ llm' : 'baseline'}
            </span>
          </div>
          <div className="detail-caption">{caption}</div>
        </div>
      ) : null}

      <div className="detail-rows">
        {isExecAgent ? (
          <>
            <Row label="state" value={str(d.state)} />
            <Row label="model" value={str(d.model)} />
            <Row label="duration" value={fmtDuration(num(d.durationMs))} />
            <Row label="tokens" value={num(d.tokens) === 0 ? '— (0)' : num(d.tokens)} />
            <Row label="tools" value={num(d.toolCalls)} />
            <Row label="attempt" value={num(d.attempt)} />
            <Row label="last tool" value={str(d.lastToolName)} />
            <Row label="queued" value={fmtTime(num(d.queuedAt))} />
            <Row label="started" value={fmtTime(num(d.startedAt))} />
            {d.cached === true ? <Row label="cached" value="yes (resume)" /> : null}
            {d.failedInLogs === true ? <Row label="flagged" value="failed in logs" /> : null}
          </>
        ) : (
          <>
            <Row label="kind" value={type.replace(/^plan/, '')} />
            {d.typed === true ? <Row label="schema" value="typed (StructuredOutput)" /> : null}
            {d.optional === true ? <Row label="optional" value="yes" /> : null}
            <Row label="confidence" value={str(d.confidence)} />
            {str(d.conditionLabel) ? <Row label="condition" value={str(d.conditionLabel)} /> : null}
            {str(d.stopCondition) ? <Row label="stop" value={str(d.stopCondition)} /> : null}
            {bindStatus ? <Row label="run status" value={bindStatus} /> : null}
            {succeeded !== null && total !== null ? (
              <Row label="instances" value={`${succeeded}/${total} done${failed ? ` · ${failed} failed` : ''}`} />
            ) : null}
          </>
        )}
      </div>

      <PreviewBlock label="prompt" preview={d.promptPreview} />
      <PreviewBlock
        label="result"
        preview={d.resultPreview}
        full={resultQ.data?.value}
        loading={!!agentId && resultQ.isFetching && resultQ.data === undefined}
      />

      {/* #9: a Claude-generated, tailored panel for this result (opt-in, cached). */}
      {agentId && resultQ.data?.value != null ? (
        <div className="detail-block">
          <div className="detail-block-label">
            generated panel
            <button type="button" className="detail-toggle" onClick={() => setShowSubUi((v) => !v)}>
              {showSubUi ? 'hide' : '✨ generate'}
            </button>
          </div>
          {showSubUi ? (
            subUiQ.isFetching && !subUiQ.data ? (
              <div className="detail-summary">generating a tailored panel…</div>
            ) : subUiQ.data?.status === 'ready' && subUiQ.data.spec ? (
              <GenerativePanel spec={subUiQ.data.spec} />
            ) : (
              <div className="detail-summary">
                {subUiQ.data?.status === 'unavailable'
                  ? 'claude unavailable — the readable result above is the fallback'
                  : 'could not generate a panel for this result'}
              </div>
            )
          ) : null}
        </div>
      ) : null}
    </aside>
  );
});
