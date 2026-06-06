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
import type { AgentNode, Phase, RunModel } from '@argus/contract';
import { STATE_COLOR } from '../nodes/AgentCard.tsx';
import { formatDuration } from '../shell/format.ts';
import {
  filterAgents,
  isFailure,
  orderAgentsByExecution,
  phaseTitleOf,
  sortAgents,
  DEFAULT_SORT,
  type ExecutionOrderRow,
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

/** Total table columns (the 8 sortable + the inline result preview) — for header/empty colspans. */
const COL_COUNT = COLUMNS.length + 1;

/**
 * One AGENT data row, shared by the flat-sort body and the execution-order (DAG) body. `depth`
 * indents it under a phase header in order mode (`data-depth="1"`). A row is HOVERABLE (transient
 * graph glow via onHover) and CLICKABLE (selects → DetailPanel); `selected` (persistent) +
 * `hovered` mirror the matching graph node's highlight so the two surfaces stay in lock-step.
 */
const AgentRow = memo(function AgentRow({
  agent,
  phases,
  depth,
  selected,
  hovered,
  onSelect,
  onHoverEnter,
  onHoverLeave,
}: {
  agent: AgentNode;
  phases: Phase[] | undefined;
  depth?: number;
  selected: boolean;
  hovered: boolean;
  onSelect: (agent: AgentNode) => void;
  onHoverEnter: (agent: AgentNode) => void;
  onHoverLeave: () => void;
}) {
  const color = STATE_COLOR[agent.state] ?? STATE_COLOR.unknown;
  const failed = isFailure(agent);
  const preview = resultLine(agent);
  const phaseTitle = phaseTitleOf(agent, phases);
  return (
    <tr
      className={`agent-table-row${failed ? ' is-failed' : ''}${selected ? ' is-selected' : ''}${hovered ? ' is-hovered' : ''}`}
      data-depth={depth ?? undefined}
      onClick={() => onSelect(agent)}
      onMouseEnter={() => onHoverEnter(agent)}
      onMouseLeave={onHoverLeave}
      tabIndex={0}
      role="button"
      title="open this agent"
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(agent);
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
});

/**
 * A PHASE-GROUPING header row in the execution-order (DAG) view: the phase title + its agent
 * count, flush-left (depth 0). Read-only — NOT clickable, no hover bridge (it maps to no single
 * agent), spans the whole table. The agents that ran in PARALLEL within it follow, indented.
 */
function PhaseHeaderRow({ row }: { row: ExecutionOrderRow }) {
  const title = row.phase?.title || `phase ${row.phase?.index ?? '?'}`;
  const count = row.agentCountInPhase ?? 0;
  return (
    <tr className="agent-table-row is-phase-header" data-depth={0}>
      <td className="agent-table-phase-head" colSpan={COL_COUNT}>
        <span className="agent-table-phase-title">{title}</span>
        <span className="agent-table-phase-count">
          {count} {count === 1 ? 'agent' : 'agents'}
        </span>
      </td>
    </tr>
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
  /** The agentId of the row currently HOVERED (transient graph glow); for the row's own state. */
  hoveredAgentId?: string | null;
  /**
   * HOVER a row → transient cross-highlight on the matching graph node (a soft glow). Fired with
   * the agentId on enter, `null` on leave. PURELY visual — App reads it data-only into the overlay
   * graph; it never opens the DetailPanel or refits the canvas (that's `onSelectAgent`'s job).
   */
  onHoverAgent?: (agentId: string | null) => void;
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
  hoveredAgentId,
  onHoverAgent,
}: AgentTablePanelProps) {
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [query, setQuery] = useState('');

  const phases = run?.phases;
  const agents = useMemo(() => run?.agents ?? [], [run]);
  // "order" is a DAG MODE, not a metric sort: it groups agents by phase (sequential) and indents
  // each phase's agents (parallel) under a header, and it is UNFILTERED — the point of the view is
  // the full structure, so the filter is ignored while in order mode (documented + tested). Every
  // other key is the existing filter→sort flat-agent path.
  const orderMode = sort.key === 'order';
  const rows = useMemo(() => {
    if (sort.key === 'order') return [];
    const filtered = filterAgents(agents, query, phases);
    return sortAgents(filtered, sort.key, sort.direction, phases);
  }, [agents, query, sort, phases]);
  const orderRows = useMemo<ExecutionOrderRow[]>(
    () => (sort.key === 'order' ? orderAgentsByExecution(agents, phases) : []),
    [agents, phases, sort.key],
  );

  // Toggle the sort: clicking the active column flips direction; a new column starts on its
  // natural default (numeric → desc/biggest-first, text/enum/bool → asc). `order` is a MODE with
  // no direction — clicking it just enters the DAG view (re-clicking is an inert no-op, not a flip).
  function handleSort(key: SortKey) {
    setSort((prev) => {
      if (key === 'order') return { key, direction: 'asc' }; // direction unused in order mode
      if (prev.key === key) return { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' };
      const numeric = COLUMNS.find((c) => c.key === key)?.numeric ?? false;
      return { key, direction: numeric ? 'desc' : 'asc' };
    });
  }
  // Hover bridge: enter sets the agentId (transient graph glow), leave clears it. No-op when the
  // parent passes no handler. Never opens the panel — that is the click (onSelectAgent) only.
  const hoverEnter = (agent: AgentNode) => onHoverAgent?.(agent.agentId);
  const hoverLeave = () => onHoverAgent?.(null);

  if (!open || !run) return null;

  const total = agents.length;
  const shown = orderMode ? agents.length : rows.length;

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
          disabled={orderMode}
          title={orderMode ? 'filtering is disabled in execution-order view (full structure)' : undefined}
        />
        {/* Execution-order (DAG) MODE toggle: phases in sequence, parallel agents indented under
            each phase header. A toggle (not a sortable column) — it has no asc/desc direction. */}
        <button
          type="button"
          className={`agent-table-order-toggle${orderMode ? ' is-active' : ''}`}
          aria-pressed={orderMode}
          title="execution order: phases in sequence, parallel agents grouped under each phase"
          onClick={() => handleSort(orderMode ? DEFAULT_SORT.key : 'order')}
        >
          ⇋ order
        </button>
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
            {orderMode ? (
              orderRows.length === 0 ? (
                <tr>
                  <td className="agent-table-empty" colSpan={COL_COUNT}>no agents in this run</td>
                </tr>
              ) : (
                orderRows.map((row, i) =>
                  row.isPhaseHeader ? (
                    <PhaseHeaderRow key={`ph-${row.phase?.index ?? i}`} row={row} />
                  ) : (
                    <AgentRow
                      key={`${row.agent!.agentId}-${row.agent!.index}`}
                      agent={row.agent!}
                      phases={phases}
                      depth={row.depth}
                      selected={!!selectedAgentId && row.agent!.agentId === selectedAgentId}
                      hovered={!!hoveredAgentId && row.agent!.agentId === hoveredAgentId}
                      onSelect={onSelectAgent}
                      onHoverEnter={hoverEnter}
                      onHoverLeave={hoverLeave}
                    />
                  ),
                )
              )
            ) : rows.length === 0 ? (
              <tr>
                <td className="agent-table-empty" colSpan={COL_COUNT}>
                  no agents match “{query.trim()}”
                </td>
              </tr>
            ) : (
              rows.map((agent) => (
                <AgentRow
                  key={`${agent.agentId}-${agent.index}`}
                  agent={agent}
                  phases={phases}
                  selected={!!selectedAgentId && agent.agentId === selectedAgentId}
                  hovered={!!hoveredAgentId && agent.agentId === hoveredAgentId}
                  onSelect={onSelectAgent}
                  onHoverEnter={hoverEnter}
                  onHoverLeave={hoverLeave}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
});
