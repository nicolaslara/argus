// @argus/server — the M3 route layer. Wires the M2 discovery (discoverProjects /
// discoverRuns) and the M1 loadRun behind the M0 security posture (boundaries.md §4).
//
// Routes (all under /api, all token-gated by index.ts BEFORE this layer is reached):
//   GET /api/projects                          -> ProjectRef[]
//   GET /api/projects/:slug/runs               -> RunSummary[]
//   GET /api/runs/:slug/:session/:runId        -> RunModel (snapshot)
//
// Security invariants enforced here (in addition to index.ts's bind/Host/Origin/token):
//   - strict charset validation on every path segment (slug/session/runId) BEFORE FS
//   - resolve()-verify the final wf_*.json path stays INSIDE claudeHome (path-escape guard)
//   - redaction: never log file contents or full paths (codes/basenames only)
//
// All disk access goes through the injected NodeFileSystemPort; this module never
// imports node:fs. It only uses node:path to build + resolve()-verify paths.

import { resolve, sep } from 'node:path';
import {
  redactInternalPaths,
  classifyFailureText,
  transcriptTail,
  agentActivityFromDir,
  agentResultFromJournal,
  discoverProjects,
  discoverRuns,
  discoverRunningRunsReport,
  discoverSessions,
  discoverWorkflowMetas,
  loadBlockTurns,
  loadLiveModel,
  loadPlan,
  loadRun,
  loadRunPlan,
  loadSessionNarrative,
  perRunScriptBasename,
  recoverProjectPath,
  type FileSystemPort,
  type AdapterContext,
} from '@argus/adapter';
import type {
  ExplanationBatch,
  NarrativeBlock,
  PlanModel,
  ProjectRef,
  RecordRange,
  RunModel,
  RunRef,
  RunSummary,
  SessionNarrative,
  SessionSummary,
  Turn,
  WorkflowMeta,
} from '@argus/contract';
import {
  ExplanationEngine,
  planArtifacts,
  planTargetId,
  runArtifacts,
  runTargetId,
} from './explain.ts';
import {
  narrativeCacheKey,
  type NarrativeCacheIO,
} from './narrative-cache.ts';

/**
 * Strict path-segment charset. Slug dirs are `-Users-...` (alnum + dash), session ids
 * are UUIDs (alnum + dash), runIds are `wf_<id>` (alnum + dash + underscore). We allow
 * the union and explicitly forbid anything that could traverse (`/`, `\`, `.`, `..`,
 * NUL, whitespace). A segment failing this is rejected with 400 BEFORE any FS access.
 */
const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

/** runId must be a `wf_*` file stem (defense-in-depth on top of the charset check). */
const RUN_ID_RE = /^wf_[A-Za-z0-9_-]+$/;

export function isValidSegment(seg: string): boolean {
  return seg.length > 0 && seg.length <= 256 && SEGMENT_RE.test(seg);
}

export function isValidRunId(runId: string): boolean {
  return isValidSegment(runId) && RUN_ID_RE.test(runId);
}

/**
 * Build the absolute wf_*.json path for a run and resolve()-verify it stays strictly
 * inside `claudeHome`. Returns the absolute path, or null if the resolved path escapes
 * the claude home (belt-and-suspenders on top of the charset check). NEVER throws.
 */
export function safeRunJsonPath(
  claudeHome: string,
  slug: string,
  session: string,
  runId: string,
): string | null {
  if (!isValidSegment(slug) || !isValidSegment(session) || !isValidRunId(runId)) {
    return null;
  }
  const homeAbs = resolve(claudeHome);
  const candidate = resolve(homeAbs, 'projects', slug, session, 'workflows', `${runId}.json`);
  // Must be strictly inside the claude home (prefix + path separator).
  if (candidate !== homeAbs && !candidate.startsWith(homeAbs + sep)) {
    return null;
  }
  return candidate;
}

/**
 * Build the absolute per-run persisted script path
 *   `<claudeHome>/projects/<slug>/<session>/workflows/scripts/<file>`
 * for a run (P2) and resolve()-verify it stays strictly inside `claudeHome`. The slug/
 * session/runId charset is checked first (M3 pattern); `file` is the persisted script
 * basename (a `.js` file — validated by isValidWorkflowFile). Returns null on any escape
 * or bad segment (belt-and-suspenders on top of the charset check). NEVER throws.
 */
export function safeRunScriptPath(
  claudeHome: string,
  slug: string,
  session: string,
  runId: string,
  file: string,
): string | null {
  if (!isValidSegment(slug) || !isValidSegment(session) || !isValidRunId(runId)) {
    return null;
  }
  if (!isValidWorkflowFile(file)) return null;
  const homeAbs = resolve(claudeHome);
  const candidate = resolve(homeAbs, 'projects', slug, session, 'workflows', 'scripts', file);
  if (candidate !== homeAbs && !candidate.startsWith(homeAbs + sep)) {
    return null;
  }
  return candidate;
}

/**
 * Build the absolute LIVE run DIRECTORY
 *   `<claudeHome>/projects/<slug>/<session>/subagents/workflows/<runId>`
 * and resolve()-verify it stays strictly inside `claudeHome` (path-escape guard on top of
 * the segment charset check). This is the dir that holds both `journal.jsonl` and the
 * per-agent `agent-<id>.jsonl` transcripts. Returns null on a bad segment or escape.
 * NEVER throws.
 */
export function safeRunDir(
  claudeHome: string,
  slug: string,
  session: string,
  runId: string,
): string | null {
  if (!isValidSegment(slug) || !isValidSegment(session) || !isValidRunId(runId)) return null;
  const homeAbs = resolve(claudeHome);
  const candidate = resolve(homeAbs, 'projects', slug, session, 'subagents', 'workflows', runId);
  if (candidate !== homeAbs && !candidate.startsWith(homeAbs + sep)) return null;
  return candidate;
}

