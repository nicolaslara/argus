// @argus/web — RunHistory: the shared "list of runs" surface, used in TWO places for the
// SAME data + rows (one component, two placements):
//   1. the run SELECTOR drawer (run-detail-plan §1.1) — pick which run of a workflow to view;
//   2. the Plan view's run HISTORY overview (run-view-merge-plan §7b) — a plan has many runs,
//      so the blueprint page also lists this workflow's runs.
//
// Purely presentational: NO fetch / no query. The caller passes the already-loaded runs
// (App.tsx's runsQ) and owns selection. Rows mirror the rail's finished run-row look
// (Rail.tsx RunRow): a status glyph (●/◐/✕/◼/◌ via statusGlyph; running pulses) + a relative
// time + `{agentCount}ag · {dur}`. Newest-first by startTime. Reuses shell/format.ts so the
// glyph/duration/relative-time read identically to the sidebar tree.
//
// All labels are React text nodes; consumes ONLY @argus/contract types (no node:* import).

import { memo, useMemo } from 'react';
import type { RunSummary } from '@argus/contract';
import { formatDuration, formatRelativeTime, statusGlyph } from '../shell/format.ts';

interface RunHistoryProps {
  runs: RunSummary[];
  selectedRunId?: string;
  onSelectRun: (r: RunSummary) => void;
  title?: string;
}

/** Newest-first by startTime; runs without a startTime sort last (stable). */
function runsNewestFirst(runs: RunSummary[]): RunSummary[] {
  return [...runs].sort((a, b) => (b.startTime ?? -Infinity) - (a.startTime ?? -Infinity));
}

export const RunHistory = memo(function RunHistory({
  runs,
  selectedRunId,
  onSelectRun,
  title,
}: RunHistoryProps) {
  const ordered = useMemo(() => runsNewestFirst(runs), [runs]);

  return (
    <section className="run-history" aria-label={title ?? 'runs'}>
      {title ? (
        <header className="run-history-head">
          <span className="run-history-title">{title}</span>
          <span className="run-history-count">{ordered.length}</span>
        </header>
      ) : null}
      {ordered.length === 0 ? (
        <div className="run-history-empty">no runs yet</div>
      ) : (
        <ul className="run-history-list">
          {ordered.map((r) => (
            <RunHistoryRow
              key={`${r.ref.sessionId}/${r.ref.runId}`}
              run={r}
              active={r.ref.runId === selectedRunId}
              onSelect={onSelectRun}
            />
          ))}
        </ul>
      )}
    </section>
  );
});

/** One run row: status glyph (running pulses) + relative time + `{agentCount}ag · {dur}`. */
const RunHistoryRow = memo(function RunHistoryRow({
  run: r,
  active,
  onSelect,
}: {
  run: RunSummary;
  active: boolean;
  onSelect: (r: RunSummary) => void;
}) {
  const running = r.status === 'running';
  const time = formatRelativeTime(r.startTime);
  return (
    <li>
      <button
        type="button"
        className={`run-history-row${active ? ' is-active' : ''}`}
        onClick={() => onSelect(r)}
        aria-pressed={active}
        title={`${r.workflowName || r.ref.runId} · ${r.status}`}
      >
        <span
          className={`run-history-status status-${r.status}${r.partialFailure ? ' is-partial' : ''}${running ? ' run-history-status-running' : ''}`}
          aria-hidden="true"
        >
          {statusGlyph(r.status, r.partialFailure)}
        </span>
        <span className="run-history-time">{time || '—'}</span>
        <span className="run-history-meta">
          <span className="run-history-agents">{r.agentCount}ag</span>
          <span className="run-history-dot" aria-hidden="true">·</span>
          <span className="run-history-dur">{formatDuration(r.durationMs)}</span>
        </span>
      </button>
    </li>
  );
});
