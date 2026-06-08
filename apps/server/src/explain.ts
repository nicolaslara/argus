// @argus/server — the Explanation layer engine (PX). Per-node LLM captions enriched
// by shelling out to headless `claude -p`, content-addressed cached on disk, warmed in
// a bounded background pool, and served via a separate poll endpoint. ANNOTATION-ONLY:
// this module produces caption TEXT for nodes that already exist; it never adds,
// removes, or rewires topology (that stays owned by the AST/meta adapter). It degrades
// gracefully when `claude` is absent on PATH (or errors/times out): every node keeps
// its deterministic baseline caption and nothing crashes.
//
// Design: workpads/architecture/plan-view-design.md §10. Cache key recipe:
//   sha256(JSON.stringify(artifact) + PROMPT_VERSION)  ->  .argus/cache/explanations/<hash>.json
// v1 invalidation = bust + regenerate when the hash changes.
//
// Security/privacy (boundaries.md §4): nothing here is logged with file contents; the
// artifact text (prompts/code/state) is the user's OWN local content passed to their
// OWN local `claude` auth — never copied off-machine. The cache lives under gitignored
// .argus/. The poll endpoint stays behind the same token gate + path guards as the rest.

import { join } from 'node:path';
import type {
  ExplanationBatch,
  ExplanationSource,
  ExplanationStatus,
  NodeExplanation,
  PlanModel,
  RunModel,
} from '@argus/contract';
// The runner + the caption prompt now live in ./llm/ (the one place to iterate on models/prompts).
// This module is the caption ENGINE (artifact builders + cache I/O + background warming pool) that
// consumes them. Re-exported below so existing import sites (routes.ts, the engine tests) are unchanged.
import { type ClaudeRunner, defaultClaudeRunner } from './llm/runner.ts';
import { DiskCache } from './llm/cache.ts';
import {
  type NodeArtifact,
  PROMPT_VERSION,
  hashArtifact,
  buildPrompt,
  parsePattern,
  cleanCaption,
} from './llm/prompts/caption.ts';
export { defaultClaudeRunner, PROMPT_VERSION, hashArtifact, buildPrompt, parsePattern, cleanCaption };
export type { ClaudeRunner, NodeArtifact };

/** The on-disk shape of a cached explanation entry. */
export interface CachedExplanation {
  caption: string;
  pattern: string | null;
  promptVersion: string;
}

// --- cache file IO. Isolated here so tests can stub child_process WITHOUT touching fs ---
//     and so the engine never throws on a cache read/write failure.

export interface ExplainCacheIO {
  read(hash: string): Promise<CachedExplanation | null>;
  write(hash: string, entry: CachedExplanation): Promise<void>;
}

/**
 * The default disk-backed cache under `<cacheDir>/<hash>.json`. Wraps the shared {@link DiskCache}
 * (the hex-hash + containment path guard + never-throwing JSON read + swallow-on-failure write live
 * there, in llm/cache.ts) and layers the explanation-specific typed validation + prompt-version
 * check on read: a stale `promptVersion` is treated as a miss (bust + regenerate).
 */
export function diskCacheIO(cacheDir: string): ExplainCacheIO {
  const cache = new DiskCache<CachedExplanation>(cacheDir);
  return {
    async read(hash: string): Promise<CachedExplanation | null> {
      // DiskCache returns the parsed JSON cast to CachedExplanation, but the on-disk content is
      // untrusted — validate every field at runtime (a malformed entry / stale version → a miss).
      const c = (await cache.read(hash)) as Record<string, unknown> | null;
      if (!c || typeof c !== 'object') return null;
      if (typeof c.caption !== 'string') return null;
      // Stale prompt-version → treat as a miss (bust + regenerate).
      if (c.promptVersion !== PROMPT_VERSION) return null;
      return {
        caption: c.caption,
        pattern: typeof c.pattern === 'string' ? c.pattern : null,
        promptVersion: PROMPT_VERSION,
      };
    },
    async write(hash: string, entry: CachedExplanation): Promise<void> {
      await cache.write(hash, entry);
    },
  };
}

// --- the engine: cache + bounded background pool + poll-able batch state -----------------

interface EngineEntry {
  artifact: NodeArtifact;
  status: ExplanationStatus;
  source: ExplanationSource;
  caption: string;
  pattern: string | null;
}

interface EngineOptions {
  cacheDir: string;
  runner?: ClaudeRunner;
  cacheIO?: ExplainCacheIO;
  /** Bounded concurrency of the background pool. */
  concurrency?: number;
  /** Whether the `claude` engine is available (default: detected lazily as true). */
  engineAvailable?: boolean;
}