/**
 * Build the absolute LIVE journal path
 *   `<claudeHome>/projects/<slug>/<session>/subagents/workflows/<runId>/journal.jsonl`
 * and resolve()-verify it stays strictly inside `claudeHome` (path-escape guard on top of
 * the segment charset check). Returns null on a bad segment or escape. NEVER throws.
 */
export function safeRunJournalPath(
  claudeHome: string,
  slug: string,
  session: string,
  runId: string,
): string | null {
  const dir = safeRunDir(claudeHome, slug, session, runId);
  return dir === null ? null : resolve(dir, 'journal.jsonl');
}

/**
 * Build the absolute per-run scripts DIRECTORY
 *   `<claudeHome>/projects/<slug>/<session>/workflows/scripts`
 * (resolve()-guarded). Used live to discover the persisted script basename when there is
 * NO finalized wf_<id>.json header yet (the run is still going). NEVER throws.
 */
export function safeRunScriptsDir(
  claudeHome: string,
  slug: string,
  session: string,
  runId: string,
): string | null {
  if (!isValidSegment(slug) || !isValidSegment(session) || !isValidRunId(runId)) return null;
  const homeAbs = resolve(claudeHome);
  const candidate = resolve(homeAbs, 'projects', slug, session, 'workflows', 'scripts');
  if (candidate !== homeAbs && !candidate.startsWith(homeAbs + sep)) return null;
  return candidate;
}

/**
 * A session id is a transcript filename STEM (`<sessionId>.jsonl`) — a UUID-shaped token
 * (alnum + dash). Validated with the SAME strict charset as a path segment (no `/`, `\`,
 * `.`, `..`, NUL, whitespace), so it can never traverse out of the slug dir nor smuggle a
 * `.jsonl`/path part into the basename. A dedicated alias of isValidSegment for clarity at
 * the narrative call sites (the sessionId is the load-bearing untrusted input here).
 */
export function isValidSessionId(sessionId: string): boolean {
  return isValidSegment(sessionId);
}

/**
 * Build the absolute SIBLING session transcript path
 *   `<claudeHome>/projects/<slug>/<sessionId>.jsonl`
 * and resolve()-verify it stays strictly inside `claudeHome`. This is the file that sits
 * NEXT TO (not inside) the `<sessionId>/` run subdir, so it needs a DEDICATED guard — the
 * existing safeRun*Path helpers all build a `<sessionId>/…` SUBDIR path and would never
 * resolve to this sibling `.jsonl`. The charset of BOTH slug and sessionId is checked first
 * (the `.jsonl` suffix is appended by us, never taken from input — so the basename cannot be
 * spoofed), then a prefix + path-separator check rejects any escape. NEVER throws.
 */
export function safeSessionTranscriptPath(
  claudeHome: string,
  slug: string,
  sessionId: string,
): string | null {
  if (!isValidSegment(slug) || !isValidSessionId(sessionId)) return null;
  const homeAbs = resolve(claudeHome);
  const candidate = resolve(homeAbs, 'projects', slug, `${sessionId}.jsonl`);
  if (candidate !== homeAbs && !candidate.startsWith(homeAbs + sep)) return null;
  return candidate;
}

/**
 * A workflow source filename: a `.js` basename of safe charset (alnum + dash +
 * underscore + dot), with NO path separators and NO `..`. Enforced BEFORE any FS read.
 */
const WORKFLOW_FILE_RE = /^[A-Za-z0-9_-]+\.js$/;

export function isValidWorkflowFile(file: string): boolean {
  return (
    file.length > 0 &&
    file.length <= 256 &&
    WORKFLOW_FILE_RE.test(file) &&
    !file.includes('..')
  );
}

/**
 * Build the absolute `<projectPath>/.claude/workflows/<file>` path and resolve()-verify
 * it stays strictly inside `projectPath/.claude/workflows`. Returns null on any escape
 * (belt-and-suspenders on top of the charset check). NEVER throws.
 */
export function safeWorkflowJsPath(projectPath: string, file: string): string | null {
  if (!isValidWorkflowFile(file)) return null;
  const wfDir = resolve(projectPath, '.claude', 'workflows');
  const candidate = resolve(wfDir, file);
  if (candidate !== wfDir && !candidate.startsWith(wfDir + sep)) return null;
  return candidate;
}

export interface RouteResult {
  status: number;
  body: unknown;
}

/** A coded error body (no raw paths / file contents — boundaries.md §4 redaction). */
function err(status: number, error: string): RouteResult {
  return { status, body: { error } };
}

export interface RouteDeps {
  port: FileSystemPort;
  claudeHome: string;
  /** #9: the generative sub-UI engine (claude → constrained PanelSpec). Optional. */
  subui?: import('./subui.ts').SubUiEngine;
  /**
   * The Explanation engine (PX). Optional so the M3/P0/P1 routes and their tests need no
   * engine; when present, the plan/run handlers warm it in the BACKGROUND (never awaited)
   * and the explanations route reads its current batch.
   */
  explain?: ExplanationEngine;
  /**
   * The Session Narrative ("Story" view) disk cache (M1). Optional so the M3 routes + their
   * tests need no cache; when absent, the narrative route recomputes from the transcript on
   * every call (still correct, just uncached). Content-addressed on (slug + sessionId +
   * transcript stat + version) — a changed transcript misses + recomputes. See narrative-cache.ts.
   */
  narrativeCache?: NarrativeCacheIO;
  /** Injected clock for live-run detection (defaults to Date.now). Tests pin it. */
  now?: () => number;
}

/** GET /api/projects -> ProjectRef[] */
export async function handleProjects(deps: RouteDeps): Promise<RouteResult> {
  const items: ProjectRef[] = await discoverProjects(deps.port, deps.claudeHome);
  return { status: 200, body: items };
}

