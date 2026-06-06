// @argus/web — the AGENT TABLE panel (roadmap "Table panel"): the at-scale SCANNING surface
// for a selected run. The graph is great for STRUCTURE; a 10-14 agent run is hard to scan by
// cost/time. This is a sortable (clickable column headers, asc/desc) + filterable (substring
// over label/phase/status) table in a COLLAPSIBLE BOTTOM panel, toggled from the run-header.
// Run-view + run-loaded only; clicking a row SELECTS that agent (opens the DetailPanel).
//
// Read-only, contract-only: it renders RunModel.agents (AgentNode[]) + RunModel.phases via the
// PURE ./agent-table.ts lens (sortAgents/filterAgents). ALL text is React text nodes (labels /
// results can echo the user's own run content — boundaries §4). No fetch, no canvas mutation.

import { memo, useMemo, useState } from 'react';
import type { AgentNode, RunModel } from '@argus/contract';
import { STATE_COLOR } from '../nodes/AgentCard.tsx';
import { formatDuration } from '../shell/format.ts';
import {
  filterAgents,
  isFailure,
  phaseTitleOf,
  sortAgents,
  DEFAULT_SORT,
  type SortKey,
  type SortState,
} from './agent-table.ts';

const EM_DASH = '—';

/** tokens: 0/null → em-dash (0-with-tools is activity, not a cost worth comparing — card rule). */
function formatTokens(tokens: number | null): string {
  if (tokens === null || tokens === 0 || !Number.isFinite(tokens)) return EM_DASH;
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** toolCalls: 0/null → em-dash; else the raw count. */
function formatTools(toolCalls: number | null): string {
  if (toolCalls === null || toolCalls === 0 || !Number.isFinite(toolCalls)) return EM_DASH;
  return String(toolCalls);
}

/** The at-a-glance RESULT preview line — first non-empty line of the result, else last tool. */
function resultLine(agent: AgentNode): string | null {
  const candidates = [agent.resultPreview?.text, agent.lastToolSummary];
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue;
    const first = raw.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
    if (first) return first;
  }
  return null;
}

interface Column {
  key: SortKey;
  label: string;
  /** Numeric columns are right-aligned + default to descending on first click. */
  numeric?: boolean;
  title: string;
}

// The 8 sortable columns + an inline (non-sortable) result preview rendered after them.
const COLUMNS: Column[] = [
  { key: 'label', label: 'agent', title: 'the agent task label' },
  { key: 'phase', label: 'phase', title: 'the workflow phase' },
  { key: 'state', label: 'state', title: 'run state' },
  { key: 'model', label: 'model', title: 'the model used' },
  { key: 'tokens', label: 'tok', numeric: true, title: 'tokens (find the most expensive)' },
  { key: 'duration', label: 'dur', numeric: true, title: 'duration (find the slowest)' },
  { key: 'toolCalls', label: 'tools', numeric: true, title: 'tool calls' },
  { key: 'failure', label: 'fail', title: 'failed agents (error or logs-confirmed)' },
];

function HeaderCell({
  col,
  sort,
  onSort,
}: {
  col: Column;
  sort: SortState;
  onSort: (key: SortKey) => void;
}) {
  const active = sort.key === col.key;
  const arrow = !active ? '' : sort.direction === 'asc' ? ' ▲' : ' ▼';
  return (
    <th
      className={`agent-table-th${col.numeric ? ' is-num' : ''}${active ? ' is-active' : ''}`}
      title={col.title}
      aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button type="button" className="agent-table-sort-btn" onClick={() => onSort(col.key)}>
        {col.label}
        <span className="agent-table-arrow" aria-hidden="true">{arrow}</span>
      </button>
    </th>
  );
}

export interface AgentTablePanelProps {
  open: boolean;
  run: RunModel | null;
  onClose: () => void;
  /** Select an agent → opens the DetailPanel for it (App builds the synthetic agentCard node). */
  onSelectAgent: (agent: AgentNode) => void;
  /** The agentId of the row currently open in the DetailPanel (highlighted), if any. */
  selectedAgentId?: string | null;
}

/**
 * The collapsible bottom AGENT TABLE. Renders nothing when closed or when there is no run
 * (Run-view + run-loaded only — App gates the toggle the same way). The sort/filter state is
 * LOCAL to the panel (it's a pure view lens — no app-state coupling, no canvas relayout); the
 * one thing that escapes is `onSelectAgent`, which opens the shared DetailPanel.
 */
