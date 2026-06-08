// @argus/adapter — the SESSION NARRATIVE engine. The ONLY module that knows the raw
// on-disk `<sessionId>.jsonl` Claude Code TRANSCRIPT shape (a SIBLING file to the
// `<sessionId>/` dir). Maps that transcript onto the @argus/contract narrative types.
//
// PURE — no `node:fs`. Disk is read by the caller through the injected FileSystemPort
// (exactly like loadRun/loadLiveModel); the pure builders here take the transcript TEXT
// so a fixture/replay is a first-class test. Grounded on the REAL 67 MB transcript
// (workpads/narrative/knowledge.md, probed 2026-06-07). Defensive-parse posture mirrors
// raw.ts/live.ts (boundaries.md §2.3): a single bad line is counted + skipped, never
// fatal; only explicit fields are projected (parsed JSON is NEVER spread); NEVER throws.
//
// THE LOAD-BEARING RULES (knowledge.md locked decisions 2 + 3):
//   - `tool_result.content` (and a message `content`) is a defensive `string | block[]`
//     union. We project ONLY `{type:'text'}.text`; image / tool_reference blocks are
//     DROPPED with a counted warning. NO image bytes ever reach a NarrativeRecord, a
//     Preview, the wire, or an LLM prompt.
//   - A block opens on a REAL user prompt and runs until the NEXT real user prompt. The
//     single most load-bearing parse rule is FILTERING synthetic user records (isMeta /
//     tool_result carriers / the SYNTHETIC_PREFIXES markers — slash-command echoes, the
//     `<task-notification>` background events, `[Request interrupted…]`, and the compaction
//     handoff summary) so they never start a block nor leak into a promptPreview.
//   - Long assistant responses are BOUNDED to head+tail (first + last RESPONSE_HEADTAIL
//     bytes) in the preview — we never hold or emit a whole multi-MB response.

import type {
  Preview,
  AdapterWarning,
  SessionNarrative,
  NarrativeBlock,
  WorkflowSpawn,
  TimeRange,
  CutReason,
  SessionSummary,
  Turn,
  TurnRole,
  TurnToolCall,
  AskQuestion,
  AskOption,
} from '@argus/contract';
import { NARRATIVE_FORMAT } from '@argus/contract';
import { redact } from './redact.ts';
import { recoverProjectPath } from './index.ts';

/**
 * Re-pinned locally (it lives in @argus/contract) so the engine + tests can assert the
 * stamp without re-importing the contract everywhere. Asserted equal to the contract pin
 * by a unit test (mirrors live.ts's ADAPTER_FORMAT_LIVE pattern).
 */
export const NARRATIVE_FORMAT_ENGINE = NARRATIVE_FORMAT;

/**
 * Hard per-line byte cap applied BEFORE JSON.parse. There is a REAL ~2 MB line in the
 * transcript and 45 lines over 256 KB; parsing those is wasted work (their content is
 * never projected) and a memory risk. An over-cap line is SKIPPED with a coded warning,
 * never parsed, never throws. 256 KB matches knowledge.md decision 5.
 */
export const MAX_LINE_BYTES = 256 * 1024;

/**
 * Per-end byte budget for a head+tail-bounded assistant response preview. A long response
 * is reduced to its first + last RESPONSE_HEADTAIL bytes (joined by an elision marker) so
 * the engine NEVER holds or emits a whole multi-MB body. The watch view reads only this.
 */
export const RESPONSE_HEADTAIL = 8 * 1024;

/** Per-end byte budget for a user prompt preview (prompts are short; head+tail is plenty). */
export const PROMPT_HEADTAIL = 8 * 1024;

/** Elision marker inserted between the head and tail of a bounded preview. */
const ELISION = '\n…\n';

// --- raw transcript record (defensive, internal-only) -----------------------

/** A single content block inside a message / tool_result `content[]`. Defensive shape. */
interface RawBlock {
  type?: unknown;
  text?: unknown;
  name?: unknown;
  input?: unknown;
  content?: unknown; // tool_result blocks nest their own content (string | block[])
}

/** A parsed transcript record (only the fields the engine reads; never spread). */
interface RawRecord {
  type: string;
  /** message.role (user records: 'user'; assistant: 'assistant'). */
  role: string | null;
  /** message.content as a defensive union — string OR block[]. */
  content: string | RawBlock[] | null;
  timestamp: string | null;
  promptId: string | null;
  userType: string | null;
  isMeta: boolean;
  /**
   * How a user prompt entered the session: 'typed'/'queued' = a human; 'sdk' = a PROGRAM drove it
   * (a headless `claude -p` / subagent — the CONDUCTOR, not a human); 'system' = harness-injected.
   * Drives the turn-role labeling so conductor/tool turns aren't mistaken for the human.
   */
  promptSource: string | null;
  /** Recovered cwd, when the record carries one (used for projectPath). */
  cwd: string | null;
}

