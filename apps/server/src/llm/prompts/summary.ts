// @argus/server — the NARRATIVE-SUMMARY prompt (M4 "Story" view). One file owns the prompt recipe
// + its version + the parse/clean of the reply, so iterating on the wording/format is a single-file
// change (mirrors caption.ts). The engine (cache I/O, the `claude -p` runner) lives in
// ../../narrative-summary.ts and consumes this.
//
// LOCKED ARCHITECTURE (workpads/narrative/tasks.md §M4): a block summary is a SEPARATE async layer
// that NEVER blocks segmentation. The model input is HEAD+TAIL ONLY — the block's already-bounded
// previews (topicLabel + promptPreview.text + responsePreview.text + a few top toolCounts). The full
// turns / raw transcript NEVER reach the model.

import { createHash } from 'node:crypto';
import type { NarrativeSummary } from '@argus/contract';

/** Bump to bust ALL narrative-summary caches when the prompt recipe changes. */
export const SUMMARY_PROMPT_VERSION = 'sum-v1';

/** Hard caps on each rendered field (chars / words) — the wire stays small + safe. */
export const MAX_CAPTION_WORDS = 12;
export const MAX_CAPTION_LEN = 100;
export const MAX_BODY_LEN = 320;
export const MAX_INTENT_LEN = 120;
export const MAX_PATTERN_WORDS = 4;
export const MAX_PATTERN_LEN = 40;

/** Bound the prompt/response text we feed the model (head+tail is already small upstream). */
const MAX_PROMPT_LEN = 4000;
const MAX_RESPONSE_LEN = 4000;
/** Top toolName→count entries to surface (the noisiest tools only — keeps the prompt small). */
const MAX_TOOLS = 6;

/**
 * The HEAD+TAIL-ONLY input projection for ONE block's summary. These are exactly the block's
 * already-bounded previews (the wire never carries a full body), NEVER the full turns / raw
 * transcript. `toolCounts` is the block's toolName→count map (we surface only the top few).
 */
export interface SummaryInput {
  /** The block's short topic label, when derivable (else null). */
  topicLabel: string | null;
  /** The real user prompt preview text (head+tail-bounded, redact()-routed upstream). */
  promptText: string;
  /** The assistant response preview text (head+tail-bounded, redact()-routed upstream). */
  responseText: string;
  /** The block's toolName → invocation count map (we project only the top few). */
  toolCounts: Record<string, number>;
}

/** Max chars of the topic label that reach the model (the prompt + key share this normalization). */
const MAX_TOPIC_LEN = 200;

/** Normalize the topic label exactly as the prompt renders it, so the cache key can't drift from it. */
function normTopic(topicLabel: string | null): string {
  return topicLabel && topicLabel.trim() !== '' ? topicLabel.trim().slice(0, MAX_TOPIC_LEN) : '';
}

