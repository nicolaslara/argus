import { useState } from 'react';
import { formatElapsed } from '../shell/format.ts';
import type { FailureInfo } from '../failure-info.ts';

/**
 * STEP 3 — the calm, collapsible failure banner. Lives in the Run-view chrome (below the
 * run-header, never in the sidebar). Shows the failure reason + elapsed-to-failure + the
 * failing step/agent; a 'Details ▾' disclosure reveals run.error.internalDetail (the raw
 * stack) BEHIND A CLICK — never raw by default. Renders nothing when the run did not fail.
 *
 * Extracted from App.tsx (behavior-preserving, props-in/JSX-out).
 */
export function FailureBanner({ info }: { info: FailureInfo }) {
  const [open, setOpen] = useState(false);
  const elapsed = formatElapsed(info.elapsedMs);
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
      <div className="run-failure-msg">{info.message}</div>
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