/** The result of a defensive line scan over the transcript text. NEVER throws. */
export interface ScannedTranscript {
  records: RawRecord[];
  /** Raw line count (every non-empty line, including skipped ones). */
  totalLines: number;
  warnings: AdapterWarning[];
  /** True when any line was skipped / torn (the parse degraded). */
  incomplete: boolean;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * Project a record's `message.content` (string | block[]) into the defensive union we
 * keep internally. We NEVER spread the parsed object; only `type`/`text`/`name`/`input`/
 * `content` are read downstream, and image `source.data` is never even referenced.
 */
function projectContent(raw: unknown): string | RawBlock[] | null {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    const out: RawBlock[] = [];
    for (const b of raw) {
      if (!b || typeof b !== 'object') continue;
      const rec = b as Record<string, unknown>;
      out.push({
        type: rec.type,
        text: rec.text,
        name: rec.name,
        input: rec.input,
        content: rec.content,
      });
    }
    return out;
  }
  return null;
}

/**
 * Defensively scan transcript TEXT into ordered records (LINE-INDEPENDENT, like
 * parseJournal). For each line:
 *   - empty line → skipped (not counted in totalLines).
 *   - byte length > MAX_LINE_BYTES → SKIPPED before JSON.parse, counted in totalLines,
 *     `transcript-line-over-cap` warning (the real 2 MB line; never parsed).
 *   - JSON.parse failure / non-object → counted, `transcript-bad-line` warning.
 * Only explicit fields are projected. NEVER throws.
 */
export function scanTranscript(text: string): ScannedTranscript {
  const records: RawRecord[] = [];
  const warnings: AdapterWarning[] = [];
  let totalLines = 0;
  let overCap = 0;
  let badLines = 0;

  for (const rawLine of text.split('\n')) {
    if (rawLine.length === 0) continue;
    const line = rawLine.trim();
    if (line.length === 0) continue;
    totalLines += 1;

    // Byte cap BEFORE JSON.parse — measure UTF-8 bytes, not UTF-16 code units, so a
    // multibyte line near the cap is judged honestly. The 2 MB line is skipped here.
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      overCap += 1;
      continue;
    }

    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      badLines += 1;
      continue;
    }
    if (!o || typeof o !== 'object') {
      badLines += 1;
      continue;
    }
    const rec = o as Record<string, unknown>;
    const type = asString(rec.type);
    if (type === null) {
      badLines += 1;
      continue;
    }
    const message =
      rec.message && typeof rec.message === 'object' ? (rec.message as Record<string, unknown>) : null;

    records.push({
      type,
      role: message ? asString(message.role) : null,
      content: message ? projectContent(message.content) : null,
      timestamp: asString(rec.timestamp),
      promptId: asString(rec.promptId),
      userType: asString(rec.userType),
      isMeta: rec.isMeta === true,
      promptSource: asString(rec.promptSource),
      cwd: asString(rec.cwd),
    });
  }

  if (overCap > 0) warnings.push({ code: 'transcript-line-over-cap', detail: String(overCap) });
  if (badLines > 0) warnings.push({ code: 'transcript-bad-line', detail: String(badLines) });

  return { records, totalLines, warnings, incomplete: overCap > 0 || badLines > 0 };
}

// --- text projection (the image-drop allowlist) -----------------------------

/** The outcome of projecting a content union to plain text: text + a dropped-block tally. */
export interface ProjectedText {
  text: string;
  /** Count of image blocks dropped (NO bytes projected). */
  droppedImages: number;
  /** Count of tool_reference (and other non-text) blocks dropped. */
  droppedOther: number;
}

/**
 * Project a content union (`string | block[]`) to PLAIN TEXT, allowlisting ONLY
 * `{type:'text'}.text`. Image blocks are DROPPED (their base64 `source.data` is never
 * touched) and counted; tool_reference / unknown blocks are dropped + counted separately.
 * A `tool_result` block nests its OWN content (string | block[]) — recurse one level so a
 * Playwright screenshot tool_result contributes its text but ZERO image bytes. NEVER throws.
 */
export function projectText(content: string | RawBlock[] | null): ProjectedText {
  if (content === null) return { text: '', droppedImages: 0, droppedOther: 0 };
  if (typeof content === 'string') return { text: content, droppedImages: 0, droppedOther: 0 };

  const parts: string[] = [];
  let droppedImages = 0;
  let droppedOther = 0;

  for (const b of content) {
    const t = asString(b.type);
    if (t === 'text') {
      const s = asString(b.text);
      if (s !== null) parts.push(s);
      else droppedOther += 1;
    } else if (t === 'image') {
      // NEVER read b.source / b.source.data — drop the whole block, count it.
      droppedImages += 1;
    } else if (t === 'tool_result') {
      // tool_result nests its own content union — recurse ONE level (text only).
      const inner = projectText(projectContent(b.content));
      if (inner.text.length > 0) parts.push(inner.text);
      droppedImages += inner.droppedImages;
      droppedOther += inner.droppedOther;
    } else if (t === 'tool_use' || t === 'thinking') {
      // tool_use args / thinking are handled by dedicated extractors (toolCounts /
      // workflowSpawns / filesTouched), not folded into the response text body.
      droppedOther += 1;
    } else {
      // tool_reference + any unknown block → dropped + counted.
      droppedOther += 1;
    }
  }
  return { text: parts.join('\n'), droppedImages, droppedOther };
}

// --- real-user-prompt detection (THE load-bearing filter) -------------------

