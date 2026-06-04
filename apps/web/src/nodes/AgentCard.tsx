// @argus/web — the custom AgentCard node (boundaries.md §7).
//
// Renders: a 3 px state-colored left rail, a state dot + mono label, a model badge,
// and metric pills (duration / tokens / tools). tokens=0 renders as a dimmed em-dash
// (not "0"): 0-with-tools is activity, not "nothing". On a killed/failed run a
// `progress` agent is normalized to `interrupted` upstream → STATIC badge, no pulse.
//
// ALL text is rendered as React text nodes (never dangerouslySetInnerHTML) — the
// previews/labels can carry secret-bearing content (boundaries.md §4).

import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { AgentState } from '@argus/contract';

export interface AgentCardData {
  label: string;
  state: AgentState;
  model: string | null;
  cached: boolean;
  failedInLogs: boolean;
  tokens: number | null;
  toolCalls: number | null;
  durationMs: number | null;
  [key: string]: unknown;
}

const STATE_COLOR: Record<AgentState, string> = {
  done: '#3fb950',
  running: '#5b9dff',
  queued: '#8b949e',
  error: '#f85149',
  interrupted: '#d29922',
  unknown: '#6b7280',
};

const STATE_LABEL: Record<AgentState, string> = {
  done: 'done',
  running: 'running',
  queued: 'queued',
  error: 'error',
  interrupted: 'interrupted',
  unknown: 'unknown',
};

const EM_DASH = '—';

function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return EM_DASH;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m${rem.toString().padStart(2, '0')}s`;
}

function formatTokens(tokens: number | null): string {
  // tokens=0 → em-dash (boundaries.md §7); null (live, not yet known) → em-dash too.
  if (tokens === null || tokens === 0) return EM_DASH;
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function formatTools(toolCalls: number | null): string {
  if (toolCalls === null || toolCalls === 0) return EM_DASH;
  return String(toolCalls);
}

function Pill({ label, value, dim }: { label: string; value: string; dim: boolean }) {
  return (
    <span className="agent-pill" data-dim={dim ? 'true' : 'false'}>
      <span className="agent-pill-label">{label}</span>
      <span className="agent-pill-value">{value}</span>
    </span>
  );
}

export const AgentCardNode = memo(function AgentCardNode({ data }: { data: AgentCardData }) {
  const color = STATE_COLOR[data.state] ?? STATE_COLOR.unknown;
  const tokensText = formatTokens(data.tokens);
  const toolsText = formatTools(data.toolCalls);
  const durationText = formatDuration(data.durationMs);

  return (
    <div className="agent-card" style={{ borderLeftColor: color }}>
      {/* Handles are visually hidden — no agent edges are drawn (boundaries.md §6),
          but xyflow wants targets for the synthesized phase spine to dock cleanly. */}
      <Handle type="target" position={Position.Top} className="agent-handle" />
      <Handle type="source" position={Position.Bottom} className="agent-handle" />

      <div className="agent-card-head">
        <span className="agent-dot" style={{ backgroundColor: color }} aria-hidden="true" />
        <span className="agent-label" title={data.label}>
          {data.label}
        </span>
      </div>

      <div className="agent-card-meta">
        <span className="agent-state" style={{ color }}>
          {STATE_LABEL[data.state] ?? 'unknown'}
        </span>
        {data.model ? <span className="agent-model">{data.model}</span> : null}
        {data.cached ? <span className="agent-flag agent-flag-cached">cached</span> : null}
        {data.failedInLogs ? <span className="agent-flag agent-flag-failed">failed</span> : null}
      </div>

      <div className="agent-card-pills">
        <Pill label="dur" value={durationText} dim={durationText === EM_DASH} />
        <Pill label="tok" value={tokensText} dim={tokensText === EM_DASH} />
        <Pill label="tools" value={toolsText} dim={toolsText === EM_DASH} />
      </div>
    </div>
  );
});
