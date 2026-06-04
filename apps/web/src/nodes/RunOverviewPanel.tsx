// @argus/web — the RUN OVERVIEW panel (inspect I3). A right-hand panel for the WHOLE run
// (vs. DetailPanel's single node): run status/totals, the run-level error, the partial-
// failure line(s), and the narrator `log()` TIMELINE — the workflow's own running
// commentary ("Research complete: 7/7…", "Synthesis verdict: plan-is-sound"). Opened by
// clicking the run-header name; node selection takes precedence (DetailPanel).
//
// Reuses the `.detail-*` panel CSS. ALL text rendered as React text nodes (logs/errors/
// summaries can echo the user's own run content — boundaries §4). Returns null if no run.

import { memo } from 'react';
import type { RunModel } from '@argus/contract';

function fmtDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
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

export const RunOverviewPanel = memo(function RunOverviewPanel({
  run,
  onClose,
}: {
  run: RunModel | null;
  onClose: () => void;
}) {
  if (!run) return null;
  // The failure line(s) also appear in logs[]; flag those rows so the timeline reads honestly.
  const failureSet = new Set(run.partialFailure.lines);
  const doneCount = run.agents.filter((a) => a.state === 'done').length;

  return (
    <aside className="detail-panel" role="complementary" aria-label="run overview">
      <div className="detail-panel-head">
        <span className="detail-kind">run{run.incomplete ? ' · live' : ''}</span>
        <button type="button" className="detail-close" onClick={onClose} aria-label="close">
          ×
        </button>
      </div>
      <div className="detail-title">{run.workflowName || 'workflow run'}</div>
      {run.summary ? <div className="detail-caption">{run.summary}</div> : null}

      <div className="detail-rows">
        <Row label="status" value={run.status} />
        <Row label="agents" value={run.incomplete ? `${doneCount}/${run.agents.length} done` : run.agents.length} />
        <Row label="phases" value={run.phases.length} />
        <Row label="default model" value={run.defaultModel} />
        <Row label="duration" value={fmtDuration(run.durationMs)} />
        <Row label="started" value={fmtTime(run.startTime)} />
      </div>

      {run.error ? (
        <div className="detail-block">
          <div className="detail-block-label">error</div>
          <pre className="detail-pre">{run.error.message}</pre>
        </div>
      ) : null}

      {run.partialFailure.present ? (
        <div className="detail-block">
          <div className="detail-block-label">
            partial failure
            <span className="detail-trunc">{run.partialFailure.lines.length}</span>
          </div>
          {run.partialFailure.lines.map((l, i) => (
            <div key={i} className="detail-log detail-log-fail">
              {l}
            </div>
          ))}
        </div>
      ) : null}

      {run.logs.length > 0 ? (
        <div className="detail-block">
          <div className="detail-block-label">narrator log · {run.logs.length}</div>
          <ol className="detail-log-list">
            {run.logs.map((l, i) => (
              <li key={i} className={`detail-log${failureSet.has(l) ? ' detail-log-fail' : ''}`}>
                {l}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </aside>
  );
});