// HARNESS-injected user-role records that are NOT user prompts. They all arrive as
// type:'user' / role:'user' / userType:'external' / non-meta (so no structural flag
// separates them) — only their leading text betrays them. Observed on the real argus
// session (d2cfe0e6): `<task-notification>` ×58 (background-task events), the compaction
// handoff summary ×5, `[Request interrupted…]` ×2. Without these, each would falsely
// anchor a topic block (knowledge.md decision 3 — the load-bearing synthetic filter).
const SYNTHETIC_PREFIXES = [
  '<command',
  '<local-command',
  'Caveat',
  '<task-notification>', // background-task lifecycle events injected mid-session
  '[Request interrupted', // a user-interrupt marker (variants: "…by user", "…for tool use")
  'This session is being continued from a previous conversation', // the compaction handoff summary
];

/** True if a content block list carries a `tool_result` block (a tool_result CARRIER). */
function hasToolResult(content: string | RawBlock[] | null): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((b) => asString(b.type) === 'tool_result');
}

/** The first text seen in a content union (string → itself; block[] → first `text` block). */
function firstText(content: string | RawBlock[] | null): string | null {
  if (content === null) return null;
  if (typeof content === 'string') return content;
  for (const b of content) {
    if (asString(b.type) === 'text') {
      const s = asString(b.text);
      if (s !== null) return s;
    }
  }
  return null;
}

/**
 * THE single most load-bearing parse rule (knowledge.md decision 3). A REAL user prompt is
 * a record with:
 *   - `type === 'user'` && `role === 'user'` && `userType === 'external'`, and
 *   - NOT `isMeta`, and
 *   - NOT a tool_result carrier (its content has a tool_result block), and
 *   - whose FIRST content text is a non-empty string NOT starting with any
 *     {@link SYNTHETIC_PREFIXES} marker (`<command` / `<local-command` / `Caveat` /
 *     `<task-notification>` / `[Request interrupted` / the compaction handoff summary).
 * Everything else among the user records (tool_result carriers + ~67 harness-injected
 * synthetic markers) is filtered: it never starts a block and never leaks into a promptPreview.
 */
export function isRealUserPrompt(r: RawRecord): boolean {
  if (r.type !== 'user' || r.role !== 'user' || r.userType !== 'external') return false;
  if (r.isMeta) return false;
  if (hasToolResult(r.content)) return false;
  const text = firstText(r.content);
  if (text === null || text.length === 0) return false;
  return !SYNTHETIC_PREFIXES.some((p) => text.startsWith(p));
}

/**
 * A HARNESS-INJECTED user record (a slash-command echo, the `<task-notification>` events, an
 * interrupt marker, the compaction handoff summary) that is NOT a real prompt. Beyond never
 * ANCHORING a block (that's {@link isRealUserPrompt}), such a record must not contribute its
 * synthetic text — `<task-notification>…`, `<local-command-caveat>Caveat:…` — to a block's
 * response preview or its turn count either. Detected by the same {@link SYNTHETIC_PREFIXES}.
 * (tool_result carriers project to empty text, so they need no special handling here.)
 */
function isSyntheticUserRecord(r: RawRecord): boolean {
  if (r.type !== 'user') return false;
  const text = firstText(r.content);
  if (text === null) return false;
  return SYNTHETIC_PREFIXES.some((p) => text.startsWith(p));
}

// --- per-block extractors ---------------------------------------------------

/** Increment a toolName → count map for every `tool_use` block in an assistant record. */
function countTools(r: RawRecord, into: Record<string, number>): void {
  if (r.type !== 'assistant' || !Array.isArray(r.content)) return;
  for (const b of r.content) {
    if (asString(b.type) !== 'tool_use') continue;
    const name = asString(b.name) ?? 'unknown';
    into[name] = (into[name] ?? 0) + 1;
  }
}

/**
 * Extract every `Workflow` tool_use launch (`{name:'Workflow', input:{scriptPath, args}}`)
 * from an assistant record. `scriptBasename` is the basename of the launched script (display
 * / path-building only); `argsDigest` is a SHORT stable digest of the args (never the raw
 * args object — keeps the wire small + secret-free). `runId` is null in M0 (correlation is
 * M3). NEVER throws. Defensive: a Workflow block missing a usable scriptPath is skipped.
 */
export function extractWorkflowSpawns(r: RawRecord): WorkflowSpawn[] {
  if (r.type !== 'assistant' || !Array.isArray(r.content)) return [];
  const out: WorkflowSpawn[] = [];
  for (const b of r.content) {
    if (asString(b.type) !== 'tool_use' || asString(b.name) !== 'Workflow') continue;
    const input = b.input && typeof b.input === 'object' ? (b.input as Record<string, unknown>) : {};
    const scriptPath = asString(input.scriptPath);
    if (scriptPath === null) continue;
    const scriptBasename = scriptPath.split(/[/\\]/).pop() ?? scriptPath;
    out.push({
      runId: null,
      scriptBasename,
      timestamp: r.timestamp,
      argsDigest: digestArgs(input.args),
    });
  }
  return out;
}

/** A short stable digest of launch args (never the raw object). Length-bounded; no secrets inlined. */
function digestArgs(args: unknown): string {
  if (args === undefined || args === null) return '';
  const s = typeof args === 'string' ? args : safeStringify(args);
  return s.length > 120 ? s.slice(0, 120) : s;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}

