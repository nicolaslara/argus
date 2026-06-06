// @argus/web — the node DETAIL PANEL (inspect I1). A right-hand panel filled INSTANTLY
// from the clicked node's `data` (no fetch — I1 plumbed the full AgentNode scalars +
// plan-node fields onto node.data; boundaries §7 "filled from card data"). Reachable
// from all three views (Execution / Plan / Morph). Closes on the × button or a pane click.
//
// ALL text is rendered as React text nodes (never dangerouslySetInnerHTML): previews /
// results / labels can echo the user's own run content (boundaries §4).

import { memo, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Node } from '@xyflow/react';
import type { AgentActivity, AgentState, AgentTimelineEntry, LoopRoundInstance } from '@argus/contract';
import { fetchAgentActivity, fetchAgentResult, fetchSubUi } from '../api.ts';
import { GenerativePanel } from './GenerativePanel.tsx';
import { STATE_COLOR } from './AgentCard.tsx';
import { TranscriptReader } from './TranscriptReader.tsx';
// transcript-reader: shared readable renderers / formatting (extracted so the full-read
// overlay reuses the SAME helpers rather than duplicating them).
import {
  JsonReadable,
  clockTime,
  fmtDuration,
  fmtTime,
  num,
  str,
  totalTokens,
  tryReadable,
} from './transcriptHelpers.tsx';

interface Preview {
  text: string;
  truncated: boolean;
}

function isPreview(v: unknown): v is Preview {
  return !!v && typeof v === 'object' && typeof (v as Preview).text === 'string';
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

function PreviewBlock({
  label,
  preview,
  full,
  loading,
  showEmpty,
}: {
  label: string;
  preview: unknown;
  /** The lazily-fetched FULL value (string or object); undefined = not fetched. */
  full?: unknown;
  loading?: boolean;
  /** Render an honest "not captured" state when there's no data (vs. hiding the block). */
  showEmpty?: boolean;
}) {
  const [raw, setRaw] = useState(false);
  const pv = isPreview(preview) ? preview : null;
  const hasFull = full !== undefined && full !== null;
  const hasText = (pv?.text?.length ?? 0) > 0 || (hasFull && (typeof full !== 'string' || full.length > 0));
  const source: unknown = hasFull ? full : (pv?.text ?? '');
  const readable = useMemo(() => tryReadable(source), [source]);
  // Missing-data reality (honest, visible): a workflow agent with no recorded prompt/result
  // shows a "not captured" note — the journal simply didn't record it — instead of a blank.
  if (!hasText && !loading) {
    if (!showEmpty) return null;
    return (
      <div className="detail-block">
        <div className="detail-block-label">{label}</div>
        <div className="detail-uncaptured">
          not captured — the run journal didn’t record this {label}
        </div>
      </div>
    );
  }
  if (!pv && !hasFull && !loading) return null;

  const truncated = !hasFull && !!pv?.truncated; // a capped preview; the full value isn't truncated
  const rawText = readable.kind === 'json' ? JSON.stringify(readable.value, null, 2) : readable.text;
  return (
    <div className="detail-block">
      <div className="detail-block-label">
        {label}
        {loading ? <span className="detail-trunc detail-loading">loading…</span> : null}
        {truncated ? <span className="detail-trunc">preview</span> : null}
        {readable.kind === 'json' ? (
          <button type="button" className="detail-toggle" onClick={() => setRaw((v) => !v)}>
            {raw ? '◧ readable' : '{ } json'}
          </button>
        ) : null}
      </div>
      {readable.kind === 'json' && !raw ? (
        <JsonReadable value={readable.value} />
      ) : (
        <pre className="detail-pre">{rawText || '—'}</pre>
      )}
    </div>
  );
}

/**
 * STEP 2 — the agent PROMPT block (the task handed to the agent). Renders the FULL
 * transcript prompt (`activity.prompt`, already capped by the adapter) VERBATIM in a
 * calm, collapsible monospace pre. Long prompts are clamped to a few lines with a
 * "show more / show less" toggle so the panel stays scannable; nothing is fetched here
 * (the prompt rides the already-lazy activity query). Renders NOTHING when no prompt.
 */
function PromptBlock({ prompt }: { prompt: string | undefined }) {
  const [expanded, setExpanded] = useState(false);
  const text = typeof prompt === 'string' ? prompt : '';
  if (text.trim().length === 0) return null;
  // "Long" = enough to be worth clamping (either many lines or a lot of characters).
  const lineCount = text.split('\n').length;
  const isLong = lineCount > 12 || text.length > 800;
  return (
    <div className="detail-block">
      <div className="detail-block-label">
        prompt
        {isLong ? (
          <button type="button" className="detail-toggle" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'show less' : 'show more'}
          </button>
        ) : null}
      </div>
      <pre className={`detail-pre${isLong && !expanded ? ' detail-pre-clamp' : ''}`}>{text}</pre>
    </div>
  );
}