/** GET /api/projects/:slug/runs -> RunSummary[] (for the slug's recovered projectPath). */
export async function handleProjectRuns(deps: RouteDeps, slug: string): Promise<RouteResult> {
  if (!isValidSegment(slug)) return err(400, 'bad_request');

  // Resolve the slug to its authoritative ProjectRef(s). A slug can collide across
  // multiple recovered cwds; we union the runs of every ProjectRef sharing this slug.
  const projects = await discoverProjects(deps.port, deps.claudeHome);
  const matching = projects.filter((p) => p.slug === slug);
  if (matching.length === 0) return { status: 200, body: [] as RunSummary[] };

  const runs: RunSummary[] = [];
  const finalizedRunIds = new Set<string>();
  for (const project of matching) {
    const projRuns = await discoverRuns(deps.port, project, deps.claudeHome);
    for (const r of projRuns) finalizedRunIds.add(r.ref.runId);
    runs.push(...projRuns);
  }
  // L1: also surface IN-PROGRESS runs (journal present, no finalized json). `nowMs` is
  // supplied by the server (the adapter reads no clock). A run that finalized between the
  // two scans is de-duped by runId in favor of its authoritative finalized summary.
  const nowMs = deps.now ? deps.now() : Date.now();
  for (const project of matching) {
    try {
      const { items } = await discoverRunningRunsReport(deps.port, deps.claudeHome, project, nowMs);
      for (const r of items) {
        if (!finalizedRunIds.has(r.ref.runId)) runs.push(r);
      }
    } catch {
      // detection is best-effort; never fail the run list because of it.
    }
  }
  // Newest first (startTime desc), nulls last — same order discovery uses per-project.
  runs.sort((a, b) => (b.startTime ?? -Infinity) - (a.startTime ?? -Infinity));
  return { status: 200, body: runs };
}

/**
 * GET /api/projects/:slug/workflows -> WorkflowMeta[] (the "review-the-workflow"
 * listing). Mirrors handleProjectRuns: validate the slug (400 on fail), resolve it to
 * its ProjectRef(s) via discovery, read each project's declared `.claude/workflows/*.js`
 * meta via discoverWorkflowMetas, union + dedup by file basename, sort by name. Reads
 * ONLY the static workflow meta — never transcripts, workflowProgress, or agent-*.jsonl.
 * Empty-with-reason (unknown slug / no workflows dir) -> [], never a 500.
 */
