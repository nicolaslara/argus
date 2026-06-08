// @argus/contract — Session Narrative wire types ("Story" view). Shared by server
// & web; NO runtime deps, types-only (no zod). The adapter (packages/adapter/src/
// transcript.ts) is the ONLY module that maps the raw `<sessionId>.jsonl` transcript
// onto these shapes; the web imports ONLY @argus/contract.
//
// These are the ratified shapes from workpads/narrative/knowledge.md §"Data model"
// (locked 2026-06-07). The model follows project → sessions-on-a-timeline →
// per-session topic blocks → (lazy) full turns. Two invariants are baked in:
//   - ALL emitted text (promptPreview, responsePreview, Turn.textPreview) is the
//     existing truncated `Preview {text, truncated}` — the wire never carries a full
//     body in the watch view, and long assistant responses are bounded to head+tail.
//   - tool_result image / tool_reference blocks are dropped in the adapter with a
//     counted AdapterWarning; NO image bytes ever reach a NarrativeRecord or the wire.

import type { Preview, AdapterWarning } from './index.ts';

/**
 * Observed-format pin for the transcript surface. Stamped onto every SessionNarrative
 * (and reported on /health, M1) so a format drift is caught at the seam, NOT silently
 * mis-parsed. Mirrors the adapter's ADAPTER_FORMAT pin (boundaries §9). Distinct from
 * the workflow-run format because the transcript is a different on-disk shape.
 */
export const NARRATIVE_FORMAT = 'cc-transcript/observed-2026-06-07' as const;

/** An inclusive line-index range into the transcript JSONL (0-based record indices). */
export interface RecordRange {
  /** First record line (inclusive). */
  start: number;
  /** Last record line (inclusive). */
  end: number;
}

/** An ISO-timestamp span. Either end may be null when the transcript omits timestamps. */
export interface TimeRange {
  start: string | null;
  end: string | null;
}

/**
 * One `Workflow` tool_use launch observed inside a block (`{name:'Workflow',
 * input:{scriptPath, args}}`). `runId` is the correlated `wf_*.json` run id when M3
 * resolves it, else null (M0 emits the spawn with `runId:null` — correlation is a
 * later, off-critical-path milestone). `scriptBasename` is the basename of the
 * launched script (path-building/display only); `argsDigest` is a short stable digest
 * of the launch args (never the raw args object — keeps the wire small + secret-free).
 */
export interface WorkflowSpawn {
  runId: string | null;
  scriptBasename: string;
  timestamp: string | null;
  argsDigest: string;
}

/**
 * A best-effort git-commit reference correlated to a block (M2, timestamp + message
 * match against the repo's real `git log`). `shortSha` is validated `/^[0-9a-f]{7,40}$/`;
 * `githubUrl` is built ONLY from a fixed `github.com` host + `/commit/<validatedSha>`
 * (no free-form remote parsing — prevents link-injection from untrusted stdout), and is
 * null when no SHA validated. `subject` is rendered as a TEXT node, never as link text.
 * `subsystems` are path-prefix chips (M2), null until computed. M0 emits an empty list.
 */
export interface GitCommitRef {
  shortSha: string;
  subject: string;
  timestamp: string | null;
  githubUrl: string | null;
  subsystems: string[] | null;
}

/**
 * The LLM-enriched summary of a block (M4; opt-in, cached by boundary projection).
 * Mirrors NodeExplanation's annotation-only posture. `null` on a block while baseline
 * (M0–M3 emit zero summaries — a real narrative with no model spend). `promptVersion`
 * is the SEGMENT_PROMPT_VERSION the caption was produced under (cache-key provenance).
 */
export interface NarrativeSummary {
  caption: string;
  body: string;
  intent: string;
  pattern: string | null;
  promptVersion: string;
}

/**
 * Why a block was cut. The ONLY cut signal in M0 is the real-user-prompt boundary
 * (knowledge.md decision 3): every block opens on a real prompt, except the very first
 * block of a session which may open on `session-start` (records before the first real
 * prompt). Time-gap / file-set become optional SUB-splitters in a later milestone.
 */
export type CutReason = 'prompt' | 'session-start';

/**
 * One topic block: `[one real user prompt] → [all following assistant work, tool calls,
 * spawned workflows, and commits until the NEXT real user prompt]` (knowledge.md
 * decision 3). Computed in a single-pass O(n) scan. `id` is a stable hash of the record
 * range + boundary timestamps (so it survives a re-scan and keys the M4 summary cache).
 * `toolCounts` is `toolName → count`. `filesTouched` is BASENAMES only (decision 9 —
 * never full paths, never file contents). The two previews are the watch-view text and
 * are head+tail-bounded; full turns are fetched lazily (see {@link Turn}), never inlined.
 */
