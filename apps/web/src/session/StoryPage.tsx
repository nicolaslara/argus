// @argus/web — the Story page (M1b): the SESSION NARRATIVE three-level view.
//
// project → sessions-on-a-timeline → per-session topic blocks → (lazy) full turns
// (knowledge.md data model). A SELF-CONTAINED component: it owns its own TanStack
// Query fetches (sessions / narrative / per-block turns) and does NOT touch App.tsx —
// App only mounts <StoryPage slug=… /> behind its Workflows⟷Story switch.
//
// The web imports ONLY @argus/contract (never the adapter / node:*). All emitted text
// is the already-truncated, redact()-routed Preview — rendered as React text nodes only
// (never dangerouslySetInnerHTML): previews/labels can echo secret-bearing content
// (boundaries.md §4). The wire never carries a full body; long responses are head+tail
// bounded upstream, so this view just renders what it is handed.
//
// Visual language reuses the dark card tokens (panels, mono ids, the 3px left accent,
// outlined chips) — the story-specific classes live in a `===== Story view (M1b) =====`
// block appended to index.css.

import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  AskQuestion,
  GitCommitRef,
  NarrativeBlock,
  NarrativeSummary,
  Preview,
  SessionNarrative,
  Turn,
  WorkflowSpawn,
} from '@argus/contract';
import { fetchBlockSummary, fetchSessionNarrative, fetchSessionTurns } from '../api.ts';
import { isoToMs } from './session-format.ts';

interface StoryPageProps {
  /** On-disk slug dir name — the path key for the narrative/turns fetchers. */
  slug: string;
  /**
   * The session to render, chosen in the rail's Sessions section (lifted to App so the rail
   * navigator and this narrative never disagree). null = nothing selected yet (loading / empty).
   */
  sessionId: string | null;
  /** Display name (basename of the project cwd); falls back to the slug. */
  projectName?: string;
  /** Total session count for the project (shown in the header; the list itself lives in the rail). */
  sessionCount?: number;
  /** M3: true if this spawn resolves to a run → its chip becomes a clickable link to the run. */
  canOpenSpawn?: (spawn: WorkflowSpawn) => boolean;
  /** M3: open the run a spawn launched (navigates to the Workflows page with that run selected). */
  onOpenSpawn?: (spawn: WorkflowSpawn) => void;
}

/**
 * M3 spawn navigation, provided by StoryPage (from App's run-resolution handlers) and consumed by
 * the deep {@link WorkflowSpawnChip} without prop-drilling through the block list. `canOpen`
 * decides whether a chip is a clickable link; `onOpen` performs the navigation.
 */
const SpawnNavContext = createContext<{
  canOpen: (spawn: WorkflowSpawn) => boolean;
  onOpen: (spawn: WorkflowSpawn) => void;
} | null>(null);

// ---- small pure presentation helpers (ISO-aware; the contract carries ISO strings) -----