export async function handleProjectWorkflows(
  deps: RouteDeps,
  slug: string,
): Promise<RouteResult> {
  if (!isValidSegment(slug)) return err(400, 'bad_request');

  const projects = await discoverProjects(deps.port, deps.claudeHome);
  const matching = projects.filter((p) => p.slug === slug);
  if (matching.length === 0) return { status: 200, body: [] as WorkflowMeta[] };

  // Union the declared workflows of every ProjectRef sharing this slug, deduping by
  // file basename (the same workflow can surface under multiple recovered cwds).
  const byFile = new Map<string, WorkflowMeta>();
  for (const project of matching) {
    const metas = await discoverWorkflowMetas(deps.port, project.projectPath);
    for (const meta of metas) {
      if (!byFile.has(meta.file)) byFile.set(meta.file, meta);
    }
  }
  const workflows = [...byFile.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { status: 200, body: workflows };
}

/**
 * GET /api/projects/:slug/workflows/:file/plan -> PlanModel (P1, run-free).
 * Statically derives the workflow `.js` script's control-flow structure via the
 * adapter's PURE parsePlan (acorn wrap-parse + recursive default-deny walk). Reads ONLY
 * `<project>/.claude/workflows/<file>` THROUGH the FileSystemPort — never a run journal,
 * transcript, or workflowProgress. Mirrors handleProjectWorkflows: validate the slug
 * (400), resolve it to its ProjectRef(s), path-escape-guard the `.js` file (400 on a bad
 * file), then loadPlan. parsePlan never throws; a read miss is a 404 (never 500/leak).
 */
export async function handleProjectPlan(
  deps: RouteDeps,
  slug: string,
  file: string,
): Promise<RouteResult> {
  if (!isValidSegment(slug)) return err(400, 'bad_request');
  if (!isValidWorkflowFile(file)) return err(400, 'bad_request');

  const projects = await discoverProjects(deps.port, deps.claudeHome);
  const matching = projects.filter((p) => p.slug === slug);
  if (matching.length === 0) return err(404, 'not_found');

  // Try each ProjectRef sharing this slug; return the first that has the named workflow.
  for (const project of matching) {
    const jsPath = safeWorkflowJsPath(project.projectPath, file);
    if (jsPath === null) return err(400, 'bad_request');
    let plan: PlanModel;
    try {
      plan = await loadPlan(deps.port, jsPath, file);
    } catch {
      continue; // not present under this recovered cwd; try the next
    }
    // PX: warm the explanation engine in the BACKGROUND (never awaited → the snapshot
    // response is unchanged and does not block on generation). Annotation-only.
    if (deps.explain) {
      deps.explain.warm(planTargetId(slug, file), planArtifacts(plan));
    }
    return { status: 200, body: plan };
  }
  return err(404, 'not_found');
}

/**
 * GET /api/projects/:slug/workflows/:file/explanations -> ExplanationBatch (PX poll).
 * Returns the CURRENT per-node captions for the plan (baseline immediately, llm-enriched
 * when the background pool finishes). Re-warms the engine from the freshly-parsed plan so
 * a first poll (no prior /plan call) still has the artifacts. Same token gate + path guard
 * as the plan route. Never blocks on generation. claude absent/errors -> all baseline.
 */
export async function handleProjectPlanExplanations(
  deps: RouteDeps,
  slug: string,
  file: string,
): Promise<RouteResult> {
  if (!isValidSegment(slug)) return err(400, 'bad_request');
  if (!isValidWorkflowFile(file)) return err(400, 'bad_request');
  const target = planTargetId(slug, file);
  if (!deps.explain) {
    return { status: 200, body: emptyBatch(target) };
  }

  const projects = await discoverProjects(deps.port, deps.claudeHome);
  const matching = projects.filter((p) => p.slug === slug);
  for (const project of matching) {
    const jsPath = safeWorkflowJsPath(project.projectPath, file);
    if (jsPath === null) return err(400, 'bad_request');
    try {
      const plan = await loadPlan(deps.port, jsPath, file);
      deps.explain.warm(target, planArtifacts(plan));
      break;
    } catch {
      continue;
    }
  }
  return { status: 200, body: deps.explain.batch(target) };
}

/**
 * GET /api/runs/:slug/:session/:runId/explanations -> ExplanationBatch (PX poll).
 * Same posture as the plan explanations route, for the execution view's agent cards.
 */
export async function handleRunExplanations(
  deps: RouteDeps,
  slug: string,
  session: string,
  runId: string,
): Promise<RouteResult> {
  const wfPath = safeRunJsonPath(deps.claudeHome, slug, session, runId);
  if (wfPath === null) return err(400, 'bad_request');
  const target = runTargetId(slug, session, runId);
  if (!deps.explain) {
    return { status: 200, body: emptyBatch(target) };
  }

  let header: unknown;
  try {
    header = await deps.port.readJson(wfPath);
  } catch {
    return err(404, 'not_found');
  }
  const o = header && typeof header === 'object' ? (header as Record<string, unknown>) : {};
  const scriptPath = typeof o.scriptPath === 'string' ? o.scriptPath : undefined;
  const projectPath = (scriptPath && recoverProjectPath(scriptPath)) ?? '';
  const ref: RunRef = { projectPath, slug, sessionId: session, runId };
  try {
    const model = await loadRun(deps.port, wfPath, { ref });
    deps.explain.warm(target, runArtifacts(model));
  } catch {
    return err(404, 'not_found');
  }
  return { status: 200, body: deps.explain.batch(target) };
}

/** An empty (engine-absent) batch — all-baseline, never pending. */
function emptyBatch(target: string): ExplanationBatch {
  return { target, pending: false, engineAvailable: false, explanations: [] };
}

/** GET /api/runs/:slug/:session/:runId -> RunModel snapshot. */
export async function handleRunSnapshot(
  deps: RouteDeps,
  slug: string,
  session: string,
  runId: string,
): Promise<RouteResult> {
  const wfPath = safeRunJsonPath(deps.claudeHome, slug, session, runId);
  if (wfPath === null) return err(400, 'bad_request');

  // Read the header once to recover the authoritative projectPath for the RunRef.
  let header: unknown;
  try {
    header = await deps.port.readJson(wfPath);
  } catch {
    return err(404, 'not_found');
  }
  const o = header && typeof header === 'object' ? (header as Record<string, unknown>) : {};
  const scriptPath = typeof o.scriptPath === 'string' ? o.scriptPath : undefined;
  const projectPath = (scriptPath && recoverProjectPath(scriptPath)) ?? '';

  const ref: RunRef = { projectPath, slug, sessionId: session, runId };
  const ctx: AdapterContext = { ref };

  let model: RunModel;
  try {
    model = await loadRun(deps.port, wfPath, ctx);
  } catch {
    // Defensive: loadRun shouldn't throw on malformed input (the adapter tolerates it),
    // but a hard read failure here is a 404, never a 500 that leaks a stack/path.
    return err(404, 'not_found');
  }
  // PX: warm the explanation engine in the BACKGROUND (never awaited → the snapshot
  // response is byte-unchanged and does not block on generation). Annotation-only.
  if (deps.explain) {
    deps.explain.warm(runTargetId(slug, session, runId), runArtifacts(model));
  }
  return { status: 200, body: model };
}

/**
 * GET /api/runs/:slug/:session/:runId/plan -> PlanModel (P2, the per-run plan source).
 * Returns the plan THIS run executed, PREFERRING the EXACT persisted per-run script
 *   `<session>/workflows/scripts/<name>-wf_<id>.js`
 * (what actually ran). When a run has no persisted per-run script (its scriptPath is the
 * shape-(1) project path — e.g. the 14-agent plan-research run), it FALLS BACK to the
 * recovered project workflow `<project>/.claude/workflows/<name>.js` — the SAME documented
 * two-shape fallback discovery's recoverFromScriptPath uses (boundaries.md). The project
 * file MAY have drifted since the run; the per-run script is authoritative when present.
 *
 * Same M3 security posture as the run snapshot route: charset-validate slug/session/runId
 * (400) + resolve()-inside-claudeHome guard on the per-run scripts path, and the M3
 * project-workflow path guard on the fallback. A read miss of BOTH sources is a 404 —
 * never a 500 / leak.
 */
export async function handleRunPlan(
  deps: RouteDeps,
  slug: string,
  session: string,
  runId: string,
): Promise<RouteResult> {
  // Reuse the snapshot path guard to validate slug/session/runId BEFORE any FS access.
  const wfPath = safeRunJsonPath(deps.claudeHome, slug, session, runId);
  if (wfPath === null) return err(400, 'bad_request');

  // Read the run header (for the per-run script basename + the project-path fallback).
  let header: unknown;
  try {
    header = await deps.port.readJson(wfPath);
  } catch {
    // R8b: a RUNNING run has no finalized wf_<id>.json yet — recover its plan from the
    // persisted per-run script directly (so Morph can paint the live run on the plan).
    const file = await findLiveScriptBasename(deps, slug, session, runId);
    if (file !== null) {
      const scriptsPath = safeRunScriptPath(deps.claudeHome, slug, session, runId, file);
      if (scriptsPath !== null) {
        try {
          return { status: 200, body: await loadRunPlan(deps.port, scriptsPath, file) };
        } catch {
          /* fall through to 404 */
        }
      }
    }
    return err(404, 'not_found');
  }

  // 1) PREFERRED: the persisted per-run script under <session>/workflows/scripts/.
  const file = perRunScriptBasename(header, runId);
  if (file !== null) {
    const scriptsPath = safeRunScriptPath(deps.claudeHome, slug, session, runId, file);
    if (scriptsPath === null) return err(400, 'bad_request');
    try {
      return { status: 200, body: await loadRunPlan(deps.port, scriptsPath, file) };
    } catch {
      // No persisted per-run script — fall through to the project-workflow fallback.
    }
  }

  // 2) FALLBACK: the recovered project workflow `.js` (shape-(1) scriptPath). Same path
  //    guard as the M3 project plan route.
  const o = header && typeof header === 'object' ? (header as Record<string, unknown>) : {};
  const scriptPath = typeof o.scriptPath === 'string' ? o.scriptPath : undefined;
  const projectPath = scriptPath ? recoverProjectPath(scriptPath) : null;
  if (projectPath !== null && scriptPath) {
    const wfFile = scriptPath.split(/[/\\]/).pop() ?? '';
    const jsPath = isValidWorkflowFile(wfFile) ? safeWorkflowJsPath(projectPath, wfFile) : null;
    if (jsPath !== null) {
      try {
        return { status: 200, body: await loadPlan(deps.port, jsPath, wfFile) };
      } catch {
        // fall through to 404
      }
    }
  }

  // Neither a per-run script nor a recoverable project script is readable → 404.
  return err(404, 'not_found');
}

/**
 * Find the persisted per-run script basename LIVE — by listing
 * `<session>/workflows/scripts/` for a file ending in `-<runId>.js` (the
 * `<workflowName>-wf_<id>.js` shape). Used when there is no finalized wf_<id>.json header
 * to read the name from (the run is still going). Returns a validated basename, or null.
 */
async function findLiveScriptBasename(
  deps: RouteDeps,
  slug: string,
  session: string,
  runId: string,
): Promise<string | null> {
  const dir = safeRunScriptsDir(deps.claudeHome, slug, session, runId);
  if (dir === null) return null;
  let entries: Array<{ name: string; isDir: boolean }>;
  try {
    entries = await deps.port.listDir(dir);
  } catch {
    return null;
  }
  const suffix = `-${runId}.js`;
  const hit = entries.find((e) => !e.isDir && e.name.endsWith(suffix) && isValidWorkflowFile(e.name));
  return hit ? hit.name : null;
}

/** An agentId is a hex-ish token (e.g. `a403d457ffb0b3e01`). Validate BEFORE any FS use. */
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
export function isValidAgentId(id: string): boolean {
  return AGENT_ID_RE.test(id);
}

/** Cap the lazy full-result payload (a localhost dashboard, but never unbounded). */
const RESULT_EMIT_CAP = 512 * 1024;

/**
 * Pre-flight bound on the LIVE journal read (ARCH-6 gap #2). A live run reads its whole
 * `journal.jsonl` into memory; a pathological runaway/looping journal could OOM. 32 MB is
 * ~3 orders of magnitude over a real run (< 100 agents × ~500 B ≈ 50 KB), so it never
 * trips in practice but caps the worst case. When `stat` reports a journal over this, we
 * still read it but pass the cap to the adapter, which parses only the head (preserving
 * start-order binding) and stamps a `journal-truncated` warning (honest degrade, never a
 * silent drop or crash). The eventual finalized snapshot is authoritative.
 */
const LIVE_JOURNAL_READ_CAP = 32 * 1024 * 1024;

/**
 * GET /api/runs/:slug/:session/:runId/result?agentId=<id> -> { agentId, value, truncated }.
 * The FULL (uncapped) result of one agent, read from the journal `result` event (R1 — the
 * inspect panel's "full result" lazy fetch; the finalized snapshot only keeps a ~401-char
 * preview). `value` is the agent's raw return — a STRING (text agent) or OBJECT (schema
 * agent) — so the dashboard renders it readably. Same M3 posture: charset-validate
 * slug/session/runId + agentId (400) and the resolve()-inside-home journal guard. A missing
 * journal is 404; an agent with no result is `{ value: null }`. A value over the cap is
 * stringified + truncated with `truncated:true`. NEVER 500s / leaks.
 */
export async function handleAgentResult(
  deps: RouteDeps,
  slug: string,
  session: string,
  runId: string,
  agentId: string,
): Promise<RouteResult> {
  const journalPath = safeRunJournalPath(deps.claudeHome, slug, session, runId);
  if (journalPath === null || !isValidAgentId(agentId)) return err(400, 'bad_request');

  // TODO(ARCH-6 gap #2, deferred): this lazy full-result fetch reads the WHOLE journal
  // unbounded to find one agent's result. Bounding it correctly needs a scan-to-match (not
  // a head cap, which could miss a later agent) — a heavier change for marginal value vs
  // the live-snapshot guard above. Left unbounded for now; revisit if a real journal grows.
  let text: string;
  try {
    text = await deps.port.readFile(journalPath);
  } catch {
    return err(404, 'not_found');
  }
  const raw = agentResultFromJournal(text, agentId);
  // Defense-in-depth: scrub internal $bunfs paths from the emitted result text (a string result is
  // the common case; an object result is JSON-redacted at the serialized boundary below).
  const value = typeof raw === 'string' ? redactInternalPaths(raw) : raw;
  // Cap: measure the serialized size; over the cap → a truncated string form.
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof serialized === 'string' && serialized.length > RESULT_EMIT_CAP) {
    return {
      status: 200,
      body: { agentId, value: redactInternalPaths(serialized.slice(0, RESULT_EMIT_CAP)), truncated: true },
    };
  }
  return { status: 200, body: { agentId, value, truncated: false } };
}