/** The N largest toolName→count entries, descending (the noisiest tools lead). */
function topTools(toolCounts: Record<string, number>, limit: number): Array<[string, number]> {
  return Object.entries(toolCounts)
    .filter(([, n]) => typeof n === 'number' && n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

/**
 * The content-addressed key projection. We hash a STABLE projection of the input + the prompt
 * version (so two structurally-identical blocks across reloads collide — a reload is a cache
 * hit). The tools are normalized to a sorted top-N list so the key is order-independent.
 */
export function summaryKeyProjection(input: SummaryInput): string {
  const stable = {
    topicLabel: normTopic(input.topicLabel),
    promptText: input.promptText.slice(0, MAX_PROMPT_LEN),
    responseText: input.responseText.slice(0, MAX_RESPONSE_LEN),
    tools: topTools(input.toolCounts, MAX_TOOLS),
  };
  return JSON.stringify(stable);
}

/** Cache key: sha256 of the stable input projection + {@link SUMMARY_PROMPT_VERSION}. */
export function hashSummaryInput(input: SummaryInput): string {
  return createHash('sha256')
    .update(summaryKeyProjection(input) + ' ' + SUMMARY_PROMPT_VERSION)
    .digest('hex');
}

/**
 * Build the grounded summary prompt for ONE block (HEAD+TAIL ONLY). Asks for EXACTLY four labeled
 * lines so the parse is robust + order-independent: a concise caption, a 1-2 sentence body, a short
 * intent, and a 2-4 word structural pattern.
 */
export function buildSummaryPrompt(input: SummaryInput): string {
  const tools = topTools(input.toolCounts, MAX_TOOLS);
  const lines = [
    'You are summarizing ONE topic block of a Claude Code session "story". A block is a single',
    'real user prompt plus all the assistant work that followed it. You are given only the BOUNDED',
    'previews (the prompt head, the response head+tail, and the top tool counts) — summarize what',
    'this block ACCOMPLISHED for the reader skimming the session.',
    '',
    'Reply with EXACTLY four lines, each prefixed with its label and nothing else (no preamble, no',
    'markdown, no quotes, no blank lines):',
    `caption: a concise one-line headline, max ${MAX_CAPTION_WORDS} words, present-tense, no trailing period.`,
    'body: 1-2 plain sentences describing what was done and the outcome.',
    'intent: a short phrase naming what the user was trying to achieve.',
    `pattern: 2-4 lowercase words naming the work’s shape (e.g. feature implementation, bug fix,`,
    'code review, refactor, research, debugging, planning). Use "pattern: none" if none applies.',
    '',
  ];
  const topic = normTopic(input.topicLabel);
  if (topic) {
    lines.push(`topic: ${topic}`);
  }
  lines.push('', 'prompt:', input.promptText.slice(0, MAX_PROMPT_LEN));
  lines.push('', 'response:', input.responseText.slice(0, MAX_RESPONSE_LEN));
  if (tools.length > 0) {
    lines.push('', 'tools used: ' + tools.map(([name, n]) => `${name}×${n}`).join(', '));
  }
  return lines.join('\n');
}

/** Pull the value of a `label: <value>` line from a reply (line-order-independent). NEVER throws. */
function fieldLine(raw: string, label: string): string | null {
  const re = new RegExp(`^\\s*${label}:\\s*(.+)$`, 'i');
  for (const line of raw.split(/\r?\n/)) {
    const m = re.exec(line);
    if (m) return m[1]!.trim();
  }
  return null;
}

/** Strip wrapping quotes/backticks + a trailing period; cap at `maxLen` chars (ellipsis on cut). */
function clean(value: string, maxLen: number): string {
  const stripped = value.replace(/^["'`]+|["'`]+$/g, '').replace(/\.+$/, '').trim();
  if (stripped.length <= maxLen) return stripped;
  return stripped.slice(0, maxLen - 1) + '…';
}

/**
 * Cap a value to at most `maxWords` words AND `maxLen` chars, on a WORD BOUNDARY — drop whole
 * trailing words until it fits rather than slicing mid-word (a tag like "pattern" must never read
 * as "documentation, screenshot c…"). A single token longer than `maxLen` is hard-sliced as the
 * degenerate fallback.
 */
function capWords(value: string, maxWords: number, maxLen: number): string {
  const words = value.split(/\s+/).filter(Boolean).slice(0, maxWords);
  let out = '';
  for (const w of words) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > maxLen) break;
    out = next;
  }
  return out || (words[0] ? words[0].slice(0, maxLen) : '');
}

/**
 * Parse a raw model reply into a {@link NarrativeSummary}, or null when it carries no usable
 * caption. Every field is capped; `caption` is bounded to ~12 words; `pattern` is lowercased +
 * 2-4 words ("none"/empty → null). Line-order-independent. NEVER throws.
 */
export function parseSummary(raw: string | null): NarrativeSummary | null {
  if (raw === null) return null;
  const text = raw.trim();
  if (!text) return null;

  // caption is required — the headline carries the summary. A null caption → no usable summary.
  const captionRaw = fieldLine(text, 'caption');
  if (captionRaw === null) return null;
  const caption = capWords(clean(captionRaw, MAX_CAPTION_LEN), MAX_CAPTION_WORDS, MAX_CAPTION_LEN);
  if (!caption) return null;

  const bodyRaw = fieldLine(text, 'body');
  const body = bodyRaw ? clean(bodyRaw, MAX_BODY_LEN) : '';

  const intentRaw = fieldLine(text, 'intent');
  const intent = intentRaw ? clean(intentRaw, MAX_INTENT_LEN) : '';

  let pattern: string | null = null;
  const patternRaw = fieldLine(text, 'pattern');
  if (patternRaw) {
    // Strip quotes/period WITHOUT the char cap (a high bound), then let capWords enforce the real
    // limit on a word boundary — so a multi-word pattern never gets chopped mid-word with an ellipsis.
    const cleaned = clean(patternRaw, 200).toLowerCase();
    if (cleaned && cleaned !== 'none' && cleaned !== 'n/a') {
      pattern = capWords(cleaned, MAX_PATTERN_WORDS, MAX_PATTERN_LEN) || null;
    }
  }

  return {
    caption,
    body,
    intent,
    pattern,
    promptVersion: SUMMARY_PROMPT_VERSION,
  };
}
