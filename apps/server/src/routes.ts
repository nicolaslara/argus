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
  discoverProjects,
  discoverRuns,
  discoverRunningRunsReport,
  discoverWorkflowMetas,
  loadLiveModel,
  loadPlan,
  loadRun,
  loadRunPlan,
  perRunScriptBasename,
  recoverProjectPath,
  type FileSystemPort,
  type AdapterContext,
} from '@argus/adapter';
import type {
  ExplanationBatch,
  PlanModel,
  ProjectRef,
  RunModel,
  RunRef,
  RunSummary,
  WorkflowMeta,
} from '@argus/contract';
import {
  ExplanationEngine,
  planArtifacts,
  planTargetId,
  runArtifacts,
  runTargetId,
} from './explain.ts';

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
  if (!isValidSegment(slug) || !isValidSegment(session) || !isValidRunId(runId)) return null;
  const homeAbs = resolve(claudeHome);
  const candidate = resolve(
    homeAbs,
    'projects',
    slug,
    session,
    'subagents',
    'workflows',
    runId,
    'journal.jsonl',
  );
  if (candidate !== homeAbs && !candidate.startsWith(homeAbs + sep)) return null;
  return candidate;
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
  /**
   * The Explanation engine (PX). Optional so the M3/P0/P1 routes and their tests need no
   * engine; when present, the plan/run handlers warm it in the BACKGROUND (never awaited)
   * and the explanations route reads its current batch.
   */
  explain?: ExplanationEngine;
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

  const ref: RunRef = { projectPath: '', slug, sessionId: session, runId };
  try {
    const model = await loadLiveModel(deps.port, journalPath, ref, { plan: plan ?? null });
    return { status: 200, body: model };
  } catch {
    return err(404, 'not_found');
  }
}