/**
 * GET /api/runs/:slug/:session/:runId/activity?agentId=<id> -> { activity }.
 * The drill-into-an-agent endpoint (failure-and-live-inspector §4/§5): lazily parses the
 * per-agent session transcript `<runDir>/agent-<id>.jsonl` (100KB–1.2MB, possibly live/
 * partial) into a compact {@link AgentActivity} (label, tool counts, tokens, the capped
 * tool-use timeline, last activity text, error) via the adapter's agentActivityFromDir.
 * Mirrors handleAgentResult's M3 posture: charset-validate slug/session/runId + agentId
 * (400) and resolve()-inside-home guard on the run dir. The transcript is ABSENT on a
 * cleaned/old run → the adapter returns null and we 404 (the inspector degrades to the
 * journal + run.error). NEVER 500s / leaks a stack or path. Never bundled into the run
 * list (cost) — fetched on select / for live agents only.
 */
export async function handleAgentActivity(
  deps: RouteDeps,
  slug: string,
  session: string,
  runId: string,
  agentId: string,
): Promise<RouteResult> {
  const runDir = safeRunDir(deps.claudeHome, slug, session, runId);
  if (runDir === null || !isValidAgentId(agentId)) return err(400, 'bad_request');

  const activity = await agentActivityFromDir(deps.port, runDir, agentId);
  if (activity === null) return err(404, 'not_found');
  return { status: 200, body: { activity } };
}