/** Collect BASENAMES (decision 9 — never full paths) touched by Read/Edit/Write tool_use. */
function collectFilesTouched(r: RawRecord, into: Set<string>): void {
  if (r.type !== 'assistant' || !Array.isArray(r.content)) return;
  for (const b of r.content) {
    if (asString(b.type) !== 'tool_use') continue;
    const name = asString(b.name);
    if (name !== 'Read' && name !== 'Edit' && name !== 'Write') continue;
    const input = b.input && typeof b.input === 'object' ? (b.input as Record<string, unknown>) : {};
    const fp = asString(input.file_path);
    if (fp === null) continue;
    const base = fp.split(/[/\\]/).pop();
    if (base && base.length > 0) into.add(base);
  }
}

// --- preview bounding (head+tail) -------------------------------------------

/**
 * Bound a text to its first + last `perEnd` BYTES (UTF-8), joined by an elision marker, then
 * route the result through {@link redact}. A response shorter than the combined budget is
 * returned whole (still redacted). `truncated` is true when the source exceeded the budget.
 * We never hold the WHOLE response beyond this call — the caller slices it once and drops it.
 * Boundary-safe: we slice on a character boundary by working in code units but capping bytes.
 */
export function boundedPreview(text: string, perEnd: number): Preview {
  const totalBytes = Buffer.byteLength(text, 'utf8');
  if (totalBytes <= perEnd * 2 + ELISION.length) {
    return { text: redact(text), truncated: false };
  }
  const head = sliceBytes(text, perEnd, 'head');
  const tail = sliceBytes(text, perEnd, 'tail');
  return { text: redact(head + ELISION + tail), truncated: true };
}

/**
 * Slice up to `maxBytes` UTF-8 bytes from the head or tail of `s`, never splitting a
 * surrogate pair / multibyte char. Pure; never throws.
 */
function sliceBytes(s: string, maxBytes: number, which: 'head' | 'tail'): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  if (which === 'head') {
    // Grow a code-unit window until adding the next char would exceed maxBytes.
    let end = 0;
    let bytes = 0;
    while (end < s.length) {
      const cp = s.codePointAt(end)!;
      const step = cp > 0xffff ? 2 : 1;
      const chBytes = Buffer.byteLength(s.slice(end, end + step), 'utf8');
      if (bytes + chBytes > maxBytes) break;
      bytes += chBytes;
      end += step;
    }
    return s.slice(0, end);
  }
  // tail: grow from the end.
  let start = s.length;
  let bytes = 0;
  while (start > 0) {
    // Step back one code point (account for a low surrogate).
    let step = 1;
    if (start >= 2) {
      const prev = s.charCodeAt(start - 1);
      const prev2 = s.charCodeAt(start - 2);
      if (prev >= 0xdc00 && prev <= 0xdfff && prev2 >= 0xd800 && prev2 <= 0xdbff) step = 2;
    }
    const chBytes = Buffer.byteLength(s.slice(start - step, start), 'utf8');
    if (bytes + chBytes > maxBytes) break;
    bytes += chBytes;
    start -= step;
  }
  return s.slice(start);
}

// --- segmentation (single-pass O(n), real-prompt anchored) ------------------

function earliest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a <= b ? a : b;
}

function latest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}

/**
 * Stable block id: a short hash of the record range + boundary timestamps (NOT content),
 * so it survives a re-scan and keys the M4 summary cache (knowledge.md decision 8). FNV-1a
 * over a stable projection — no crypto dep, deterministic, collision-safe enough for an id.
 */
