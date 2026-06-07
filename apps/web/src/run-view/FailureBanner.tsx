import { useState } from 'react';
import type { AgentFailureCause } from '@argus/contract';
import { formatElapsed } from '../shell/format.ts';
import type { FailureInfo } from '../failure-info.ts';

/**
 * STEP 3 — the calm, collapsible failure banner. Lives in the Run-view chrome (below the
 * run-header, never in the sidebar). Shows the failure reason + elapsed-to-failure + the
 * failing step/agent; a 'Details ▾' disclosure reveals run.error.internalDetail (the raw
 * stack) BEHIND A CLICK — never raw by default. Renders nothing when the run did not fail.
 *
 * `cause` (when resolved from the failing agent's transcript) gives the ACCURATE reason: the
 * run model only ever reports "completed without calling StructuredOutput", which is ~96%
 * misleading — the real cause is usually an INFRA drop (socket/limit/overload), not the model.
 * So we lead with the classified cause and demote the raw report to "reported as: …".
 *
 * Extracted from App.tsx (behavior-preserving, props-in/JSX-out).
 */
export function FailureBanner({ info, cause }: { info: FailureInfo; cause?: AgentFailureCause | null }) {
  const [open, setOpen] = useState(false);
  const elapsed = formatElapsed(info.elapsedMs);
  const modeWord = cause ? (cause.mode === 'infra' ? 'infra' : cause.mode === 'model' ? 'workflow' : 'cause') : null;
  return (
    <div className="run-failure-banner" role="alert">
      <div className="run-failure-head">
        <span className="run-failure-glyph" aria-hidden="true">⛔</span>
        <span className="run-failure-title">run failed</span>
        {info.failingLabel ? (
          <span className="run-failure-at" title="the step/agent that ended without a terminal result">
            at <code>{info.failingLabel}</code>
          </span>
        ) : null}
        {elapsed ? <span className="run-failure-elapsed">after {elapsed}</span> : null}
      </div>
      {cause ? (
        <div
          className={`run-failure-cause run-failure-cause-${cause.mode}`}
          title={
            cause.mode === 'infra'
              ? 'classified from the failing agent’s transcript — an environment failure, not the model'
              : 'classified from the failing agent’s transcript'
          }
        >
          <span className="run-failure-cause-tag">{modeWord}</span>
          <span className="run-failure-cause-label">{cause.label}</span>
          {cause.detail ? <span className="run-failure-cause-detail">— {cause.detail}</span> : null}
        </div>
      ) : null}
      <div className="run-failure-msg">{cause ? `reported as: ${info.message}` : info.message}</div>
      {info.internalDetail ? (
        <div className="run-failure-details">
          <button
            type="button"
            className="run-failure-disclosure"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            title="reveal the raw error detail (advanced)"
          >
            Details {open ? '▴' : '▾'}
          </button>
          {open ? <pre className="run-failure-stack">{info.internalDetail}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}
