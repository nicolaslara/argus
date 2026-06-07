// @argus/adapter — classify the ACCURATE cause of a failed agent from its transcript tail.
//
// WHY: a workflow run that fails because a subagent "completed without calling StructuredOutput"
// records ONLY that misleading line (+ a `/$bunfs/…cli.js` stack) in the run model's error. But a
// 2026-06-07 corpus scan (162 runs) found that ~96% of those failures are INFRA — a dropped socket
// mid-turn, a usage/session limit, or an overloaded API — not the model ignoring the tool. The real
// signature lives in the failing agent's transcript (`agent-<id>.jsonl`) LAST record. This pure
// classifier turns that tail into a structured {@link AgentFailureCause} so the UI can show "Connection
// dropped (infra)" instead of blaming the model. Pure + dependency-light (signature match on text).

import type { AgentFailureCause } from '@argus/contract';

/**
 * Classify a failing agent's transcript TAIL text into its real cause, or null when no known
 * failure signature is present (caller then falls back to the run model's error message).
 * Order matters: the most specific infra signatures are matched before the generic ones, and the
 * genuine model fault (schema rejection) last.
 */
export function classifyFailureText(text: string): AgentFailureCause | null {
  if (typeof text !== 'string' || text.length === 0) return null;

  // INFRA — the dominant cause: the agent's API socket closed mid-turn (its work usually still
  // landed on disk; the run is marked failed only because the finalizing call never happened).
  if (/socket connection was closed/i.test(text)) {
    return {
      mode: 'infra',
      kind: 'socket',
      label: 'Connection dropped',
      detail: 'the agent’s API socket closed mid-turn — its work usually still landed on disk',
    };
  }

  // INFRA — usage/session limit hit (NOT retryable until the reset time).
  if (/session limit/i.test(text)) {
    const m = /session limit[^\n]*?resets\s+([0-9:]+\s*(?:[ap]m)?[^\n)]*\)?)/i.exec(text);
    const when = m?.[1]?.trim() ?? null;
    return {
      mode: 'infra',
      kind: 'session-limit',
      label: 'Usage limit reached',
      detail: when ? `resets ${when}` : null,
    };
  }

  // INFRA — the model API was overloaded (429/529).
  if (/\b(429|529)\b/.test(text) || /\boverloaded\b/i.test(text)) {
    return {
      mode: 'infra',
      kind: 'overloaded',
      label: 'API overloaded',
      detail: 'the model API returned an overloaded error — transient',
    };
  }

  // MODEL — the genuine fault: a StructuredOutput payload the schema rejected (e.g. extra keys
  // under `additionalProperties:false`, or an oversized payload), looping until the retry budget ran.
  if (/Output does not match required schema/i.test(text)) {
    const m = /required schema:\s*([^\n]+)/i.exec(text);
    const detail = m?.[1]?.trim().slice(0, 140) ?? null;
    return {
      mode: 'model',
      kind: 'schema-validation',
      label: 'Structured-output validation failed',
      detail,
    };
  }

  return null;
}

/** The last `n` non-empty lines of a transcript — the terminal error lives at the very end, so we
 *  classify only the tail to avoid false positives from earlier agent output that merely mentions a
 *  socket/limit in passing. */
export function transcriptTail(text: string, n = 5): string {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  return lines.slice(-n).join('\n');
}