function blockId(range: { start: number; end: number }, time: TimeRange): string {
  const key = `${range.start}:${range.end}:${time.start ?? ''}:${time.end ?? ''}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * The accumulator for the block currently being built during the single-pass scan. Holds the
 * response text incrementally but is sliced to a head+tail preview the instant the block
 * closes — we never carry a multi-MB body past block close (knowledge.md decision 5 / B-pick).
 */
interface BlockBuilder {
  start: number;
  cutReason: CutReason;
  promptText: string;
  responseParts: string[];
  /** Running byte tally of responseParts so we can bound memory even mid-block. */
  responseBytes: number;
  timeStart: string | null;
  timeEnd: string | null;
  turnCount: number;
  toolCounts: Record<string, number>;
  asks: AskQuestion[];
  workflowSpawns: WorkflowSpawn[];
  files: Set<string>;
}

/** Cap on the AskUserQuestion decision points retained per block (the watch-view expand). */
const BLOCK_ASKS_CAP = 12;

/**
 * Cap on the response bytes we retain WHILE a block is open. Even before close we never let a
 * single open block hold more than head+tail+slack worth of response text, so a block with a
 * 60 MB assistant body never balloons memory. We keep the head greedily and a sliding tail.
 */
const OPEN_BLOCK_RESPONSE_CAP = RESPONSE_HEADTAIL * 4;

function newBuilder(start: number, cutReason: CutReason): BlockBuilder {
  return {
    start,
    cutReason,
    promptText: '',
    responseParts: [],
    responseBytes: 0,
    timeStart: null,
    timeEnd: null,
    turnCount: 0,
    toolCounts: {},
    asks: [],
    workflowSpawns: [],
    files: new Set<string>(),
  };
}

/** Collect AskUserQuestion decision points from an assistant record into a block (capped). */
function collectAsks(r: RawRecord, into: AskQuestion[]): void {
  if (r.type !== 'assistant' || !Array.isArray(r.content)) return;
  for (const b of r.content) {
    if (asString(b.type) !== 'tool_use' || asString(b.name) !== 'AskUserQuestion') continue;
    if (into.length >= BLOCK_ASKS_CAP) return;
    const asks = extractAskQuestions(b.input);
    if (asks) for (const q of asks) {
      if (into.length >= BLOCK_ASKS_CAP) break;
      into.push(q);
    }
  }
}

function finishBlock(b: BlockBuilder, end: number): NarrativeBlock {
  const timeRange: TimeRange = { start: b.timeStart, end: b.timeEnd };
  const recordRange = { start: b.start, end };
  const responseText = b.responseParts.join('\n');
  const promptPreview = boundedPreview(b.promptText, PROMPT_HEADTAIL);
  const responsePreview = boundedPreview(responseText, RESPONSE_HEADTAIL);
  // topicLabel: first non-empty line of the prompt, redacted + length-bounded.
  const firstLine = b.promptText.split('\n').find((l) => l.trim().length > 0) ?? '';
  const topicLabel = firstLine.length > 0 ? redact(firstLine.slice(0, 120)) : null;

  return {
    id: blockId(recordRange, timeRange),
    recordRange,
    timeRange,
    topicLabel,
    cutReason: b.cutReason,
    turnCount: b.turnCount,
    toolCounts: b.toolCounts,
    asks: b.asks,
    workflowSpawns: b.workflowSpawns,
    gitCommits: [], // M0 emits []; M2 correlates by timestamp.
    filesTouched: [...b.files],
    promptPreview,
    responsePreview,
    summary: null, // M0 baseline — zero LLM spend.
  };
}

/**
 * Emit a finished block UNLESS it is an empty session-start shell. A transcript opens with a
 * synthetic/system preamble (slash-command echoes, `<task-notification>` events, system records)
 * before the first real prompt; once those are filtered, the implicit session-start block can end
 * up with zero turns and no content — it would render as a blank "Session start" card. A 'prompt'
 * block always carries its prompt, so `turnCount === 0` uniquely identifies the empty preamble
 * (no turns ⟹ no previews/tools/spawns/files, since those only come from counted user/assistant
 * records). Dropping it loses nothing real.
 */
function pushBlock(blocks: NarrativeBlock[], block: NarrativeBlock): void {
  if (block.cutReason === 'session-start' && block.turnCount === 0) return;
  blocks.push(block);
}

/** Append response text to an open builder, keeping only head+tail-worth of bytes (memory bound). */
function appendResponse(b: BlockBuilder, text: string): void {
  if (text.length === 0) return;
  b.responseParts.push(text);
  b.responseBytes += Buffer.byteLength(text, 'utf8');
  if (b.responseBytes <= OPEN_BLOCK_RESPONSE_CAP) return;
  // Compact: keep the first part (head) + collapse the rest into a single sliding tail so an
  // open block never balloons. The final boundedPreview re-bounds precisely on close.
  const headPart = b.responseParts[0] ?? '';
  const tailJoined = b.responseParts.slice(1).join('\n');
  const tailKept = sliceBytes(tailJoined, OPEN_BLOCK_RESPONSE_CAP, 'tail');
  b.responseParts = [headPart, tailKept];
  b.responseBytes = Buffer.byteLength(headPart, 'utf8') + Buffer.byteLength(tailKept, 'utf8');
}

function noteTime(b: BlockBuilder, ts: string | null): void {
  if (ts === null) return;
  b.timeStart = earliest(b.timeStart, ts);
  b.timeEnd = latest(b.timeEnd, ts);
}

export interface SegmentOptions {
  /** Override the session id stamped on the narrative (else recovered from the records). */
  sessionId?: string;
}

/**
 * Segment scanned transcript records into a {@link SessionNarrative} in a SINGLE O(n) pass.
 * A block = `[one real user prompt] → [all following records until the NEXT real user prompt]`
 * (knowledge.md decision 3). Records before the first real prompt open a `session-start` block.
 * All emitted text (prompt + response previews + topic label) is head+tail-bounded and
 * redact()-routed; image bytes never appear (projectText drops them with a counted warning).
 * NEVER throws.
 */
export function segmentTranscript(
  scanned: ScannedTranscript,
  sessionId: string,
  opts: SegmentOptions = {},
): SessionNarrative {
  const warnings: AdapterWarning[] = [...scanned.warnings];
  const blocks: NarrativeBlock[] = [];
  let droppedImages = 0;
  let droppedOther = 0;
  let projectPath: string | null = null;
  let timeStart: string | null = null;
  let timeEnd: string | null = null;

  let builder: BlockBuilder | null = null;

  const records = scanned.records;
  for (let i = 0; i < records.length; i += 1) {
    const r = records[i]!;
    if (r.cwd !== null && projectPath === null) {
      projectPath = recoverProjectPath(r.cwd) ?? r.cwd;
    }
    if (r.timestamp !== null) {
      timeStart = earliest(timeStart, r.timestamp);
      timeEnd = latest(timeEnd, r.timestamp);
    }

    if (isRealUserPrompt(r)) {
      // Close the open block (its end is the line BEFORE this prompt). A real prompt ALWAYS
      // opens a 'prompt' block — including the first one. The only 'session-start' block is the
      // implicit one that absorbs records preceding the first real prompt (see below).
      if (builder !== null) pushBlock(blocks, finishBlock(builder, i - 1));
      builder = newBuilder(i, 'prompt');
      const ptext = firstText(r.content) ?? '';
      builder.promptText = ptext;
      builder.turnCount += 1;
      noteTime(builder, r.timestamp);
      continue;
    }

    // Drop harness-injected synthetic user records (task-notification / caveat / command /
    // interrupt / compaction summary): they never anchor a block AND must not pollute its
    // response preview or turn count. Skipping them before the session-start builder is created
    // means a transcript that opens with the synthetic startup preamble has NO noise
    // session-start block — block 1 is the first real prompt.
    if (isSyntheticUserRecord(r)) continue;

    // Pre-first-prompt records open an implicit session-start block so nothing is lost.
    if (builder === null) {
      builder = newBuilder(i, 'session-start');
    }

    // Accumulate this record's contribution into the open block.
    if (r.type === 'assistant' || r.type === 'user') {
      builder.turnCount += 1;
      const projected = projectText(r.content);
      droppedImages += projected.droppedImages;
      droppedOther += projected.droppedOther;
      if (projected.text.length > 0) appendResponse(builder, projected.text);
      countTools(r, builder.toolCounts);
      collectAsks(r, builder.asks);
      for (const s of extractWorkflowSpawns(r)) builder.workflowSpawns.push(s);
      collectFilesTouched(r, builder.files);
    }
    noteTime(builder, r.timestamp);
  }

  if (builder !== null) {
    pushBlock(blocks, finishBlock(builder, records.length - 1));
  }

  if (droppedImages > 0) warnings.push({ code: 'transcript-image-dropped', detail: String(droppedImages) });
  if (droppedOther > 0) warnings.push({ code: 'transcript-nontext-block-dropped', detail: String(droppedOther) });

  return {
    sessionId: opts.sessionId ?? sessionId,
    projectPath,
    timeRange: { start: timeStart, end: timeEnd },
    totalRecords: scanned.totalLines,
    blocks,
    format: NARRATIVE_FORMAT,
    incomplete: scanned.incomplete,
    warnings,
  };
}

/**
 * Convenience: scan + segment transcript TEXT in one pure call. The caller reads the
 * `<sessionId>.jsonl` through the FileSystemPort and passes the text + session id here.
 * NEVER throws.
 */
export function buildSessionNarrative(
  text: string,
  sessionId: string,
  opts: SegmentOptions = {},
): SessionNarrative {
  return segmentTranscript(scanTranscript(text), sessionId, opts);
}

import type { FileSystemPort } from './index.ts';

/**
 * Read a session's `<sessionId>.jsonl` transcript THROUGH the injected FileSystemPort and
 * build its {@link SessionNarrative}. `transcriptPath` is the absolute path to the sibling
 * transcript file (`<claudeHome>/projects/<slug>/<sessionId>.jsonl`); the caller (server M1)
 * path-escape-guards it first. Disk-only via the port (no node:fs). A read failure
 * propagates (the route maps it to 404). The pure builders above are exercised by fixtures.
 */
export async function loadSessionNarrative(
  port: FileSystemPort,
  transcriptPath: string,
  sessionId: string,
  opts: SegmentOptions = {},
): Promise<SessionNarrative> {
  const text = await port.readFile(transcriptPath);
  return buildSessionNarrative(text, sessionId, opts);
}

// --- session discovery (the project session-timeline source) ----------------

/** A transcript filename suffix; the basename minus this is the sessionId. */
const TRANSCRIPT_EXT = '.jsonl';

/**
 * Derive a {@link SessionSummary} from already-scanned records for ONE session, WITHOUT
 * re-segmenting (knowledge.md refinement 3 — the timeline must render without a full
 * per-block pass). Computes the first→last record timestamp span, the raw record count,
 * a cheap Workflow-spawn tally (one extractWorkflowSpawns pass — no segmentation), and a
 * commitCount of 0 (M2 correlates real commits). `projectPath` is recovered from the first
 * record carrying a cwd (authoritative); else null. PURE; never throws.
 */
export function summarizeScannedSession(
  scanned: ScannedTranscript,
  sessionId: string,
): SessionSummary {
  let timeStart: string | null = null;
  let timeEnd: string | null = null;
  let projectPath: string | null = null;
  let workflowSpawnCount = 0;

  for (const r of scanned.records) {
    if (r.timestamp !== null) {
      timeStart = earliest(timeStart, r.timestamp);
      timeEnd = latest(timeEnd, r.timestamp);
    }
    if (projectPath === null && r.cwd !== null) {
      projectPath = recoverProjectPath(r.cwd) ?? r.cwd;
    }
    // Cheap spawn tally: extractWorkflowSpawns is a no-op for non-assistant / non-Workflow
    // records, so this stays an O(records) scan, NOT a segmentation pass.
    workflowSpawnCount += extractWorkflowSpawns(r).length;
  }

  return {
    sessionId,
    projectPath,
    timeRange: { start: timeStart, end: timeEnd },
    recordCount: scanned.totalLines,
    workflowSpawnCount,
    // M0/M1 emit 0; M2 correlates the repo's real git log by timestamp (+ message).
    commitCount: 0,
  };
}

/**
 * Discover the SESSIONS of one project — the source rows for the Story view's project
 * session-timeline (knowledge.md refinement 3). Lists `<claudeHome>/projects/<slug>/*.jsonl`
 * SIBLING transcript files (a `.jsonl` directly under the slug dir, NOT the `<sessionId>/`
 * subdir), and for EACH cheaply derives a {@link SessionSummary} (start→end span + counts).
 *
 * COST NOTE: the FileSystemPort has only `readFile()` (no range/tail read — knowledge.md
 * decision 5), so deriving the timestamp span + counts costs ONE whole readFile + scan per
 * file. That is acceptable for M1 (the timeline is fetched on demand, not per-frame) but is
 * the obvious place to add a sidecar index / range-read later if a project has many large
 * sessions. We do NOT segment here (no per-block pass) — only a single defensive scan.
 *
 * `slug` is the on-disk dir name (path-building only — the server path-escape-guards the dir
 * before calling). `projectPath` (optional) is the caller's authoritative recovered cwd; when
 * a session's records carry no cwd it backfills the summary's projectPath. A per-file read
 * error skips THAT file (never fatal); the result is sorted NEWEST-FIRST by `timeRange.end`
 * (nulls last). All disk via the injected port (no node:fs). Never throws on parse.
 */
export async function discoverSessions(
  port: FileSystemPort,
  claudeHome: string,
  slug: string,
  projectPath?: string,
): Promise<SessionSummary[]> {
  const dir = joinPath(claudeHome, 'projects', slug);
  let entries: Array<{ name: string; isDir: boolean }>;
  try {
    entries = await port.listDir(dir);
  } catch {
    return []; // absent / unreadable slug dir → no sessions (never fatal)
  }

  const summaries: SessionSummary[] = [];
  for (const e of entries) {
    // SIBLING `.jsonl` files only — skip dirs (incl. the `<sessionId>/` run subdir).
    if (e.isDir) continue;
    if (!e.name.endsWith(TRANSCRIPT_EXT)) continue;
    const sessionId = e.name.slice(0, -TRANSCRIPT_EXT.length);
    if (sessionId.length === 0) continue;

    let text: string;
    try {
      text = await port.readFile(joinPath(dir, e.name));
    } catch {
      continue; // a vanished/locked file is skipped, never fatal
    }
    const summary = summarizeScannedSession(scanTranscript(text), sessionId);
    // Backfill the caller's authoritative projectPath when the session itself carries none.
    if (summary.projectPath === null && projectPath !== undefined) {
      summary.projectPath = projectPath;
    }
    summaries.push(summary);
  }

  // Newest-first by end of span (nulls last) — the timeline reads most-recent-on-top.
  summaries.sort((a, b) => compareEndDesc(a.timeRange.end, b.timeRange.end));
  return summaries;
}

/** Sort comparator: newest `timeRange.end` first; a null end sorts last. */
function compareEndDesc(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? 1 : -1;
}

/**
 * Join path segments with `/` WITHOUT importing node:path (the adapter stays pure; the tree
 * is POSIX-ish under `~/.claude/projects` and we never resolve `..`). Mirrors discovery.ts's
 * local join. The SERVER resolve()-escape-guards the real path before any port read.
 */
function joinPath(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, '') : p.replace(/^\/+|\/+$/g, '')))
    .filter((p) => p.length > 0)
    .join('/');
}

