// @argus/web — the node DETAIL PANEL (inspect I1). A right-hand panel filled INSTANTLY
// from the clicked node's `data` (no fetch — I1 plumbed the full AgentNode scalars +
// plan-node fields onto node.data; boundaries §7 "filled from card data"). Reachable
// from all three views (Execution / Plan / Morph). Closes on the × button or a pane click.
//
// ALL text is rendered as React text nodes (never dangerouslySetInnerHTML): previews /
// results / labels can echo the user's own run content (boundaries §4).

import { memo } from 'react';
import type { Node } from '@xyflow/react';

interface Preview {
  text: string;
  truncated: boolean;
}

function isPreview(v: unknown): v is Preview {
  return !!v && typeof v === 'object' && typeof (v as Preview).text === 'string';
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

function PreviewBlock({ label, preview }: { label: string; preview: unknown }) {
  if (!isPreview(preview)) return null;
  return (
    <div className="detail-block">
      <div className="detail-block-label">
        {label}
        {preview.truncated ? <span className="detail-trunc">truncated</span> : null}
      </div>
      <pre className="detail-pre">{preview.text || '—'}</pre>
    </div>
  );
}

export const DetailPanel = memo(function DetailPanel({
  node,
  onClose,
}: {
  node: Node | null;
  onClose: () => void;
}) {
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
      <PreviewBlock label="result" preview={d.resultPreview} />
    </aside>
  );
});