/**
 * GET /api/runs/:slug/:session/:runId/failure-cause?agentId=<id> -> { cause: AgentFailureCause | null }.
 * The ACCURATE failure cause for a failed run's proximate agent: read its `agent-<id>.jsonl`
 * transcript tail and classify the terminal error (a dropped socket / usage limit / overload =
 * INFRA, vs a StructuredOutput schema rejection = a real MODEL fault). The run model's
 * `error.message` only ever says "completed without calling StructuredOutput", which is ~96%
 * misleading — this lets the banner show the real cause. Absent transcript → cause:null (the UI
 * falls back to the model's cleaned message); NEVER 500s.
 */
export async function handleFailureCause(
  deps: RouteDeps,
  slug: string,
  session: string,
  runId: string,
  agentId: string,
): Promise<RouteResult> {
  const runDir = safeRunDir(deps.claudeHome, slug, session, runId);
  if (runDir === null || !isValidAgentId(agentId)) return err(400, 'bad_request');
  let text: string;
  try {
    text = await deps.port.readFile(`${runDir}${sep}agent-${agentId}.jsonl`);
  } catch {
    return { status: 200, body: { cause: null } }; // no transcript persisted → no accurate cause
  }
  return { status: 200, body: { cause: classifyFailureText(transcriptTail(text)) } };
}

/**
 * GET /api/runs/:slug/:session/:runId/subui?agentId=<id> -> SubUiResponse (#9).
 * Claude generates a TAILORED, constrained PanelSpec for the agent's full result (read
 * from the journal, like R1). Same M3 guards as the result route. The engine validates +
 * caches; absent engine / no result → `unavailable` (the web falls back to R1's readable
 * view). NEVER 500s. Generation is on-demand and may take a few seconds (cached after).
 */
export async function handleSubUi(
  deps: RouteDeps,
  slug: string,
  session: string,
  runId: string,
  agentId: string,
): Promise<RouteResult> {
  const journalPath = safeRunJournalPath(deps.claudeHome, slug, session, runId);
  if (journalPath === null || !isValidAgentId(agentId)) return err(400, 'bad_request');
  const target = `${runId}:${agentId}`;
  if (!deps.subui) {
    return { status: 200, body: { target, status: 'unavailable', spec: null } };
  }
  let text: string;
  try {
    text = await deps.port.readFile(journalPath);
  } catch {
    return err(404, 'not_found');
  }
  const value = agentResultFromJournal(text, agentId);
  if (value === null) return { status: 200, body: { target, status: 'error', spec: null } };
  const { status, spec } = await deps.subui.generate(value);
  return { status: 200, body: { target, status, spec } };
}

/**
 * GET /api/runs/:slug/:session/:runId/describe -> SubUiResponse (inspect I4).
 * Claude generates a plain-language "what this workflow DID" panel from a compact run
 * DIGEST (workflow / status / phases / per-agent label+state+metrics / logs / partial-
 * failure) — reusing the #9 sub-UI engine + grammar. Reads the finalized run model only
 * (a finished run); same M3 guards. Absent engine / unreadable run → unavailable / 404.
 */
export async function handleDescribe(
  deps: RouteDeps,
  slug: string,
  session: string,
  runId: string,
): Promise<RouteResult> {
  const wfPath = safeRunJsonPath(deps.claudeHome, slug, session, runId);
  if (wfPath === null) return err(400, 'bad_request');
  const target = `${runId}:describe`;
  if (!deps.subui) return { status: 200, body: { target, status: 'unavailable', spec: null } };

  let model: RunModel;
  try {
    const ref: RunRef = { projectPath: '', slug, sessionId: session, runId };
    model = await loadRun(deps.port, wfPath, { ref });
  } catch {
    return err(404, 'not_found');
  }
  // A COMPACT digest (no huge result blobs — just the structure + outcomes), so the
  // describe is about the WHOLE run, deterministic, and cache-stable.
  const digest = {
    workflow: model.workflowName,
    status: model.status,
    summary: model.summary,
    durationMs: model.durationMs,
    phases: model.phases.map((p) => p.title),
    agents: model.agents.map((a) => ({
      label: a.label,
      phase: a.phaseIndex,
      state: a.state,
      model: a.model,
      tokens: a.tokens,
      tools: a.toolCalls,
    })),
    logs: model.logs,
    partialFailure: model.partialFailure.lines,
    error: model.error?.message ?? null,
  };
  const { status, spec } = await deps.subui.generate(digest);
  return { status: 200, body: { target, status, spec } };
}

/** The minimal streaming-response surface handleStream needs (a Node ServerResponse fits;
 *  a test fake implements it). Kept structural so routes.ts stays http-framework-free. */
export interface SseResponse {
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: string): void;
  end(chunk?: string): void;
  on(event: string, cb: () => void): void;
}