// --- lazy per-block turns (the click-in view) -------------------------------

/**
 * The byte budget for a single {@link Turn}'s `textPreview`. Click-in turns are read one at
 * a time and shown in a text view, so they get a generous-but-bounded head+tail (reusing the
 * same boundedPreview machinery as the block previews) — never a whole multi-MB body.
 */
export const TURN_TEXT_HEADTAIL = 4 * 1024;

/** A short, redacted digest of one tool_use's args (never the raw args object). */
const TURN_ARGS_DIGEST_LEN = 100;

/**
 * Project an assistant record's `tool_use` blocks into {@link TurnToolCall}s — `name` plus a
 * SHORT, redact()-routed `briefArgs` digest (never the raw input object; keeps the wire small
 * + secret-free, mirroring WorkflowSpawn.argsDigest). A user record carries no tool_use blocks.
 * Defensive: a block with no usable name is skipped. NEVER throws.
 */
function projectToolCalls(r: RawRecord): TurnToolCall[] {
  if (!Array.isArray(r.content)) return [];
  const out: TurnToolCall[] = [];
  for (const b of r.content) {
    if (asString(b.type) !== 'tool_use') continue;
    const name = asString(b.name);
    if (name === null || name.length === 0) continue;
    const call: TurnToolCall = { name, briefArgs: briefArgs(b.input) };
    // AskUserQuestion is a session DECISION POINT — surface its question(s) + options inline in
    // the Story (not a bare tool row). The full structured ask is extracted (bounded + redacted).
    if (name === 'AskUserQuestion') {
      const ask = extractAskQuestions(b.input);
      if (ask) call.ask = ask;
    }
    out.push(call);
  }
  return out;
}

