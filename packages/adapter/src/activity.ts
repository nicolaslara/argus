// @argus/adapter — the TRANSCRIPT path. The ONLY module that knows the per-agent
// `agent-<id>.jsonl` session-transcript shape (failure-and-live-inspector design §1/§5).
// Empirically grounded (verified 2026-06-05 against real transcripts):
//
//   - JSONL of events; each event has type 'user' | 'assistant' | 'attachment' and a
//     top-level ISO `timestamp`.
//   - the FIRST `user` event's `message.content` (a string, or content blocks) = the
//     agent PROMPT → the label (its first non-empty line).
//   - each `assistant` event carries `message.usage` {input_tokens, output_tokens,
//     cache_read_input_tokens} (TOKENS) and `message.content[]` blocks; a
//     {type:'tool_use', name} block is a TOOL call; a {type:'text', text} block is an
//     assistant text turn.
//   - the LAST assistant text block = the current/final activity (for a failed agent it
//     is often `API Error: The socket connection was closed unexpectedly`).
//
// PURE — no node:fs. Disk is read by the caller through the FileSystemPort; the pure
// builder takes the transcript TEXT (so a transcript replay is a first-class test).
// Defensive throughout: tolerates large/partial/live/torn files — a malformed line is
// skipped, never thrown on. The timeline is capped so a 1.2MB transcript can't blow up
// the payload.

import { z } from 'zod';
import type {
  AgentActivity,
  AgentToolUse,
  AgentTimelineEntry,
} from '@argus/contract';
import type { FileSystemPort } from './index.ts';

/** Hard cap on emitted timeline entries; a huge transcript is truncated, never unbounded. */
export const ACTIVITY_TIMELINE_CAP = 500;
/** Hard cap on the emitted label / lastText lengths (text-node safe, never the whole turn). */
const TEXT_CAP = 4 * 1024;

// --- tolerant transcript-event schema (the only format-aware piece) ----------
//
// `.passthrough()` keeps unknown/extra fields internal-only; the public AgentActivity is
// built by explicit projection below, never by spreading a parsed event. Every field is
// individually tolerant (`.catch(undefined)`), so a wrong-typed field never throws.

const optString = z.string().catch(undefined as unknown as string).optional();
const optNumber = z.number().catch(undefined as unknown as number).optional();

/** One `message.content[]` block: a tool_use (has a name) or a text turn (has text). */
const ContentBlockSchema = z
  .object({
    type: optString,
    name: optString, // tool_use name
    text: optString, // text-turn body
  })
  .passthrough();

const UsageSchema = z
  .object({
    input_tokens: optNumber,
    output_tokens: optNumber,
    cache_read_input_tokens: optNumber,
  })
  .passthrough();

/** A message body: content may be a plain string (user prompt) OR an array of blocks. */
const MessageSchema = z
  .object({
    role: optString,
    // content is EITHER a string (user prompt) or an array of blocks (assistant turn).
    content: z.union([z.string(), z.array(ContentBlockSchema)]).catch(undefined as never).optional(),
    usage: UsageSchema.optional(),
  })
  .passthrough();

/** A single transcript event line. */
const EventSchema = z
  .object({
    type: optString, // 'user' | 'assistant' | 'attachment' | …
    timestamp: optString, // ISO
    message: MessageSchema.optional(),
  })
  .passthrough();

// --- helpers ----------------------------------------------------------------

/** First non-empty trimmed line of a prompt string, capped. */
function firstLine(s: string): string | undefined {
  for (const raw of s.split('\n')) {
    const line = raw.trim();
    if (line.length > 0) return line.length > TEXT_CAP ? line.slice(0, TEXT_CAP) : line;
  }
  return undefined;
}

/** Pull the prompt text out of a user message's `content` (string, or first text block). */
function promptText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as { type?: unknown; text?: unknown };
        if (b.type === 'text' && typeof b.text === 'string') return b.text;
      }
    }
  }
  return undefined;
}

/** Detect a terminal/API-error line in an assistant text turn (root-cause signal). */
function detectErrorLine(text: string): string | undefined {
  // The observed failure tail is `API Error: The socket connection was closed unexpectedly`.
  // Match a leading API/error marker without false-positiving on prose mentioning "error".
  const trimmed = text.trim();
  if (/^(?:API Error|Error:|Fatal error)/i.test(trimmed)) {
    const line = firstLine(trimmed);
    return line;
  }
  return undefined;
}

// --- the pure builder -------------------------------------------------------

/**
 * Parse an `agent-<id>.jsonl` transcript STRING into an {@link AgentActivity}. PURE; LINE-
 * INDEPENDENT — a single malformed/torn line is skipped (a live transcript may have a torn
 * final line), never aborting the parse. NEVER throws.
 *
 * EXPLICIT field projection only (never spreads a parsed event). The timeline is capped at
 * {@link ACTIVITY_TIMELINE_CAP}; label/lastText are length-capped. Tokens are summed across
 * assistant `message.usage`; tools are counted by `tool_use` name (stable first-seen order).
 */