/**
 * STEP 4 — the per-agent ACTIVITY drill (failure-and-live-inspector §4). Lazily fetched from
 * the transcript for the SELECTED agent only. Renders a calm, collapsible inspector: a token
 * breakdown + tool counts, a tool/text TIMELINE (each tool_use + clock time), and the LAST
 * activity (running = what's happening now; failed = the final error line — the root cause).
 * Degrades to nothing when the endpoint 404s (transcript absent) — the card rows still show
 * whatever the journal recorded.
 */
function ActivityBlock({ activity, loading }: { activity: AgentActivity | undefined; loading: boolean }) {
  const [open, setOpen] = useState(false);
  if (!activity) {
    // Honest, quiet loading note; on 404 we render nothing (the rows above carry the journal).
    return loading ? (
      <div className="detail-block">
        <div className="detail-block-label">
          activity<span className="detail-trunc detail-loading">loading…</span>
        </div>
      </div>
    ) : null;
  }

  const tok = activity.tokens;
  const timeline = activity.timeline;
  // Prefer the explicit error line; else the last assistant text (the current/final activity).
  const last = activity.error ?? activity.lastText;
  const lastIsError = !!activity.error;

  return (
    <div className="detail-block">
      <div className="detail-block-label">
        activity
        {timeline.length > 0 ? (
          <button type="button" className="detail-toggle" onClick={() => setOpen((v) => !v)}>
            {open ? 'hide timeline' : `timeline (${timeline.length})`}
          </button>
        ) : null}
      </div>

      {/* tool counts — the distinct tools the agent invoked, with multiplicity. */}
      {activity.tools.length > 0 ? (
        <div className="detail-tools">
          {activity.tools.map((t) => (
            <span key={t.name} className="detail-tool-chip" title={`${t.name} ×${t.count}`}>
              {t.name}
              {t.count > 1 ? <span className="detail-tool-count">×{t.count}</span> : null}
            </span>
          ))}
        </div>
      ) : null}

      {/* token breakdown (in / out / cache-read) when usage was recorded. */}
      {tok ? (
        <div className="detail-kv">
          <div className="detail-kv-row">
            <span className="detail-kv-key">input</span>
            <span className="detail-kv-val">{tok.input.toLocaleString()}</span>
          </div>
          <div className="detail-kv-row">
            <span className="detail-kv-key">output</span>
            <span className="detail-kv-val">{tok.output.toLocaleString()}</span>
          </div>
          <div className="detail-kv-row">
            <span className="detail-kv-key">cache read</span>
            <span className="detail-kv-val">{tok.cacheRead.toLocaleString()}</span>
          </div>
        </div>
      ) : null}

      {/* the LAST activity — for a running agent this is "what's happening now"; for a failed
          one it's the final error line (e.g. the socket-close), i.e. the root-cause answer. */}
      {last ? (
        <div className={lastIsError ? 'detail-log-fail' : 'detail-summary'}>{last}</div>
      ) : null}

      {/* the tool/text timeline (collapsible) — each event with its clock time. */}
      {open && timeline.length > 0 ? (
        <ol className="detail-timeline">
          {timeline.map((e: AgentTimelineEntry, i) => {
            const t = clockTime(e.t);
            return (
              <li key={i} className="detail-timeline-row">
                <span className="detail-timeline-time">{t ?? '—'}</span>
                <span className={`detail-timeline-kind detail-timeline-${e.kind}`}>
                  {e.kind === 'tool' ? (e.name ?? 'tool') : 'text'}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}

/** A small filled/hollow status dot per instance state (reuses the shared STATE_COLOR hues). */
function StateDot({ state }: { state: AgentState }) {
  const color = STATE_COLOR[state] ?? STATE_COLOR.unknown;
  // done = filled ●, error/interrupted = filled (red/amber), running = filled blue, others hollow.
  const filled = state === 'done' || state === 'error' || state === 'interrupted' || state === 'running';
  return (
    <span
      className="detail-round-dot"
      title={state}
      aria-label={state}
      style={filled ? { background: color, borderColor: color } : { borderColor: color }}
    />
  );
}

/**
 * The loop-body ROUND drill (run-view-merge-plan §5): a compact, round-labelled list of the
 * loop body's bound instances. When a specific round was picked (the round-axis pill), only
 * THAT round's instances show; otherwise the whole loop body's instances list, each row tagged
 * with its derived round (the best-effort whole-body aggregate). Each row is CLICKABLE and
 * drills into that instance's transcript/result/activity — reusing the panel's agent machinery
 * (the loop body's subagents are reached HERE, never via a lane-drawer inside the loop).
 */
function RoundInstanceList({
  roundBindings,
  selectedRound,
  pickedInstanceId,
  onPick,
}: {
  roundBindings: Array<{ round: number; instances: LoopRoundInstance[] }>;
  selectedRound: number | null;
  pickedInstanceId: string | null;
  onPick: (agentId: string) => void;
}) {
  const shown =
    selectedRound != null ? roundBindings.filter((rb) => rb.round === selectedRound) : roundBindings;
  const total = shown.reduce((n, rb) => n + rb.instances.length, 0);
  if (total === 0) {
    return (
      <div className="detail-block">
        <div className="detail-block-label">
          {selectedRound != null ? `round r${selectedRound} — instances` : 'loop instances'}
        </div>
        <div className="detail-uncaptured">no bound instances for this round</div>
      </div>
    );
  }
  return (
    <div className="detail-block">
      <div className="detail-block-label">
        {selectedRound != null ? `round r${selectedRound} — instances` : 'loop instances'}
        <span className="detail-trunc">{total}</span>
      </div>
      {shown.map((rb) => (
        <div key={rb.round} className="detail-round-group">
          {/* When no round is picked we group by round; with a picked round the heading above
              already names it, so a single group reads cleanly. */}
          {selectedRound == null ? (
            <div className="detail-round-heading">r{rb.round}</div>
          ) : null}
          <ul className="detail-round-list">
            {rb.instances.map((inst) => (
              <li key={inst.agentId}>
                <button
                  type="button"
                  className={`detail-round-row${inst.agentId === pickedInstanceId ? ' is-active' : ''}`}
                  onClick={() => onPick(inst.agentId)}
                  title={`${inst.label} — ${inst.state}`}
                >
                  <StateDot state={inst.state} />
                  <span className="detail-round-label">{inst.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export const DetailPanel = memo(function DetailPanel({
  node,
  runRef,
  selectedRound = null,
  onClose,
}: {
  node: Node | null;
  /** The current run's ref — lets an execution agent lazily fetch its FULL result (R1). */
  runRef?: { slug: string; sessionId: string; runId: string } | null;
  /**
   * Loop-body drill: when the selected node is a `planLoop` opened from a round-axis pill,
   * the chosen round (1-based). The panel lists THAT round's bound instances (each a clickable
   * drill into one agent); `null` for any non-loop selection (or a loop selected without a round).
   */
  selectedRound?: number | null;
  onClose: () => void;
}) {
  // Hooks must run unconditionally (before the early return). Derive from a possibly-null node.
  const dMaybe = (node?.data ?? {}) as Record<string, unknown>;
  // An EXECUTION instance: a full agentCard OR a compact agentChip (Ship #6 density degrade).
  // Both carry `data.agentId`, so a clicked chip drills into the same transcript/result/activity
  // as a card. The chip's `+N more` overflow tile carries no agentId → agentId resolves to null
  // (str(undefined)) and the panel stays inert for it (there is no single agent to open).
  const nodeType = node?.type ?? '';
  const isAgent = nodeType === 'agentCard' || nodeType === 'agentChip';
  // Loop-body drill: a `planLoop` opened from a round pill carries `roundBindings` (per-round
  // bound instances). Clicking an instance row picks ONE agent to inspect — held in local state
  // so the SAME transcript/result/activity machinery (below) fires for that instance. Reset when
  // the selected node OR round changes (a new node/round id keys this memo fresh).
  const isLoop = nodeType === 'planLoop';
  const roundBindings = Array.isArray(dMaybe.roundBindings)
    ? (dMaybe.roundBindings as Array<{ round: number; agentIds: string[]; instances: LoopRoundInstance[] }>)
    : null;
  const [pickedInstanceId, setPickedInstanceId] = useState<string | null>(null);
  // Clear the picked instance whenever the selection (node id or round) changes.
  const selectionKey = `${node?.id ?? ''}::${selectedRound ?? ''}`;
  const lastSelectionKey = useRef(selectionKey);
  if (lastSelectionKey.current !== selectionKey) {
    lastSelectionKey.current = selectionKey;
    if (pickedInstanceId !== null) setPickedInstanceId(null);
  }
  // A single-agent plan step has no separate instance card to click — drill into its ONE bound
  // agent's transcript activity straight from the plan node, so a failed single-agent step (e.g.
  // `implement`) surfaces its root-cause last-activity, not just static template detail.
  const boundIds = Array.isArray(dMaybe.bindAgentIds) ? (dMaybe.bindAgentIds as unknown[]) : [];
  // A picked loop instance wins (the row the user clicked); else an exec instance's own id; else
  // a single-agent plan step's one bound agent.
  const agentId = pickedInstanceId
    ? pickedInstanceId
    : isAgent
      ? str(dMaybe.agentId)
      : boundIds.length === 1
        ? str(boundIds[0])
        : null;
  const resultQ = useQuery({
    queryKey: ['agent-result', runRef?.slug, runRef?.sessionId, runRef?.runId, agentId],
    queryFn: () => fetchAgentResult(runRef!, agentId!),
    enabled: !!node && !!runRef && !!agentId,
    staleTime: Infinity,
  });
  // STEP 4: the lazy transcript-fed activity for the SELECTED agent (label/tokens/tools/
  // timeline/last-activity). Fetched ONLY for the visible agent — never eager for every card.
  // A 404 (transcript absent: cleaned/old run) is expected → we keep the journal-only rows.
  const activityState = str(dMaybe.state);
  const isLiveAgent = activityState === 'running' || activityState === 'queued';
  const activityQ = useQuery({
    queryKey: ['agent-activity', runRef?.slug, runRef?.sessionId, runRef?.runId, agentId],
    queryFn: () => fetchAgentActivity(runRef!, agentId!),
    enabled: !!node && !!runRef && !!agentId,
    staleTime: Infinity,
    retry: false, // a 404 means "no transcript yet" — don't hammer; degrade gracefully.
    // A live agent's transcript grows; refresh while it's running so the card/timeline keep up.
    refetchInterval: isLiveAgent ? 4000 : false,
  });
  const activity = activityQ.data;
  // #9: a Claude-generated sub-UI for this result — opt-in (spends a claude call), cached.
  const [showSubUi, setShowSubUi] = useState(false);
  const subUiQ = useQuery({
    queryKey: ['subui', runRef?.slug, runRef?.sessionId, runRef?.runId, agentId],
    queryFn: () => fetchSubUi(runRef!, agentId!),
    enabled: !!node && !!runRef && !!agentId && showSubUi,
    staleTime: Infinity,
  });
  // transcript-reader: the full top-to-bottom read overlay (prompt → timeline → result) for
  // THIS agent, opened from the "open full ⤢" affordance. Reuses the already-fetched activity
  // + result (no new fetch).
  const [readerOpen, setReaderOpen] = useState(false);

  if (!node) return null;
  const d = node.data as Record<string, unknown>;
  const type = node.type ?? 'node';

  // STEP 4: a LIVE agent card's label is often a bare agentId (the journal has no label). The
  // transcript's first user message yields a real task label — prefer it when the card label is
  // missing or is just the id, so a running agent reads as a task, not a hash.
  const cardLabel = str(d.label);
  const activityLabel = str(activity?.label);
  const labelIsBareId = !cardLabel || (!!agentId && cardLabel === agentId);
  // A picked loop instance's run label (from roundBindings) — shown immediately as the title
  // so a drilled-into round instance reads as the agent, not the loop, before activity loads.
  const pickedInstanceLabel = pickedInstanceId
    ? (roundBindings
        ?.flatMap((rb) => rb.instances)
        .find((inst) => inst.agentId === pickedInstanceId)?.label ?? null)
    : null;
  // Title: prefer the fullest label we have. Plan agents carry the authored template in
  // `labelRaw` ("research:${r.key}") — richer than the static-prefix `title` the card splits
  // out; exec agents carry the concrete `label` ("research:modal-rs-surface") and no labelRaw.
  const title =
    pickedInstanceLabel ??
    str(d.labelRaw) ??
    (labelIsBareId && activityLabel ? activityLabel : null) ??
    cardLabel ??
    str(d.title) ??
    str(d.conditionLabel) ??
    type;
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

  // STEP 4: a LIVE/running agent card has null dur/tok/tools (the live model lacks them — they
  // live only in the transcript). Fall back to the transcript-derived activity so a running
  // agent's rows are no longer bare. The card data wins when present (the finalized truth).
  const durationMs = num(d.durationMs) ?? activity?.durationMs ?? null;
  const tokens = num(d.tokens) ?? (activity ? totalTokens(activity) : null);
  const toolCalls = num(d.toolCalls) ?? activity?.toolCalls ?? null;
  const lastToolName =
    str(d.lastToolName) ?? activity?.tools[activity.tools.length - 1]?.name ?? null;

  return (
    <aside className="detail-panel" role="complementary" aria-label="node detail">
      <div className="detail-panel-head">
        <span className="detail-kind">{type.replace(/^plan/, 'plan ')}</span>
        <button type="button" className="detail-close" onClick={onClose} aria-label="close">
          ×
        </button>
      </div>
      <div className="detail-title-row">
        <div className="detail-title" title={str(d.labelRaw) ?? title}>
          {title}
        </div>
        {/* transcript-reader: open the full top-to-bottom read for this agent. Shown only when
            we have a resolvable agentId (an exec instance OR a single-agent plan step). */}
        {agentId ? (
          <button
            type="button"
            className="detail-open-full"
            onClick={() => setReaderOpen(true)}
            title="open full transcript"
            aria-label="open full transcript"
          >
            open full <span aria-hidden="true">⤢</span>
          </button>
        ) : null}
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
            <Row label="duration" value={fmtDuration(durationMs)} />
            <Row label="tokens" value={tokens === 0 ? '— (0)' : tokens} />
            <Row label="tools" value={toolCalls} />
            <Row label="attempt" value={num(d.attempt)} />
            <Row label="last tool" value={lastToolName} />
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

      {/* Loop-body ROUND drill (run-view-merge-plan §5): a loop container opened from a
          round-axis pill lists THAT round's bound instances (each clickable → drills into the
          agent below). With no picked round it lists the whole loop body's instances, round-
          tagged (the honest best-effort aggregate). The loop body's subagents are reached HERE. */}
      {isLoop && roundBindings && roundBindings.length > 0 ? (
        <RoundInstanceList
          roundBindings={roundBindings}
          selectedRound={selectedRound}
          pickedInstanceId={pickedInstanceId}
          onPick={setPickedInstanceId}
        />
      ) : null}

      {/* STEP 2: the agent PROMPT — the verbatim transcript task when we have it (richer than
          the card's capped preview), else the card-data preview. Sits above RESULT/ACTIVITY. */}
      {activity?.prompt ? (
        <PromptBlock prompt={activity.prompt} />
      ) : (
        <PreviewBlock label="prompt" preview={d.promptPreview} showEmpty={isExecAgent} />
      )}
      <PreviewBlock
        label="result"
        preview={d.resultPreview}
        full={resultQ.data?.value}
        loading={!!agentId && resultQ.isFetching && resultQ.data === undefined}
        showEmpty={isExecAgent}
      />

      {/* STEP 4: the transcript-fed activity drill — tools, tokens, timeline, last activity /
          final error. Shown for any node with a resolvable agentId (an exec instance OR a
          single-agent plan step); hidden entirely on a 404 (no transcript: cleaned/old run). */}
      {agentId && (activity || activityQ.isFetching) ? (
        <ActivityBlock
          activity={activity}
          loading={activityQ.isFetching && activity === undefined}
        />
      ) : null}

      {/* #9: a Claude-generated, tailored panel for this result (opt-in, cached). */}
      {agentId && resultQ.data?.value != null ? (
        <div className="detail-block">
          <div className="detail-block-label">
            generated panel
            <button type="button" className="detail-toggle" onClick={() => setShowSubUi((v) => !v)}>
              {showSubUi ? 'hide' : '✨ generate'}
            </button>
          </div>
          {showSubUi ? (
            subUiQ.isFetching && !subUiQ.data ? (
              <div className="detail-summary">generating a tailored panel…</div>
            ) : subUiQ.data?.status === 'ready' && subUiQ.data.spec ? (
              <GenerativePanel spec={subUiQ.data.spec} />
            ) : (
              <div className="detail-summary">
                {subUiQ.data?.status === 'unavailable'
                  ? 'claude unavailable — the readable result above is the fallback'
                  : 'could not generate a panel for this result'}
              </div>
            )
          ) : null}
        </div>
      ) : null}

      {/* transcript-reader: the full top-to-bottom read overlay for this agent. Portals to
          <body> so it overlays the whole canvas; reuses the ALREADY-FETCHED activity + result
          (no new fetch). */}
      {readerOpen && agentId ? (
        <TranscriptReader
          activity={activity}
          result={resultQ.data?.value}
          resultTruncated={resultQ.data?.truncated}
          title={title}
          status={str(d.state) ?? bindStatus}
          onClose={() => setReaderOpen(false)}
        />
      ) : null}
    </aside>
  );
});