/** Truncate to `n` chars then route through {@link redact} (mirrors the preview/digest seam). */
function capRedact(s: string, n: number): string {
  return redact(s.length > n ? s.slice(0, n) : s);
}

/**
 * Extract the question(s) + options from an `AskUserQuestion` tool_use input for the Story
 * decision-point view. Defensive (unknown shape → undefined), bounded (≤6 questions, ≤8 options,
 * capped text), and every emitted string is redact()-routed. NEVER throws.
 */
function extractAskQuestions(input: unknown): AskQuestion[] | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const qs = (input as Record<string, unknown>).questions;
  if (!Array.isArray(qs)) return undefined;
  const out: AskQuestion[] = [];
  for (const q of qs.slice(0, 6)) {
    if (!q || typeof q !== 'object') continue;
    const qo = q as Record<string, unknown>;
    const question = asString(qo.question);
    if (question === null || question.length === 0) continue;
    const rawOpts = Array.isArray(qo.options) ? qo.options : [];
    const options: AskOption[] = [];
    for (const o of rawOpts.slice(0, 8)) {
      if (!o || typeof o !== 'object') continue;
      const oo = o as Record<string, unknown>;
      const label = asString(oo.label);
      if (label === null || label.length === 0) continue;
      options.push({ label: capRedact(label, 120), description: capRedact(asString(oo.description) ?? '', 280) });
    }
    const header = asString(qo.header);
    out.push({
      question: capRedact(question, 280),
      header: header && header.length > 0 ? capRedact(header, 40) : null,
      multiSelect: qo.multiSelect === true,
      options,
    });
  }
  return out.length > 0 ? out : undefined;
}

