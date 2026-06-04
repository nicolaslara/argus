// @argus/web — the execution AgentCard node (boundaries.md §7), now a THIN WRAPPER
// over the shared AgentCardShell (U1: one card component for Plan & Execution).
//
// The shell provides the card shape, the state-colored left rail, the mono label, and
// the 2-line caption slot. THIS file fills the EXECUTION footer: state + dur/tok/tools
// pills. tokens=0 renders as a dimmed em-dash (not "0"): 0-with-tools is activity, not
// "nothing". On a killed/failed run a `progress` agent is normalized to `interrupted`
// upstream → STATIC badge, no pulse.
//
// ALL text is rendered as React text nodes (never dangerouslySetInnerHTML) — the
// previews/labels can carry secret-bearing content (boundaries.md §4).

import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { AgentState, Preview } from '@argus/contract';
import { AgentCardShell, CARD_SHELL_HEIGHT_EXEC } from './AgentCardShell.tsx';

export interface AgentCardData {
  label: string;
  state: AgentState;
  model: string | null;
  cached: boolean;
  failedInLogs: boolean;
  tokens: number | null;
  toolCalls: number | null;
  durationMs: number | null;
  // --- I1: the rest of the AgentNode scalars, carried on node.data so the detail panel
  //     reads them WITHOUT a new fetch (boundaries §7 "filled instantly from card data";
  //     these were always in RunModel.agents[]). The card render ignores them; only the
  //     DetailPanel projects them. Previews stay capped at the adapter boundary. ---
  agentType?: string | null;
  attempt?: number | null;
  queuedAt?: number | null;
  startedAt?: number | null;
  lastProgressAt?: number | null;
  lastToolName?: string | null;
  lastToolSummary?: string | null;
  promptPreview?: Preview | null;
  resultPreview?: Preview | null;
  /**
   * PX (annotation-only): the node caption — an LLM-enriched one-liner when ready, else
   * the deterministic baseline. Rendered as a text node only, 2-line clamped. Swapped in
   * by overlayExplanations; absent on the M3/P0/P1 render (so those stay byte-unchanged).
   */
  caption?: string | null;
  captionSource?: 'baseline' | 'llm';
  /** PX overlay join key: the AgentNode.agentId (== the engine's explanation id). */
  agentId?: string;
  [key: string]: unknown;
}

// One shared state/kind palette (U1) — also consumed by the plan view's state hooks.
export const STATE_COLOR: Record<AgentState, string> = {
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

  // The EXECUTION footer: a state label + model/cached/failed flags + metric pills.
  const footer = (
    <>
      <div className="agent-shell-meta">
        <span className="agent-state" style={{ color }}>
          {STATE_LABEL[data.state] ?? 'unknown'}
        </span>
        {data.model ? <span className="agent-model">{data.model}</span> : null}
        {data.cached ? <span className="agent-chip agent-chip-cached">cached</span> : null}
        {data.failedInLogs ? <span className="agent-chip agent-chip-failed">failed</span> : null}
      </div>
      <div className="agent-shell-pills">
        <Pill label="dur" value={durationText} dim={durationText === EM_DASH} />
        <Pill label="tok" value={tokensText} dim={tokensText === EM_DASH} />
        <Pill label="tools" value={toolsText} dim={toolsText === EM_DASH} />
      </div>
    </>
  );

  return (
    <AgentCardShell
      label={data.label}
      labelTitle={data.label}
      railColor={color}
      height={CARD_SHELL_HEIGHT_EXEC}
      className="agent-shell-exec"
      dot={<span className="agent-dot" style={{ backgroundColor: color }} aria-hidden="true" />}
      handles={
        <>
          {/* Handles are visually hidden — no agent edges are drawn (boundaries.md §6),
              but xyflow wants targets for the synthesized phase spine to dock cleanly. */}
          <Handle type="target" position={Position.Top} className="agent-handle" />
          <Handle type="source" position={Position.Bottom} className="agent-handle" />
        </>
      }
      caption={
        data.caption ? (
          <div
            className="agent-caption"
            data-source={data.captionSource ?? 'llm'}
            title={data.caption}
          >
            {data.caption}
          </div>
        ) : null
      }
      footer={footer}
    />
  );
});