/**
 * The in-process Explanation engine. One instance per server. It owns:
 *   - a per-target (plan/run) map of node explanations (baseline → ready),
 *   - a content-addressed disk cache (hit = instant, no re-spawn),
 *   - a bounded background worker pool that warms missing captions eagerly.
 * The REST snapshot/plan responses do NOT await it; the poll endpoint reads the
 * current state. The whole engine degrades to baseline if the runner returns null.
 */
export class ExplanationEngine {
  private readonly runner: ClaudeRunner;
  private readonly cacheIO: ExplainCacheIO;
  private readonly concurrency: number;
  private engineAvailable: boolean;

  /** target -> (nodeId -> entry). */
  private readonly targets = new Map<string, Map<string, EngineEntry>>();
  /** Pending generation jobs (artifact + the target/id they belong to). */
  private readonly queue: Array<{ target: string; artifact: NodeArtifact }> = [];
  private active = 0;
  /** De-dup: a hash already generated/in-flight this session (memory cache hit). */
  private readonly seenHashes = new Map<string, CachedExplanation | 'inflight'>();

  constructor(opts: EngineOptions) {
    this.runner = opts.runner ?? defaultClaudeRunner();
    this.cacheIO = opts.cacheIO ?? diskCacheIO(opts.cacheDir);
    this.concurrency = Math.max(1, opts.concurrency ?? 3);
    this.engineAvailable = opts.engineAvailable ?? true;
  }

  /**
   * Warm a target's explanations from a set of node artifacts. Idempotent per target
   * (re-warming with the SAME artifacts is a no-op once entries exist). Seeds every
   * node with its baseline IMMEDIATELY (the poll returns those at once), then enqueues
   * the cache-check + generation in the background. Returns at once — NEVER blocks.
   */
  warm(target: string, artifacts: NodeArtifact[]): void {
    let entries = this.targets.get(target);
    if (!entries) {
      entries = new Map<string, EngineEntry>();
      this.targets.set(target, entries);
    }
    for (const artifact of artifacts) {
      const existing = entries.get(artifact.id);
      if (existing && hashArtifact(existing.artifact) === hashArtifact(artifact)) {
        continue; // already tracked with the same artifact → no re-enqueue (cache stable)
      }
      entries.set(artifact.id, {
        artifact,
        status: 'pending',
        source: 'baseline',
        caption: artifact.baseline,
        pattern: null,
      });
      this.queue.push({ target, artifact });
    }
    // Kick the pool (microtask; never blocks the caller / the REST response).
    queueMicrotask(() => void this.pump());
  }

  /** The current poll snapshot for a target (baseline immediately, llm when ready). */
  batch(target: string): ExplanationBatch {
    const entries = this.targets.get(target);
    const explanations: NodeExplanation[] = [];
    let pending = false;
    if (entries) {
      for (const e of entries.values()) {
        if (e.status === 'pending') pending = true;
        explanations.push({
          id: e.artifact.id,
          caption: e.caption,
          pattern: e.pattern,
          status: e.status,
          source: e.source,
        });
      }
    }
    return {
      target,
      pending: pending && this.engineAvailable,
      engineAvailable: this.engineAvailable,
      explanations,
    };
  }

  /** Drain the queue up to the concurrency bound. */
  private async pump(): Promise<void> {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.active += 1;
      void this.runJob(job.target, job.artifact).finally(() => {
        this.active -= 1;
        // Continue draining (a microtask keeps it non-recursive on the stack).
        queueMicrotask(() => void this.pump());
      });
    }
  }

  private setEntry(
    target: string,
    id: string,
    patch: Partial<Pick<EngineEntry, 'status' | 'source' | 'caption' | 'pattern'>>,
  ): void {
    const entries = this.targets.get(target);
    const e = entries?.get(id);
    if (!e) return;
    Object.assign(e, patch);
  }

  /** Generate (or cache-hit) one node's explanation. NEVER throws. */
  private async runJob(target: string, artifact: NodeArtifact): Promise<void> {
    const hash = hashArtifact(artifact);

    // 1) Memory cache (de-dup within this session: no re-spawn for an identical hash).
    const mem = this.seenHashes.get(hash);
    if (mem && mem !== 'inflight') {
      this.setEntry(target, artifact.id, {
        status: 'ready',
        source: 'llm',
        caption: mem.caption,
        pattern: mem.pattern,
      });
      return;
    }

    // 2) Disk cache hit → instant, NO spawn (the reload-is-a-cache-hit acceptance).
    const cached = await this.cacheIO.read(hash);
    if (cached) {
      this.seenHashes.set(hash, cached);
      this.setEntry(target, artifact.id, {
        status: 'ready',
        source: 'llm',
        caption: cached.caption,
        pattern: cached.pattern,
      });
      return;
    }

    // 3) Miss → generate via `claude -p`. If unavailable/errors, stay on baseline.
    this.seenHashes.set(hash, 'inflight');
    let raw: string | null = null;
    try {
      raw = await this.runner(buildPrompt(artifact));
    } catch {
      raw = null;
    }
    const caption = cleanCaption(raw);
    if (caption === null) {
      // Generation unavailable/failed → graceful baseline (status 'error', source baseline).
      this.engineAvailable = false; // a failed spawn signals claude is unusable
      this.seenHashes.delete(hash);
      this.setEntry(target, artifact.id, { status: 'error', source: 'baseline' });
      return;
    }
    this.engineAvailable = true;
    const pattern = parsePattern(raw);
    const entry: CachedExplanation = { caption, pattern, promptVersion: PROMPT_VERSION };
    this.seenHashes.set(hash, entry);
    await this.cacheIO.write(hash, entry); // content-addressed: reload is a hit
    this.setEntry(target, artifact.id, {
      status: 'ready',
      source: 'llm',
      caption,
      pattern,
    });
  }
}