export const AgentTablePanel = memo(function AgentTablePanel({
  open,
  run,
  onClose,
  onSelectAgent,
  selectedAgentId,
}: AgentTablePanelProps) {
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [query, setQuery] = useState('');

  const phases = run?.phases;
  const agents = useMemo(() => run?.agents ?? [], [run]);
  const rows = useMemo(() => {
    const filtered = filterAgents(agents, query, phases);
    return sortAgents(filtered, sort.key, sort.direction, phases);
  }, [agents, query, sort, phases]);

  // Toggle the sort: clicking the active column flips direction; a new column starts on its
  // natural default (numeric → desc/biggest-first, text/enum/bool → asc).
  function handleSort(key: SortKey) {
    setSort((prev) => {
      if (prev.key === key) return { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' };
      const numeric = COLUMNS.find((c) => c.key === key)?.numeric ?? false;
      return { key, direction: numeric ? 'desc' : 'asc' };
    });
  }

  if (!open || !run) return null;

  const total = agents.length;
  const shown = rows.length;

  return (
    <div className="agent-table-panel" role="region" aria-label="agent table">
      <div className="agent-table-head">
        <span className="agent-table-title">agents</span>
        <span className="agent-table-count">
          {query.trim() ? `${shown} / ${total}` : `${total}`} {total === 1 ? 'agent' : 'agents'}
        </span>
        <input
          type="search"
          className="agent-table-filter"
          placeholder="filter label / phase / status…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="filter agents"
        />
        <button type="button" className="agent-table-close" onClick={onClose} aria-label="close agent table" title="close">
          ✕
        </button>
      </div>
      <div className="agent-table-scroll">
        <table className="agent-table">
          <thead>
            <tr>
              {COLUMNS.map((col) => (
                <HeaderCell key={col.key} col={col} sort={sort} onSort={handleSort} />
              ))}
              <th className="agent-table-th agent-table-th-result">result</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="agent-table-empty" colSpan={COLUMNS.length + 1}>
                  no agents match “{query.trim()}”
                </td>
              </tr>
            ) : (
              rows.map((agent) => {
                const color = STATE_COLOR[agent.state] ?? STATE_COLOR.unknown;
                const failed = isFailure(agent);
                const preview = resultLine(agent);
                const phaseTitle = phaseTitleOf(agent, phases);
                const isSelected = !!selectedAgentId && agent.agentId === selectedAgentId;
                return (
                  <tr
                    key={`${agent.agentId}-${agent.index}`}
                    className={`agent-table-row${failed ? ' is-failed' : ''}${isSelected ? ' is-selected' : ''}`}
                    onClick={() => onSelectAgent(agent)}
                    tabIndex={0}
                    role="button"
                    title="open this agent"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelectAgent(agent);
                      }
                    }}
                  >
                    <td className="agent-table-td agent-table-td-label" title={agent.label || agent.agentId}>
                      {agent.label || agent.agentId || 'agent'}
                    </td>
                    <td className="agent-table-td" title={phaseTitle ?? ''}>
                      {phaseTitle ?? `phase ${agent.phaseIndex}`}
                    </td>
                    <td className="agent-table-td">
                      <span className="agent-table-state" style={{ color }}>
                        <span className="agent-table-dot" style={{ backgroundColor: color }} aria-hidden="true" />
                        {agent.state}
                      </span>
                    </td>
                    <td className="agent-table-td agent-table-td-model" title={agent.model ?? ''}>
                      {agent.model ?? EM_DASH}
                    </td>
                    <td className="agent-table-td is-num" data-dim={agent.tokens ? 'false' : 'true'}>
                      {formatTokens(agent.tokens)}
                    </td>
                    <td className="agent-table-td is-num" data-dim={agent.durationMs ? 'false' : 'true'}>
                      {formatDuration(agent.durationMs)}
                    </td>
                    <td className="agent-table-td is-num" data-dim={agent.toolCalls ? 'false' : 'true'}>
                      {formatTools(agent.toolCalls)}
                    </td>
                    <td className="agent-table-td agent-table-td-fail">
                      {failed ? <span className="agent-table-fail-flag" title="failed">✕</span> : EM_DASH}
                    </td>
                    <td className="agent-table-td agent-table-td-result" title={preview ?? ''}>
                      {preview ?? EM_DASH}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
});