/** A short, redacted args digest for a Turn tool call (never the raw object). */
function briefArgs(input: unknown): string {
  if (input === undefined || input === null) return '';
  const s = typeof input === 'string' ? input : safeStringify(input);
  const bounded = s.length > TURN_ARGS_DIGEST_LEN ? s.slice(0, TURN_ARGS_DIGEST_LEN) : s;
  return redact(bounded);
}

/**
 * Load the full {@link Turn}s of ONE block — the lazy click-in view (knowledge.md data model;
 * the M1 `/turns?block=` endpoint). The caller reads the `<sessionId>.jsonl` THROUGH the port
 * and passes the block's `recordRange`; we scan, slice the records in `[start..end]` (inclusive,
 * clamped to the record array), and project each user/assistant record to a Turn:
 *   - `textPreview`: the record's projected text (image/tool_reference blocks dropped), bounded
 *     to head+tail and redact()-routed (so a click-in NEVER emits a whole body or an image byte);
 *   - `toolCalls`: the record's tool_use blocks as {name, briefArgs} (redacted digest).
 * Non-user/assistant records (system / attachment / mode / …) are NOT turns and are skipped.
 * `promptId` falls back to '' when the record omits one. Disk-only via the port (no node:fs);
 * a read failure propagates (the route maps it to 404). NEVER throws on parse.
 */
export async function loadBlockTurns(
  port: FileSystemPort,
  transcriptPath: string,
  recordRange: { start: number; end: number },
): Promise<Turn[]> {
  const text = await port.readFile(transcriptPath);
  return blockTurns(scanTranscript(text), recordRange);
}

/**
 * Pure core of {@link loadBlockTurns}: slice scanned records to `[start..end]` (inclusive,
 * clamped) and project each user/assistant record to a {@link Turn}. Exposed for fixture
 * tests (a slice over scanned records without a port round-trip). NEVER throws.
 */
export function blockTurns(
  scanned: ScannedTranscript,
  recordRange: { start: number; end: number },
): Turn[] {
  const records = scanned.records;
  // Clamp the requested range to the available records (a stale/oversized range is honest,
  // not fatal): start ≥ 0, end ≤ last index; an inverted/empty range yields [].
  const start = Math.max(0, recordRange.start);
  const end = Math.min(records.length - 1, recordRange.end);
  const turns: Turn[] = [];
  for (let i = start; i <= end; i += 1) {
    const r = records[i]!;
    if (r.type !== 'user' && r.type !== 'assistant') continue; // only user/assistant are turns
    // Classify the turn so the Story doesn't read agent self-talk as a human. A 'user'-role
    // record is: a tool_result fed back to the agent ('result' — the harness/agent loop, e.g. a
    // Bash output), a PROGRAM-driven prompt ('conductor' — promptSource 'sdk', a headless/subagent
    // driver), or an actual human ('user'). Assistant records are always 'assistant'.
    const role: TurnRole =
      r.type === 'assistant'
        ? 'assistant'
        : hasToolResult(r.content)
          ? 'result'
          : r.promptSource === 'sdk'
            ? 'conductor'
            : 'user';
    const projected = projectText(r.content);
    turns.push({
      promptId: r.promptId ?? '',
      timestamp: r.timestamp,
      role,
      textPreview: boundedPreview(projected.text, TURN_TEXT_HEADTAIL),
      toolCalls: projectToolCalls(r),
    });
  }
  return turns;
}