// --- artifact extraction: PlanModel / RunModel -> NodeArtifact[] (annotation-only) -------
//
// We read ONLY fields argus already surfaces (no new format knowledge): a plan node's
// kind/title/label/subtitle, an agent's label/model/prompt-preview. The artifact is the
// content we already have in the model — never re-reading transcripts here.

/** A stable, content-addressable target id for a plan. */
export function planTargetId(slug: string, file: string): string {
  return `plan:${slug}:${file}`;
}

/** A stable, content-addressable target id for a run. */
export function runTargetId(slug: string, session: string, runId: string): string {
  return `run:${slug}:${session}:${runId}`;
}

/** The deterministic baseline caption for a plan node (meta detail / label). */
function planBaseline(subtitle: string | null, title: string): string {
  return subtitle && subtitle.trim() ? subtitle.trim() : title;
}

/** Plan nodes (agent/process/decision/loop/output) -> artifacts. Annotation-only. */
export function planArtifacts(plan: PlanModel): NodeArtifact[] {
  const out: NodeArtifact[] = [];
  for (const n of plan.nodes) {
    // Only caption the nodes that carry a subtitle slot in the UI (agents + processes).
    if (n.kind !== 'agent' && n.kind !== 'process') continue;
    const phase = n.phaseRef != null ? (plan.lanes[n.phaseRef - 1]?.title ?? null) : null;
    const role =
      n.multiplicity.kind === 'fixed'
        ? `×${n.multiplicity.n}`
        : n.multiplicity.kind === 'unbounded'
          ? `×${n.multiplicity.min}..N`
          : n.agentType
            ? `type ${n.agentType}`
            : null;
    const labelRaw = n.labelTemplate?.raw ?? n.title;
    const evidence = [
      `workflow: ${plan.workflowName}`,
      `node kind: ${n.kind}`,
      `label: ${labelRaw}`,
      n.agentType ? `agent type: ${n.agentType}` : '',
      `multiplicity: ${n.multiplicity.kind}`,
      n.annotation.typed ? 'has StructuredOutput schema' : '',
      n.annotation.subtitle ? `declared detail: ${n.annotation.subtitle}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    out.push({
      id: n.id,
      kind: n.kind,
      label: n.title,
      phase,
      role,
      evidence,
      baseline: planBaseline(n.annotation.subtitle, n.title),
    });
  }
  return out;
}

/** Execution agent nodes -> artifacts. Uses the already-emitted prompt preview as evidence. */
export function runArtifacts(run: RunModel): NodeArtifact[] {
  const phaseByIndex = new Map<number, string>();
  for (const p of run.phases) phaseByIndex.set(p.index, p.title);
  return run.agents.map((a) => {
    const phase = phaseByIndex.get(a.phaseIndex) ?? null;
    const promptText = a.promptPreview?.text ?? '';
    const resultText = a.resultPreview?.text ?? '';
    const evidence = [
      `workflow: ${run.workflowName}`,
      `agent: ${a.label}`,
      a.model ? `model: ${a.model}` : '',
      a.agentType ? `agent type: ${a.agentType}` : '',
      `state: ${a.state}`,
      promptText ? `prompt: ${promptText}` : '',
      resultText ? `result: ${resultText}` : '',
      a.lastToolSummary ? `last tool: ${a.lastToolSummary}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    // Baseline = the agent's prompt first line, else its label (design §10.2).
    const firstPromptLine = promptText.split(/\r?\n/)[0]?.trim() ?? '';
    const baseline = firstPromptLine || a.label || a.agentId || 'agent';
    return {
      id: a.agentId,
      kind: 'execution-agent',
      label: a.label || a.agentId || 'agent',
      phase,
      role: a.model ? `model ${a.model}` : null,
      evidence,
      baseline,
    };
  });
}

/** Where the explanation cache lives (gitignored). */
export function explanationsCacheDir(repoRoot: string): string {
  return join(repoRoot, '.argus', 'cache', 'explanations');
}