/**
 * L3: the SSE live stream (extracted here so it's unit-testable; arch-review #5). Watches
 * the run's journal.jsonl and pushes a `changed` event per append → the client refetches
 * the live model (the run-list poll detects finalize). Initial `open`, a heartbeat, and
 * `retry: 3000` for clean EventSource reconnect; the watch is torn down on disconnect. The
 * caller token-gates /stream before this runs. NEVER throws.
 */
export function handleStream(
  deps: RouteDeps,
  res: SseResponse,
  slug: string,
  session: string,
  runId: string,
): void {
  const journalPath = safeRunJournalPath(deps.claudeHome, slug, session, runId);
  if (journalPath === null) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end('{"error":"bad_request"}');
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-content-type-options': 'nosniff',
  });
  let eventId = 0;
  const emit = (event: string): void => {
    res.write(`id: ${(eventId += 1)}\nevent: ${event}\ndata: {}\n\n`);
  };
  res.write('retry: 3000\n\n');
  emit('open');

  // Debounce rapid fs.watch fires (an append can emit several 'change' events).
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onChange = (): void => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        emit('changed');
      } catch {
        /* the connection may have closed mid-write */
      }
    }, 150);
  };
  let unwatch: (() => void) | null = null;
  try {
    unwatch = deps.port.watch(journalPath, onChange);
  } catch {
    /* the journal vanished (finalized) — the client's run-list poll takes over */
  }
  const heartbeat = setInterval(() => {
    try {
      res.write(': hb\n\n');
    } catch {
      /* ignore */
    }
  }, 15000);
  const cleanup = (): void => {
    clearInterval(heartbeat);
    if (timer) clearTimeout(timer);
    if (unwatch) {
      try {
        unwatch();
      } catch {
        /* ignore */
      }
    }
  };
  res.on('close', cleanup);
  res.on('error', cleanup);
}

/**
 * GET /api/runs/:slug/:session/:runId/live -> RunModel (L2 partial live snapshot).
 * Reads the live `journal.jsonl` THROUGH the port and builds a partial RunModel
 * (`incomplete:true`, `status:'running'`) via the adapter's buildLiveModel. Best-effort,
 * it also locates + parses the persisted per-run script (no finalized header exists yet)
 * to recover labels/phases by start-order binding; if absent, agents stay anonymous in a
 * single "Running" lane. Same M3 posture: charset-validate slug/session/runId (400) +
 * resolve()-inside-home guard on the journal path. A journal read miss is a 404 (the run
 * finalized or never started) — the client then re-fetches the finalized snapshot.
 */
export async function handleRunLive(
  deps: RouteDeps,
  slug: string,
  session: string,
  runId: string,
): Promise<RouteResult> {
  const journalPath = safeRunJournalPath(deps.claudeHome, slug, session, runId);
  if (journalPath === null) return err(400, 'bad_request');

  // Best-effort: parse the persisted per-run script into a plan for label/phase recovery.
  let plan: PlanModel | undefined;
  const file = await findLiveScriptBasename(deps, slug, session, runId);
  if (file !== null) {
    const scriptsPath = safeRunScriptPath(deps.claudeHome, slug, session, runId, file);
    if (scriptsPath !== null) {
      try {
        plan = await loadRunPlan(deps.port, scriptsPath, file);
      } catch {
        // no readable script → anonymous live model
      }
    }
  }

  // Pre-flight size guard (ARCH-6 gap #2): if the journal is pathologically large, bound
  // the parse so a runaway journal can't OOM the parse step. A null stat is a normal miss
  // (the run finalized / never started) — fall through and let the read decide 200 vs 404.
  let maxBytes: number | undefined;
  const st = await deps.port.stat(journalPath);
  if (st !== null && st.size > LIVE_JOURNAL_READ_CAP) maxBytes = LIVE_JOURNAL_READ_CAP;

  const ref: RunRef = { projectPath: '', slug, sessionId: session, runId };
  try {
    const model = await loadLiveModel(deps.port, journalPath, ref, { plan: plan ?? null, maxBytes });
    return { status: 200, body: model };
  } catch {
    return err(404, 'not_found');
  }
}

// --- Session Narrative ("Story" view) routes (M1) ---------------------------
//
// project → sessions-on-a-timeline → per-session topic blocks → (lazy) full turns.
// All three routes inherit the same security envelope as the run routes: the index.ts
// token + Host/Origin gate runs FIRST, then each handler charset-validates slug + sessionId
// and resolve()-verifies the SIBLING transcript path stays inside claudeHome (the dedicated
// safeSessionTranscriptPath guard — the existing safeRun*Path helpers build SUBDIR paths and
// do not cover this sibling .jsonl). READ-ONLY; all disk goes through the injected port.

/**
 * GET /api/projects/:slug/sessions -> { sessions: SessionSummary[] }.
 * The top of the Story view — a project's sessions as start→end spans + cheap counts
 * (records · workflow spawns · commits) via the adapter's discoverSessions, which lists the
 * SIBLING `<slug>/*.jsonl` transcripts and derives each summary from one defensive scan (no
 * per-block segmentation). Mirrors handleProjectRuns: validate the slug (400), resolve it to
 * its ProjectRef(s) so the per-session projectPath can be backfilled from the authoritative
 * recovered cwd, then union the sessions across every ProjectRef sharing the slug (deduped by
 * sessionId, newest-first preserved). An unknown slug / empty dir -> { sessions: [] }, never
 * a 500 (discoverSessions swallows a per-file read error and an absent dir).
 */
