// @argus/web — the TRANSCRIPT READER overlay (the full top-to-bottom read of ONE agent).
// transcript-reader: a focused, calm, centered modal reachable from the DetailPanel's
// "open full ⤢" affordance. It reads a single agent in sequence — a sticky header
// (label · status · tokens · duration), the PROMPT verbatim, the TOOL TIMELINE in order
// (each event + its elapsed offset), then the RESULT (readable, with a raw toggle).
//
// REUSE-ONLY: it takes the ALREADY-FETCHED activity + result as props (no new endpoint /
// no fetch) and renders with the SAME helpers DetailPanel uses (transcriptHelpers). All
// text is plain React text nodes (never dangerouslySetInnerHTML; boundaries §4).

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AgentActivity, AgentTimelineEntry } from '@argus/contract';
import {
  ReadableBody,
  clockTime,
  fmtDuration,
  relTime,
  totalTokens,
  tryReadable,
} from './transcriptHelpers.tsx';

export interface TranscriptReaderProps {
  /** The already-fetched transcript activity for this agent (prompt + timeline + tokens). */
  activity: AgentActivity | undefined;
  /** The already-fetched FULL result value (string or object); undefined = none/unfetched. */
  result: unknown;
  resultTruncated?: boolean;
  /** Best display label (DetailPanel's resolved title) — a real task, not a hash. */
  title: string;
  /** The agent's run state (running / done / failed …) for the header status. */
  status: string | null;
  onClose: () => void;
}

/** A compact metadata chip in the sticky header (status · tokens · duration). */
function HeadChip({ label, value, tone }: { label: string; value: string; tone?: 'fail' | 'live' }) {
  return (
    <span className={`tr-chip${tone ? ` tr-chip-${tone}` : ''}`}>
      <span className="tr-chip-label">{label}</span>
      <span className="tr-chip-value">{value}</span>
    </span>
  );
}

export function TranscriptReader({
  activity,
  result,
  resultTruncated,
  title,
  status,
  onClose,
}: TranscriptReaderProps) {
  const [rawResult, setRawResult] = useState(false);

  // Esc closes (calm, expected). Registered once for the lifetime of the overlay.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const prompt = typeof activity?.prompt === 'string' ? activity.prompt : '';
  const timeline = activity?.timeline ?? [];
  const baseMs = activity?.startedAt ? Date.parse(activity.startedAt) : null;
  const tokens = activity ? totalTokens(activity) : null;
  const duration = fmtDuration(activity?.durationMs ?? null);
  const last = activity?.error ?? activity?.lastText;
  const lastIsError = !!activity?.error;
  const isLive = status === 'running' || status === 'queued';

  const hasResult = result !== undefined && result !== null && (typeof result !== 'string' || result.length > 0);
  const readable = useMemo(() => tryReadable(result), [result]);

  const body = (
    <div className="transcript-reader-backdrop" onClick={onClose} role="presentation">
      <div
        className="transcript-reader"
        role="dialog"
        aria-modal="true"
        aria-label={`transcript — ${title}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* sticky header — label · status · tokens · duration */}
        <div className="transcript-reader-head">
          <div className="tr-head-row">
            <div className="tr-title" title={title}>
              {title}
            </div>
            <button type="button" className="tr-close" onClick={onClose} aria-label="close">
              ×
            </button>
          </div>
          <div className="tr-chips">
            {status ? (
              <HeadChip label="status" value={status} tone={lastIsError ? 'fail' : isLive ? 'live' : undefined} />
            ) : null}
            {tokens !== null ? <HeadChip label="tokens" value={tokens.toLocaleString()} /> : null}
            {duration ? <HeadChip label="duration" value={duration} /> : null}
            {activity?.toolCalls ? <HeadChip label="tools" value={String(activity.toolCalls)} /> : null}
          </div>
        </div>

        <div className="transcript-reader-body">
          {/* PROMPT — the verbatim task handed to the agent. */}
          <section className="tr-section">
            <div className="tr-section-label">prompt</div>
            {prompt.trim().length > 0 ? (
              <pre className="detail-pre tr-prompt">{prompt}</pre>
            ) : (
              <div className="detail-uncaptured">not captured — the run journal didn’t record a prompt</div>
            )}
          </section>

          {/* TOOL TIMELINE — every tool_use / text turn in sequence, with elapsed offset. */}
          <section className="tr-section">
            <div className="tr-section-label">
              timeline
              {timeline.length > 0 ? <span className="tr-section-count">{timeline.length}</span> : null}
            </div>
            {timeline.length > 0 ? (
              <ol className="tr-timeline">
                {timeline.map((e: AgentTimelineEntry, i) => {
                  const rel = relTime(e.t, baseMs);
                  const clock = clockTime(e.t);
                  return (
                    <li key={i} className="tr-timeline-row">
                      <span className="tr-timeline-time" title={clock ?? e.t}>
                        {rel ?? clock ?? '—'}
                      </span>
                      <span className={`tr-timeline-kind tr-timeline-${e.kind}`}>
                        {e.kind === 'tool' ? (e.name ?? 'tool') : 'text'}
                      </span>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <div className="detail-uncaptured">no tool activity recorded</div>
            )}
            {/* the last activity — running = what's happening now; failed = the final error line. */}
            {last ? (
              <div className={lastIsError ? 'detail-log-fail tr-last' : 'detail-summary tr-last'}>{last}</div>
            ) : null}
          </section>

          {/* RESULT — readable by default, raw JSON behind a toggle. */}
          <section className="tr-section">
            <div className="tr-section-label">
              result
              {resultTruncated ? <span className="detail-trunc">truncated</span> : null}
              {hasResult && readable.kind === 'json' ? (
                <button type="button" className="detail-toggle" onClick={() => setRawResult((v) => !v)}>
                  {rawResult ? '◧ readable' : '{ } json'}
                </button>
              ) : null}
            </div>
            {hasResult ? (
              <ReadableBody readable={readable} raw={rawResult} />
            ) : (
              <div className="detail-uncaptured">
                {isLive ? 'no result yet — this agent is still running' : 'not captured — no result recorded'}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );

  // Render at <body> so the overlay sits above the whole canvas / panels, regardless of where
  // the trigger lives in the tree.
  return createPortal(body, document.body);
}