export interface NarrativeBlock {
  /** Stable hash of recordRange + boundary timestamps; keys the summary cache. */
  id: string;
  recordRange: RecordRange;
  timeRange: TimeRange;
  /** A short topic label, when derivable (M0: from the prompt's first line); else null. */
  topicLabel: string | null;
  cutReason: CutReason;
  /** Count of (user+assistant) turns in the block. */
  turnCount: number;
  /** toolName → invocation count across the block. */
  toolCounts: Record<string, number>;
  /**
   * AskUserQuestion decision points in this block (question + options), surfaced in the WATCH view
   * so the user can expand them without clicking into every turn. Bounded + redact()-routed by the
   * segmenter; `toolCounts['AskUserQuestion']` is the authoritative count if more were asked.
   */
  asks: AskQuestion[];
  workflowSpawns: WorkflowSpawn[];
  /** Best-effort commit refs (M2); M0 emits []. */
  gitCommits: GitCommitRef[];
  /** Basenames only (decision 9); never full paths / contents. */
  filesTouched: string[];
  /** The real user prompt, redact()-routed + capped. */
  promptPreview: Preview;
  /** The assistant response, head+tail-bounded, redact()-routed + capped. */
  responsePreview: Preview;
  /** LLM caption (M4, opt-in); null while baseline. */
  summary: NarrativeSummary | null;
}

/**
 * The Stage-1 narrative for ONE session (`<sessionId>.jsonl`). Built by the adapter's
 * transcript segmenter, server-pre-computed + disk-cached (M1), facts-only (zero LLM,
 * zero off-machine). `incomplete` is true when the parse degraded (e.g. a torn final
 * line, an over-cap line skipped) — `warnings` then carries the coded reasons.
 * `totalRecords` is the raw JSONL record count (NOT block count). `format` is the
 * {@link NARRATIVE_FORMAT} pin.
 */
export interface SessionNarrative {
  sessionId: string;
  /** Recovered absolute project cwd (authoritative), when known; else null. */
  projectPath: string | null;
  timeRange: TimeRange;
  /** Raw JSONL record count. */
  totalRecords: number;
  blocks: NarrativeBlock[];
  /** NARRATIVE_FORMAT pin. */
  format: string;
  /** True when the parse degraded; reasons in `warnings`. */
  incomplete: boolean;
  warnings: AdapterWarning[];
}

/**
 * A cheap per-session summary row for the project session-timeline (knowledge.md
 * refinement 3 + decision: `discoverSessions(slug)`). Built from a HEAD/TAIL read only
 * (first/last record timestamp) + lightweight counts — NOT a full segment pass — so the
 * timeline renders without parsing every 67 MB file. Each session is a start→end span.
 */
export interface SessionSummary {
  sessionId: string;
  /** Recovered absolute project cwd, when known; else null. */
  projectPath: string | null;
  /** First→last record timestamp span. */
  timeRange: TimeRange;
  /** Raw JSONL record count (cheap line count). */
  recordCount: number;
  /** Count of observed `Workflow` tool_use launches (cheap scan), when computed. */
  workflowSpawnCount: number;
  /** Count of best-effort in-session commits (M2), when computed; 0 in M0. */
  commitCount: number;
}

/**
 * A project's sessions on a timeline — the top level of the Story view (project →
 * sessions-on-a-timeline → per-session blocks). `slug` is the on-disk dir name
 * (path-building only); `projectPath` is the recovered authoritative cwd. `sessions`
 * are the start→end spans, ordered by start time (ascending) by convention.
 */
export interface ProjectSessions {
  /** Recovered absolute project cwd (authoritative), when known; else null. */
  projectPath: string | null;
  /** On-disk slug dir name (kept for path-building only). */
  slug: string;
  sessions: SessionSummary[];
}

/**
 * The role of a turn record. Beyond the human 'user' and the 'assistant', we distinguish the
 * non-human "user"-role records so the Story doesn't read agent self-talk as a human:
 *   - 'conductor' — a PROGRAM drove this prompt (a headless `claude -p` / subagent; promptSource
 *     'sdk'). The driver is the orchestrator, not a person.
 *   - 'result' — a tool_result fed back to the agent (role 'user' on disk, but it's the tool
 *     harness, i.e. the agent's own loop), e.g. a Bash command's output.
 */
export type TurnRole = 'user' | 'assistant' | 'conductor' | 'result';

/** One option offered by an `AskUserQuestion` (label + its explanation). Both redact()-routed. */
export interface AskOption {
  label: string;
  description: string;
}
/**
 * One `AskUserQuestion` question — a session DECISION POINT, surfaced inline in the Story
 * turns (not a bare tool row). `header` is the short chip label; `options` are the offered
 * choices. All text is truncated + redact()-routed by the adapter.
 */
export interface AskQuestion {
  question: string;
  header: string | null;
  multiSelect: boolean;
  options: AskOption[];
}

/** One tool invocation inside a turn (click-in view). `briefArgs` is a short, redacted digest — never the raw args. */
export interface TurnToolCall {
  name: string;
  briefArgs: string;
  /**
   * Present ONLY when `name === 'AskUserQuestion'`: the question(s) + options asked, so the Story
   * renders the decision point inline instead of an opaque tool row. Truncated + redact()-routed.
   */
  ask?: AskQuestion[];
}

/**
 * One full turn in a block — CLICK-IN ONLY, fetched lazily by the M1 `/turns?block=`
 * endpoint, NEVER inlined into the block list (so the watch view stays small). All text
 * is the truncated, redact()-routed {@link Preview}; tool calls carry only a brief,
 * redacted args digest. `promptId` is the source record's UUID.
 */
export interface Turn {
  promptId: string;
  timestamp: string | null;
  role: TurnRole;
  textPreview: Preview;
  toolCalls: TurnToolCall[];
}