export function agentActivityFromTranscript(transcriptText: string, agentId: string): AgentActivity {
  const toolCounts = new Map<string, number>(); // name -> count (insertion-ordered)
  const timeline: AgentTimelineEntry[] = [];
  let timelineFull = false;

  let label: string | undefined;
  let labelLocked = false; // label comes from the FIRST user event only

  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let sawUsage = false;

  let startedAt: string | undefined;
  let lastAt: string | undefined;

  let lastText: string | undefined;
  let error: string | undefined;
  let toolCalls = 0;

  for (const rawLine of transcriptText.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // torn / malformed line — skip, never throw
    }
    const res = EventSchema.safeParse(parsed);
    if (!res.success) continue;
    const ev = res.data;

    // Timing: first→last event timestamp (only well-formed ISO-ish strings).
    if (typeof ev.timestamp === 'string' && ev.timestamp.length > 0) {
      if (startedAt === undefined) startedAt = ev.timestamp;
      lastAt = ev.timestamp;
    }

    const msg = ev.message;
    const ts = typeof ev.timestamp === 'string' ? ev.timestamp : '';

    if (ev.type === 'user') {
      // The FIRST user event is the prompt → the label.
      if (!labelLocked && msg) {
        const text = promptText(msg.content);
        if (typeof text === 'string') {
          label = firstLine(text);
          labelLocked = true;
        }
      }
      continue;
    }

    if (ev.type === 'assistant' && msg) {
      // Tokens: Σ usage across assistant turns.
      if (msg.usage) {
        sawUsage = true;
        if (typeof msg.usage.input_tokens === 'number') input += msg.usage.input_tokens;
        if (typeof msg.usage.output_tokens === 'number') output += msg.usage.output_tokens;
        if (typeof msg.usage.cache_read_input_tokens === 'number') {
          cacheRead += msg.usage.cache_read_input_tokens;
        }
      }

      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use') {
            const name = typeof block.name === 'string' && block.name.length > 0 ? block.name : 'tool';
            toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
            toolCalls += 1;
            if (!timelineFull) {
              if (timeline.length >= ACTIVITY_TIMELINE_CAP) timelineFull = true;
              else timeline.push({ t: ts, kind: 'tool', name });
            }
          } else if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
            const text = block.text;
            // last assistant text wins → current/final activity.
            lastText = text.length > TEXT_CAP ? text.slice(0, TEXT_CAP) : text;
            const detected = detectErrorLine(text);
            if (detected) error = detected;
            if (!timelineFull) {
              if (timeline.length >= ACTIVITY_TIMELINE_CAP) timelineFull = true;
              else timeline.push({ t: ts, kind: 'text' });
            }
          }
        }
      }
    }
    // 'attachment' and unknown event types contribute only their timestamp (above).
  }

  const tools: AgentToolUse[] = [...toolCounts.entries()].map(([name, count]) => ({ name, count }));

  const out: AgentActivity = {
    agentId,
    tools,
    toolCalls,
    tokens: sawUsage ? { input, output, cacheRead } : null,
    timeline,
  };
  if (label !== undefined) out.label = label;
  if (startedAt !== undefined) out.startedAt = startedAt;
  if (lastAt !== undefined) out.lastAt = lastAt;
  if (startedAt !== undefined && lastAt !== undefined) {
    const d = Date.parse(lastAt) - Date.parse(startedAt);
    if (Number.isFinite(d) && d >= 0) out.durationMs = d;
  }
  if (lastText !== undefined) out.lastText = lastText;
  if (error !== undefined) out.error = error;
  return out;
}

// --- the port-reading helper ------------------------------------------------

/**
 * Read a run's per-agent `agent-<agentId>.jsonl` transcript THROUGH the injected
 * FileSystemPort and build its {@link AgentActivity} via {@link agentActivityFromTranscript}.
 * `runDir` is the absolute run dir (`…/subagents/workflows/<runId>`); the caller (server)
 * path-escape-guards it. Returns `null` when the transcript is ABSENT (cleaned/old run →
 * the inspector degrades to the journal + run.error). Disk-only via the port (no node:fs).
 */
export async function agentActivityFromDir(
  port: FileSystemPort,
  runDir: string,
  agentId: string,
): Promise<AgentActivity | null> {
  const sep = runDir.endsWith('/') || runDir.endsWith('\\') ? '' : '/';
  const path = `${runDir}${sep}agent-${agentId}.jsonl`;
  if (!(await port.exists(path))) return null;
  let text: string;
  try {
    text = await port.readFile(path);
  } catch {
    return null; // a transient read failure on a live file → degrade gracefully
  }
  return agentActivityFromTranscript(text, agentId);
}