export async function handleProjectSessions(
  deps: RouteDeps,
  slug: string,
): Promise<RouteResult> {
  if (!isValidSegment(slug)) return err(400, 'bad_request');

  const projects = await discoverProjects(deps.port, deps.claudeHome);
  const matching = projects.filter((p) => p.slug === slug);
  // A slug with no recovered ProjectRef can still have sibling transcripts on disk; fall
  // back to a single projectPath-less discovery so the timeline is never silently empty.
  const projectPaths: Array<string | undefined> =
    matching.length > 0 ? matching.map((p) => p.projectPath) : [undefined];

  const byId = new Map<string, SessionSummary>();
  for (const projectPath of projectPaths) {
    let summaries: SessionSummary[];
    try {
      summaries = await discoverSessions(deps.port, deps.claudeHome, slug, projectPath);
    } catch {
      continue; // best-effort; discoverSessions itself never throws, but stay defensive
    }
    for (const s of summaries) {
      if (!byId.has(s.sessionId)) byId.set(s.sessionId, s);
    }
  }
  // discoverSessions returns newest-first; the dedup above preserves first-seen order.
  return { status: 200, body: { sessions: [...byId.values()] } };
}

/**
 * GET /api/projects/:slug/sessions/:sessionId/narrative -> SessionNarrative.
 * The watch view: the full Stage-1 narrative (real-prompt topic blocks + head/tail-bounded,
 * redact()-routed previews), server-PRECOMPUTED + DISK-CACHED mirroring explain.ts. The
 * cache key folds in the transcript's `stat` {size, mtimeMs} (narrativeCacheKey) so a
 * stat-CHANGED transcript (an append) MISSES + recomputes — appends refresh, an unchanged
 * session re-opens to an instant hit. Same M1 posture: charset-validate slug + sessionId
 * (400) + the sibling-path guard; a MISSING transcript is a 404 (never a 500 — loadSession-
 * Narrative's read failure is the only throw and we map it). The adapter never 500s on parse.
 */
export async function handleSessionNarrative(
  deps: RouteDeps,
  slug: string,
  sessionId: string,
): Promise<RouteResult> {
  const transcriptPath = safeSessionTranscriptPath(deps.claudeHome, slug, sessionId);
  if (transcriptPath === null) return err(400, 'bad_request');

  // stat() is the cheap probe BOTH for existence (a null stat → 404 before any read) and for
  // the cache key. A missing transcript never costs a 67 MB read.
  const st = await deps.port.stat(transcriptPath);
  if (st === null) return err(404, 'not_found');

  // 1) Cache hit: keyed by (slug + sessionId + stat + version). An append moves size/mtimeMs
  //    → a NEW key → a miss → recompute (so the narrative refreshes), with no stale serve.
  const key = deps.narrativeCache
    ? narrativeCacheKey(slug, sessionId, { size: st.size, mtimeMs: st.mtimeMs })
    : null;
  if (deps.narrativeCache && key !== null) {
    const cached = await deps.narrativeCache.read(key);
    if (cached !== null) return { status: 200, body: cached };
  }

  // 2) Miss → precompute from the transcript THROUGH the port (the adapter is pure / port-
  //    injected; it never throws on parse — only the readFile can, which is the 404 case).
  let narrative: SessionNarrative;
  try {
    narrative = await loadSessionNarrative(deps.port, transcriptPath, sessionId);
  } catch {
    return err(404, 'not_found'); // a vanished/locked transcript → 404, never a 500/leak
  }

  // 3) Persist (best-effort; a write failure is swallowed by the cache IO — the narrative
  //    still serves this call). Content-addressed: the same stat re-opens to a hit.
  if (deps.narrativeCache && key !== null) {
    await deps.narrativeCache.write(key, narrative);
  }
  return { status: 200, body: narrative };
}

/**
 * GET /api/projects/:slug/sessions/:sessionId/turns?block=<blockId> -> { turns: Turn[] }.
 * The lazy click-in view: the full Turns of ONE block, fetched on demand (never inlined in
 * the narrative). We resolve the opaque `blockId` to its `recordRange` by looking it up in
 * the session's narrative (a cache hit when the watch view was just rendered; else a recompute
 * — same stat-keyed cache as the narrative route), then slice the transcript to that range via
 * the adapter's loadBlockTurns. Same M1 posture: charset-validate slug + sessionId (400) + the
 * sibling-path guard. A missing `block` param is a 400; an unknown blockId is a 404; a missing
 * transcript is a 404. NEVER 500s / leaks. The blockId is treated as untrusted (only matched
 * against the narrative's own ids — never used to build a path).
 */
export async function handleSessionTurns(
  deps: RouteDeps,
  slug: string,
  sessionId: string,
  blockId: string,
): Promise<RouteResult> {
  const transcriptPath = safeSessionTranscriptPath(deps.claudeHome, slug, sessionId);
  if (transcriptPath === null) return err(400, 'bad_request');
  if (blockId.length === 0) return err(400, 'bad_request');

  const st = await deps.port.stat(transcriptPath);
  if (st === null) return err(404, 'not_found');

  // Resolve the blockId → recordRange from the (cached or freshly-computed) narrative. We reuse
  // the SAME stat-keyed cache so a click-in right after a watch render is a hit (no re-scan).
  const key = deps.narrativeCache
    ? narrativeCacheKey(slug, sessionId, { size: st.size, mtimeMs: st.mtimeMs })
    : null;
  let narrative: SessionNarrative | null = null;
  if (deps.narrativeCache && key !== null) {
    narrative = await deps.narrativeCache.read(key);
  }
  if (narrative === null) {
    try {
      narrative = await loadSessionNarrative(deps.port, transcriptPath, sessionId);
    } catch {
      return err(404, 'not_found');
    }
    if (deps.narrativeCache && key !== null) {
      await deps.narrativeCache.write(key, narrative);
    }
  }

  const block: NarrativeBlock | undefined = narrative.blocks.find((b) => b.id === blockId);
  if (block === undefined) return err(404, 'not_found'); // unknown / stale block id

  const recordRange: RecordRange = block.recordRange;
  let turns: Turn[];
  try {
    turns = await loadBlockTurns(deps.port, transcriptPath, recordRange);
  } catch {
    return err(404, 'not_found'); // transcript vanished between the stat and the slice → 404
  }
  return { status: 200, body: { turns } };
}
