// @argus/server — the NODE-CAPTION prompt (PX). One file owns the prompt recipe + its version +
// the parse/clean of the reply, so iterating on the wording/format is a single-file change. The
// engine (warming pool, cache I/O, batching) lives in ../../explain.ts and consumes this.

import { createHash } from 'node:crypto';

/** Bump to bust ALL caption caches when the prompt recipe changes. */
export const PROMPT_VERSION = 'px-v2';

/** Hard cap on a rendered caption (chars). */
export const MAX_CAPTION_LEN = 140;

/**
 * The content-addressed unit. We give the model BOTH (a) how argus CLASSIFIED the node and (b)
 * the underlying artifact it represents — grounding in both yields a faithful caption, not a guess.
 */
export interface NodeArtifact {
  /** Visualization node id (PlanNode.id or AgentNode.agentId). */
  id: string;
  /** How argus classified it: 'agent' | 'process' | 'decision' | 'execution-agent' … */
  kind: string;
  /** The node's display label/title. */
  label: string;
  /** The phase title it belongs to (if any). */
  phase: string | null;
  /** A short structural hint (e.g. "fan-out ×7", "loop · max 3", model name). */
  role: string | null;
  /** The grounding evidence: a code slice / agent prompt+schema / state window. */
  evidence: string;
  /** The instant deterministic baseline caption (shown until the LLM enriches it). */
  baseline: string;
}

/**
 * Cache key: sha256 of a STABLE projection of the artifact + {@link PROMPT_VERSION}. `id` is
 * excluded so two structurally identical nodes across reloads collide (a reload is a cache hit).
 */
export function hashArtifact(artifact: NodeArtifact): string {
  const stable = {
    kind: artifact.kind,
    label: artifact.label,
    phase: artifact.phase,
    role: artifact.role,
    evidence: artifact.evidence,
  };
  return createHash('sha256')
    .update(JSON.stringify(stable) + ' ' + PROMPT_VERSION)
    .digest('hex');
}

/** Build the grounded prompt for one node (identity scaffold + artifact evidence). */
export function buildPrompt(artifact: NodeArtifact): string {
  const lines = [
    'You are labeling one node of a Claude Code workflow visualization.',
    'Given the node identity AND the underlying artifact, explain the node’s ROLE in the',
    'workflow — what it CONTRIBUTES — not a restatement of its label. Reply with EXACTLY',
    'two lines and nothing else (no preamble, no markdown, no quotes):',
    'Line 1 — caption: a concise phrase, max 12 words, present-tense, no trailing period.',
    'Line 2 — exactly "pattern: <2-4 lowercase words>" naming its structural role,',
    'e.g. primary-source research, adversarial review, fan-out worker, synthesis merge,',
    'decision gate, verification pass. Use "pattern: none" if no clear pattern applies.',
    '',
    `node kind: ${artifact.kind}`,
    `label: ${artifact.label}`,
  ];
  if (artifact.phase) lines.push(`phase: ${artifact.phase}`);
  if (artifact.role) lines.push(`role: ${artifact.role}`);
  lines.push('', 'artifact:', artifact.evidence.slice(0, 8000));
  return lines.join('\n');
}

/**
 * Extract the optional `pattern: <…>` line from a reply. Lowercased, de-quoted, capped at
 * 4 words / 28 chars; "none"/empty → null. NEVER throws. Line-order-independent.
 */
export function parsePattern(raw: string | null): string | null {
  if (raw === null) return null;
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*pattern:\s*(.+)$/i.exec(line);
    if (!m) continue;
    const cleaned = m[1]!.trim().replace(/^["'`]+|["'`]+$/g, '').replace(/[.]+$/, '').trim().toLowerCase();
    if (!cleaned || cleaned === 'none' || cleaned === 'n/a') return null;
    const words = cleaned.split(/\s+/).slice(0, 4).join(' ');
    return words.length > 28 ? words.slice(0, 28) : words;
  }
  return null;
}

/** Normalize a raw model caption into a single clean line (length-capped). */
export function cleanCaption(raw: string | null): string | null {
  if (raw === null) return null;
  const line = (raw.trim().split(/\r?\n/)[0]?.trim() ?? '').replace(/^caption:\s*/i, '');
  if (!line) return null;
  const stripped = line.replace(/^["'`]+|["'`]+$/g, '').replace(/\.$/, '').trim();
  if (!stripped) return null;
  return stripped.length > MAX_CAPTION_LEN ? stripped.slice(0, MAX_CAPTION_LEN - 1) + '…' : stripped;
}