/** A compact clock time `14:07` for an ISO timestamp, or em-dash. */
function clockIso(iso: string | null): string {
  const ms = isoToMs(iso);
  if (ms == null) return '—';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** A compact elapsed span between two ISO timestamps (`3m 12s`, `1h 04m`), or null. */
function spanLabel(start: string | null, end: string | null): string | null {
  const a = isoToMs(start);
  const b = isoToMs(end);
  if (a == null || b == null) return null;
  const ms = b - a;
  if (ms <= 0) return null;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${String(sec).padStart(2, '0')}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${String(remMin).padStart(2, '0')}m`;
}

/** A topic line for a block: its label, else the first line of the prompt, else a fallback. */
function blockTopic(block: NarrativeBlock): string {
  if (block.topicLabel && block.topicLabel.trim() !== '') return block.topicLabel.trim();
  const firstLine = block.promptPreview.text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (firstLine) return firstLine;
  return block.cutReason === 'session-start' ? 'Session start' : 'Untitled block';
}

/** The N largest toolName→count entries, descending (so the noisiest tools lead the badges). */
function topTools(toolCounts: Record<string, number>, limit: number): Array<[string, number]> {
  return Object.entries(toolCounts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

// ============================================================================
// StoryPage — the SELECTED session's narrative (block list + lazy turns), full
// width. The session NAVIGATOR (the list of a project's sessions) now lives in
// the left rail's Sessions section; App lifts the chosen `sessionId` and passes
// it down here, so the rail and this narrative never disagree.
// ============================================================================
export const StoryPage = memo(function StoryPage({
  slug,
  sessionId,
  projectName,
  sessionCount,
  canOpenSpawn,
  onOpenSpawn,
}: StoryPageProps) {
  const shortId = sessionId ? sessionId.split('-')[0] ?? sessionId : null;
  // Stable nav value so the spawn chips don't re-render on every StoryPage render. A no-op default
  // keeps the chips inert (non-clickable) when App didn't wire the handlers.
  const spawnNav = useMemo(
    () => ({
      canOpen: (s: WorkflowSpawn) => (canOpenSpawn ? canOpenSpawn(s) : false),
      onOpen: (s: WorkflowSpawn) => onOpenSpawn?.(s),
    }),
    [canOpenSpawn, onOpenSpawn],
  );
  return (
    <SpawnNavContext.Provider value={spawnNav}>
    <div className="story" aria-label="session narrative">
      <header className="story-header">
        <span className="story-eyebrow">Story</span>
        <h1 className="story-title">{projectName ?? slug}</h1>
        <span className="story-sub">
          {shortId ? (
            <span className="story-sub-session" title={sessionId ?? undefined}>{shortId}</span>
          ) : null}
          {typeof sessionCount === 'number' ? (
            <span className="story-sub-count">
              {shortId ? ' · ' : ''}
              {sessionCount} {sessionCount === 1 ? 'session' : 'sessions'}
            </span>
          ) : null}
        </span>
      </header>

      <div className="story-body">
        <div className="story-narrative">
          {sessionId ? (
            <SessionNarrativeView key={sessionId} slug={slug} sessionId={sessionId} />
          ) : (
            <div className="story-empty">pick a session in the rail to read its story</div>
          )}
        </div>
      </div>
    </div>
    </SpawnNavContext.Provider>
  );
});

// ---- Level 2: the selected session's narrative (the block list) --------------------------
const SessionNarrativeView = memo(function SessionNarrativeView({
  slug,
  sessionId,
}: {
  slug: string;
  sessionId: string;
}) {
  const narrativeQ = useQuery({
    queryKey: ['story-narrative', slug, sessionId],
    queryFn: () => fetchSessionNarrative(slug, sessionId),
    enabled: !!slug && !!sessionId,
    staleTime: 30_000,
  });

  if (narrativeQ.isPending) {
    return <div className="story-empty">loading narrative…</div>;
  }
  if (narrativeQ.isError || !narrativeQ.data) {
    return <div className="story-empty">failed to load this session’s narrative</div>;
  }

  const narrative: SessionNarrative = narrativeQ.data;
  const span = spanLabel(narrative.timeRange.start, narrative.timeRange.end);

  return (
    <section className="story-narrative-inner" aria-label="session narrative blocks">
      <div className="story-narrative-head">
        <div className="story-narrative-meta">
          <span className="story-narrative-count">
            {narrative.blocks.length} {narrative.blocks.length === 1 ? 'block' : 'blocks'}
          </span>
          <span className="story-dot" aria-hidden="true">·</span>
          <span className="story-narrative-stat">{narrative.totalRecords} records</span>
          {span ? (
            <>
              <span className="story-dot" aria-hidden="true">·</span>
              <span className="story-narrative-stat">{span}</span>
            </>
          ) : null}
          {narrative.projectPath ? (
            <span className="story-narrative-path" title={narrative.projectPath}>
              {narrative.projectPath}
            </span>
          ) : null}
        </div>
        {narrative.incomplete ? (
          <div className="story-warning" role="status">
            <span className="story-warning-tag">partial</span>
            <span className="story-warning-text">
              this narrative degraded while parsing
              {narrative.warnings.length > 0
                ? ` (${narrative.warnings.map((w) => w.code).join(', ')})`
                : ''}
            </span>
          </div>
        ) : null}
      </div>

      {narrative.blocks.length === 0 ? (
        <div className="story-empty">no blocks in this session</div>
      ) : (
        <ol className="story-blocks">
          {narrative.blocks.map((block, i) => (
            <BlockCard
              key={block.id}
              slug={slug}
              sessionId={sessionId}
              block={block}
              ordinal={i + 1}
            />
          ))}
        </ol>
      )}
    </section>
  );
});

// ---- Level 2 (card) + Level 3 (lazy turns drawer) ----------------------------------------
const BlockCard = memo(function BlockCard({
  slug,
  sessionId,
  block,
  ordinal,
}: {
  slug: string;
  sessionId: string;
  block: NarrativeBlock;
  ordinal: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [asksOpen, setAsksOpen] = useState(false);

  // M4: the per-block LLM summary is fetched LAZILY + ASYNC — only once the card scrolls INTO VIEW
  // (an IntersectionObserver flips `inView`), never eagerly for every block (a session has ~60+).
  // Cached forever after (staleTime Infinity, content-addressed server-side → a one-time generate).
  const cardRef = useRef<HTMLLIElement | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = cardRef.current;
    if (!el || inView) return;
    // No IntersectionObserver (jsdom / old env) → never auto-trigger (the baseline still renders).
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setInView(true);
      },
      { rootMargin: '120px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [inView]);

  // Lazy summary: enabled ONLY once the block is triggered (in view). Returns null when unavailable
  // (engine/claude absent) → the baseline stands. Keyed per block so each is generated independently.
  const summaryQ = useQuery({
    queryKey: ['story-summary', slug, sessionId, block.id],
    queryFn: () => fetchBlockSummary(slug, sessionId, block.id),
    enabled: inView,
    staleTime: Infinity,
  });

  // Level 3: full turns are fetched LAZILY — only once a block is expanded, never inlined into
  // the narrative (so the watch view stays small). Disabled until expanded; cached forever after.
  const turnsQ = useQuery({
    queryKey: ['story-turns', slug, sessionId, block.id],
    queryFn: () => fetchSessionTurns(slug, sessionId, block.id),
    enabled: expanded,
    staleTime: Infinity,
  });

  const topic = blockTopic(block);
  // AskUserQuestion gets its OWN expandable treatment below, so drop it from the generic badges.
  const tools = useMemo(() => {
    const rest = Object.fromEntries(Object.entries(block.toolCounts).filter(([n]) => n !== 'AskUserQuestion'));
    return topTools(rest, 6);
  }, [block.toolCounts]);
  // Count QUESTIONS (one AskUserQuestion call can carry several), so the label matches what expands.
  const askCount = block.asks.length;
  const start = clockIso(block.timeRange.start);
  const span = spanLabel(block.timeRange.start, block.timeRange.end);
  // Prefer the LAZILY-fetched M4 summary over any baked-in block.summary (M0-M3 emit null).
  const summary: NarrativeSummary | null = summaryQ.data ?? block.summary;
  const hasSummary = !!summary && (!!summary.caption || !!summary.body);

  return (
    <li className="story-block" ref={cardRef}>
      <div className="story-block-rail" aria-hidden="true" />
      <div className="story-block-body">
        <div className="story-block-head">
          <span className="story-block-ordinal">{ordinal}</span>
          <span className="story-block-topic" title={topic}>
            {topic}
          </span>
          <span className="story-block-clock">{start}</span>
        </div>

        <div className="story-block-stats">
          <span className="story-block-stat">
            {block.turnCount} {block.turnCount === 1 ? 'turn' : 'turns'}
          </span>
          <span className="story-dot" aria-hidden="true">·</span>
          <span className="story-block-stat" title="record range">
            #{block.recordRange.start}–{block.recordRange.end}
          </span>
          {span ? (
            <>
              <span className="story-dot" aria-hidden="true">·</span>
              <span className="story-block-stat">{span}</span>
            </>
          ) : null}
          {block.cutReason === 'session-start' ? (
            <span className="story-chip story-chip-cut">session start</span>
          ) : null}
        </div>

        {/* The LLM caption (M4; null while baseline). A 3px accent left-tick marks an enriched
            summary — mirrors the agent-caption treatment from the Execution view. */}
        {hasSummary ? (
          <div className="story-block-summary">
            {summary!.caption ? (
              <div className="story-block-summary-caption">{summary!.caption}</div>
            ) : null}
            {summary!.body ? (
              <div className="story-block-summary-body">{summary!.body}</div>
            ) : null}
          </div>
        ) : null}

        {/* Prompt → response previews (the watch-view text; head+tail bounded upstream). */}
        <PreviewLine kind="prompt" preview={block.promptPreview} />
        <PreviewLine kind="response" preview={block.responsePreview} />

        {/* AskUserQuestion decision points — a clickable chip that EXPANDS to the question(s) +
            options right here in the watch view (no need to click into the turns). */}
        {block.asks.length > 0 ? (
          <div className="story-block-asks">
            <button
              type="button"
              className="story-asks-toggle"
              onClick={() => setAsksOpen((v) => !v)}
              aria-expanded={asksOpen}
            >
              <span className="story-asks-caret" aria-hidden="true">{asksOpen ? '▾' : '▸'}</span>
              <span className="story-asks-glyph" aria-hidden="true">❓</span>
              {askCount} {askCount === 1 ? 'question asked' : 'questions asked'}
            </button>
            {asksOpen ? block.asks.map((q, i) => <AskBlock key={`ask-${i}`} q={q} />) : null}
          </div>
        ) : null}

        {/* Tool badges + workflow spawns + commits + files — the at-a-glance facts. */}
        {tools.length > 0 ? (
          <div className="story-badges" aria-label="tool counts">
            {tools.map(([name, count]) => (
              <span className="story-tool" key={name}>
                <span className="story-tool-name">{name}</span>
                <span className="story-tool-count">{count}</span>
              </span>
            ))}
          </div>
        ) : null}

        {block.workflowSpawns.length > 0 ? (
          <div className="story-spawns" aria-label="workflow spawns">
            {block.workflowSpawns.map((sp, i) => (
              <WorkflowSpawnChip key={`${sp.scriptBasename}:${sp.argsDigest}:${i}`} spawn={sp} />
            ))}
          </div>
        ) : null}

        {block.gitCommits.length > 0 ? (
          <div className="story-commits" aria-label="git commits">
            {block.gitCommits.map((c, i) => (
              <CommitChip key={`${c.shortSha}:${i}`} commit={c} />
            ))}
          </div>
        ) : null}

        {block.filesTouched.length > 0 ? (
          <div className="story-files" aria-label="files touched">
            {block.filesTouched.map((f, i) => (
              <span className="story-file" key={`${f}:${i}`}>
                {f}
              </span>
            ))}
          </div>
        ) : null}

        {/* Level 3 toggle: lazily open the full-turns drawer for this block. */}
        <button
          type="button"
          className="story-turns-toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <span className="story-turns-caret" aria-hidden="true">
            {expanded ? '▾' : '▸'}
          </span>
          {expanded ? 'Hide turns' : `Show ${block.turnCount} ${block.turnCount === 1 ? 'turn' : 'turns'}`}
        </button>

        {expanded ? (
          <TurnsDrawer
            loading={turnsQ.isPending}
            error={turnsQ.isError}
            turns={turnsQ.data ?? []}
          />
        ) : null}
      </div>
    </li>
  );
});

// ---- a prompt/response preview line (text-node only; truncation shows an ellipsis cue) ----
const PreviewLine = memo(function PreviewLine({
  kind,
  preview,
}: {
  kind: 'prompt' | 'response';
  preview: Preview;
}) {
  if (!preview.text || preview.text.trim() === '') return null;
  return (
    <div className={`story-preview story-preview-${kind}`}>
      <span className="story-preview-role">{kind === 'prompt' ? 'prompt' : 'response'}</span>
      <span className="story-preview-text">
        {preview.text}
        {preview.truncated ? <span className="story-preview-trunc"> …</span> : null}
      </span>
    </div>
  );
});

const WorkflowSpawnChip = memo(function WorkflowSpawnChip({ spawn }: { spawn: WorkflowSpawn }) {
  // M3: when the spawn resolves to a run, the chip is a BUTTON that opens that run in the
  // Workflows page; otherwise it stays an inert label (no run matched → nothing to open).
  const nav = useContext(SpawnNavContext);
  const openable = nav ? nav.canOpen(spawn) : false;
  const inner = (
    <>
      <span className="story-chip-glyph" aria-hidden="true">⧉</span>
      <span className="story-chip-label">{spawn.scriptBasename}</span>
      {openable ? (
        <span className="story-chip-open" aria-hidden="true">↗</span>
      ) : null}
    </>
  );
  if (openable && nav) {
    return (
      <button
        type="button"
        className="story-chip story-chip-spawn story-chip-spawn-open"
        title={`open this run in Workflows · ${spawn.scriptBasename}`}
        onClick={() => nav.onOpen(spawn)}
      >
        {inner}
      </button>
    );
  }
  return (
    <span className="story-chip story-chip-spawn" title={`args ${spawn.argsDigest}`}>
      {inner}
    </span>
  );
});

const CommitChip = memo(function CommitChip({ commit }: { commit: GitCommitRef }) {
  // The subject is always a TEXT node; the link is built only from a validated github.com URL
  // (the adapter validates the SHA + fixes the host — no free-form remote parsing reaches here).
  const inner = (
    <>
      <span className="story-commit-sha">{commit.shortSha.slice(0, 7)}</span>
      <span className="story-commit-subject">{commit.subject}</span>
    </>
  );
  if (commit.githubUrl) {
    return (
      <a
        className="story-chip story-chip-commit"
        href={commit.githubUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={commit.subject}
      >
        {inner}
      </a>
    );
  }
  return (
    <span className="story-chip story-chip-commit" title={commit.subject}>
      {inner}
    </span>
  );
});

// ---- Level 3: the full-turns drawer (rendered only while a block is expanded) -------------
const TurnsDrawer = memo(function TurnsDrawer({
  loading,
  error,
  turns,
}: {
  loading: boolean;
  error: boolean;
  turns: Turn[];
}) {
  if (loading) return <div className="story-turns story-turns-muted">loading turns…</div>;
  if (error) return <div className="story-turns story-turns-muted">failed to load turns</div>;
  if (turns.length === 0) return <div className="story-turns story-turns-muted">no turns</div>;
  return (
    <ul className="story-turns" aria-label="turns">
      {/* `promptId` is the ORIGINATING prompt's id — shared across every record in a block, so
          it is NOT unique per turn. Key on the positional index (the slice never reorders). */}
      {turns.map((t, i) => (
        <TurnRow key={`${i}:${t.promptId}`} turn={t} />
      ))}
    </ul>
  );
});

// A clear label per turn role — 'result'/'conductor' are NOT the human (the agent's tool loop /
// a program driving the session), so they read distinctly from a human 'user' prompt.
const TURN_ROLE_LABEL: Record<Turn['role'], string> = {
  user: 'user',
  assistant: 'assistant',
  conductor: 'conductor',
  result: 'tool result',
};

const TurnRow = memo(function TurnRow({ turn: t }: { turn: Turn }) {
  // AskUserQuestion turns are DECISION POINTS — render the question + options inline (not a bare
  // tool chip). The other tool calls render as the usual compact chips.
  const asks = t.toolCalls.flatMap((tc) => tc.ask ?? []);
  const plainTools = t.toolCalls.filter((tc) => !tc.ask || tc.ask.length === 0);
  return (
    <li className={`story-turn story-turn-${t.role}`}>
      <div className="story-turn-head">
        <span className="story-turn-role">{TURN_ROLE_LABEL[t.role]}</span>
        {t.timestamp ? <span className="story-turn-time">{clockIso(t.timestamp)}</span> : null}
      </div>
      {t.textPreview.text && t.textPreview.text.trim() !== '' ? (
        <div className="story-turn-text">
          {t.textPreview.text}
          {t.textPreview.truncated ? <span className="story-preview-trunc"> …</span> : null}
        </div>
      ) : null}
      {asks.map((q, i) => (
        <AskBlock key={`ask-${i}`} q={q} />
      ))}
      {plainTools.length > 0 ? (
        <div className="story-turn-tools">
          {plainTools.map((tc, i) => (
            <span className="story-turn-tool" key={`${tc.name}:${i}`} title={tc.briefArgs}>
              <span className="story-turn-tool-name">{tc.name}</span>
              {tc.briefArgs ? <span className="story-turn-tool-args">{tc.briefArgs}</span> : null}
            </span>
          ))}
        </div>
      ) : null}
    </li>
  );
});

// An AskUserQuestion decision point rendered inline in the turn: the question + its options.
const AskBlock = memo(function AskBlock({ q }: { q: AskQuestion }) {
  return (
    <div className="story-ask" aria-label="question asked of the user">
      <div className="story-ask-head">
        <span className="story-ask-tag">asked{q.multiSelect ? ' · multi-select' : ''}</span>
        {q.header ? <span className="story-ask-header">{q.header}</span> : null}
      </div>
      <div className="story-ask-question">{q.question}</div>
      {q.options.length > 0 ? (
        <ul className="story-ask-options">
          {q.options.map((o, i) => (
            <li className="story-ask-option" key={`${o.label}:${i}`}>
              <span className="story-ask-option-label">{o.label}</span>
              {o.description ? <span className="story-ask-option-desc">{o.description}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
});
