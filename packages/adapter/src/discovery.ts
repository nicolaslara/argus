// @argus/adapter — discovery (prototype M2). Enumerates a Claude Code project's
// workflow runs (and static workflow definitions) from the on-disk tree.
//
// ALL disk access goes through the injected FileSystemPort — this module (like the
// rest of the adapter) NEVER imports node:fs. It reads HEADER fields only from each
// finalized wf_*.json (workflowName/status/agentCount/durationMs/startTime/summary +
// partialFailure from a logs[] /failed/ scan); it does NOT walk workflowProgress or
// any transcript (zero per-agent I/O).
//
// The authoritative key for a project/run is the recovered absolute projectPath
// (NOT the lossy/collision-prone slug). Multiple cwds that collapse to one slug dir
// therefore surface as multiple ProjectRef switcher entries.

import type { ProjectRef, RunSummary, RunRef, RunStatus, WorkflowMeta } from '@argus/contract';
import { deriveRunStatus, findFailureLogLines } from './raw.ts';
import { classifyRunLiveness } from './live.ts';

/** Minimal port surface used by discovery (a subset of FileSystemPort). */
interface DiscoveryPort {
  readJson(path: string): Promise<unknown>;
  readFile(path: string): Promise<string>;
  listDir(path: string): Promise<Array<{ name: string; isDir: boolean }>>;
}

/** Detection also needs cheap existence + mtime (a superset of {@link DiscoveryPort}). */
interface RunningDetectPort extends DiscoveryPort {
  stat(path: string): Promise<{ size: number; mtimeMs: number } | null>;
  exists(path: string): Promise<boolean>;
}

/**
 * Empty-with-reason envelope. Discovery NEVER throws: a bogus/missing path, an
 * unreadable file, or a malformed header is captured as a coded `reason` (never a
 * raw path) and the corresponding item is simply omitted. `reasons` is for
 * diagnostics; the public `discoverProjects`/`discoverRuns` return just `items`.
 */
export interface DiscoveryReport<T> {
  items: T[];
  reasons: Array<{ code: string; detail?: string }>;
}

// --- path helpers (join WITHOUT importing node:path; the tree is always POSIX-ish
//     under ~/.claude/projects and we never resolve `..`). ---

function join(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, '') : p.replace(/^\/+|\/+$/g, '')))
    .filter((p) => p.length > 0)
    .join('/');
}

function basename(path: string): string {
  const cleaned = path.replace(/[/\\]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/**
 * Decode an on-disk slug back to a best-effort absolute path. LOSSY/heuristic — the
 * slug rule (every non-alphanumeric -> '-') is not invertible. Used ONLY as a
 * documented fallback display key when a run's scriptPath does NOT carry the project
 * root (the observed `<slug>/<session>/workflows/scripts/<name>-wf_<id>.js` shape).
 * The leading '-' becomes '/'; every other '-' becomes '/'. Collapses are unavoidable
 * (e.g. '--config' -> '//config'), so this is NEVER the authoritative key when a real
 * scriptPath is available.
 */
export function decodeSlug(slug: string): string {
  // Leading dash => absolute root. Remaining dashes => path separators.
  const body = slug.replace(/^-/, '');
  return '/' + body.replace(/-/g, '/');
}

// --- run-header projection (HEADER FIELDS ONLY — no workflowProgress walk) ---

const WF_FILE_RE = /^wf_.+\.json$/;

/** Extract the runId ("wf_<id>") from a wf_*.json filename. */
function runIdFromFile(file: string): string {
  return file.replace(/\.json$/i, '');
}

/**
 * Authoritatively recover a project root from a run's scriptPath, distinguishing the
 * two observed scriptPath shapes:
 *   1. `<project>/.claude/workflows/<file>.js` -> recoverable (authoritative). Returns the root.
 *   2. `~/.claude/projects/<slug>/<session>/workflows/scripts/<name>-wf_<id>.js`
 *      -> NOT project-recoverable (its prefix is the slug-dir cache path). Returns null.
 * `null` callers fall back to a documented heuristic (recovered sibling, then decodeSlug).
 */
function recoverFromScriptPath(scriptPath: string | undefined): string | null {
  if (typeof scriptPath !== 'string') return null;
  const split = scriptPath.split(/[/\\]\.claude[/\\]workflows[/\\]/);
  if (split.length <= 1) return null;
  const prefix = split[0]!;
  // Shape (2) ALSO matches `.claude/workflows/`, but its prefix is itself under
  // `.claude/projects/` (the slug-dir cache) — that's never a real project root.
  if (prefix.length === 0 || /[/\\]\.claude[/\\]projects[/\\]/.test(prefix)) return null;
  return prefix;
}

/** Read HEADER fields only from a finalized wf_*.json. NEVER throws. */
function projectRunSummary(
  raw: unknown,
  ref: RunRef,
): { summary: RunSummary; scriptPath: string | undefined } {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

  const workflowName = typeof o.workflowName === 'string' ? o.workflowName : '';
  const status: RunStatus = deriveRunStatus(o.status);
  const startTime = typeof o.startTime === 'number' ? o.startTime : null;
  const durationMs = typeof o.durationMs === 'number' ? o.durationMs : null;
  const summaryText = typeof o.summary === 'string' ? o.summary : '';

  // agentCount: prefer the persisted header scalar; never walk workflowProgress.
  const agentCount = typeof o.agentCount === 'number' ? o.agentCount : 0;

  // partialFailure: a logs[] /failed/ scan (HEADER-level signal; no per-agent I/O).
  const logs = Array.isArray(o.logs) ? (o.logs as unknown[]) : [];
  const partialFailure = findFailureLogLines(logs).length > 0;

  const scriptPath = typeof o.scriptPath === 'string' ? o.scriptPath : undefined;

  return {
    summary: { ref, workflowName, status, agentCount, durationMs, startTime, summary: summaryText, partialFailure },
    scriptPath,
  };
}

// --- tree walking -----------------------------------------------------------

interface RawRunHit {
  slug: string;
  sessionId: string;
  runId: string;
  wfJsonPath: string;
}

/**
 * Walk `<claudeHome>/projects/<slug>/<session>/workflows/wf_*.json` and yield each
 * finalized run file's location (no reads yet). Every level is guarded: a missing or
 * unreadable dir contributes a coded reason and is skipped, never a throw.
 */
async function walkRunFiles(
  port: DiscoveryPort,
  claudeHome: string,
  reasons: DiscoveryReport<unknown>['reasons'],
  slugFilter?: string,
): Promise<RawRunHit[]> {
  const hits: RawRunHit[] = [];
  const projectsDir = join(claudeHome, 'projects');

  let slugDirs: Array<{ name: string; isDir: boolean }>;
  try {
    slugDirs = await port.listDir(projectsDir);
  } catch {
    reasons.push({ code: 'projects-dir-unreadable' });
    return hits;
  }

  for (const slugEntry of slugDirs) {
    if (!slugEntry.isDir) continue;
    if (slugFilter !== undefined && slugEntry.name !== slugFilter) continue;
    const slug = slugEntry.name;
    const slugPath = join(projectsDir, slug);

    let sessionDirs: Array<{ name: string; isDir: boolean }>;
    try {
      sessionDirs = await port.listDir(slugPath);
    } catch {
      reasons.push({ code: 'slug-dir-unreadable', detail: slug });
      continue;
    }

    for (const sessionEntry of sessionDirs) {
      if (!sessionEntry.isDir) continue;
      const sessionId = sessionEntry.name;
      const workflowsPath = join(slugPath, sessionId, 'workflows');

      let wfEntries: Array<{ name: string; isDir: boolean }>;
      try {
        wfEntries = await port.listDir(workflowsPath);
      } catch {
        // No workflows dir for this session is normal (not every session runs one).
        continue;
      }

      for (const wf of wfEntries) {
        if (wf.isDir) continue;
        if (!WF_FILE_RE.test(wf.name)) continue;
        hits.push({
          slug,
          sessionId,
          runId: runIdFromFile(wf.name),
          wfJsonPath: join(workflowsPath, wf.name),
        });
      }
    }
  }

  return hits;
}

/** A run hit whose HEADER has been read and whose authoritative projectPath resolved. */
interface ResolvedRun {
  hit: RawRunHit;
  header: unknown;
  /** Authoritatively recovered (true) or fallback heuristic (false). */
  recovered: boolean;
  projectPath: string;
}

/**
 * Read every run file's HEADER once and resolve each to its authoritative
 * projectPath. The resolution is two-pass per slug dir:
 *   - shape (1) scriptPath -> the recovered root (authoritative).
 *   - shape (2) cache scriptPath (NOT recoverable) -> fall back, in order, to:
 *       (a) a UNIQUE recovered sibling under the SAME slug dir (the common case:
 *           later runs persist the cache-shape scriptPath, earlier ones the real
 *           root — group them together), else
 *       (b) decodeSlug(slug) (lossy, but the run still surfaces — never dropped).
 * NEVER throws; per-file read errors become coded reasons.
 */
async function readAndResolve(
  port: DiscoveryPort,
  hits: RawRunHit[],
  reasons: DiscoveryReport<unknown>['reasons'],
): Promise<ResolvedRun[]> {
  // Pass 1: read headers + recover authoritative paths where possible.
  const raw: Array<{ hit: RawRunHit; header: unknown; recovered: string | null }> = [];
  for (const hit of hits) {
    let header: unknown;
    try {
      header = await port.readJson(hit.wfJsonPath);
    } catch {
      reasons.push({ code: 'run-header-unreadable', detail: hit.runId });
      continue;
    }
    const o = header && typeof header === 'object' ? (header as Record<string, unknown>) : {};
    const scriptPath = typeof o.scriptPath === 'string' ? o.scriptPath : undefined;
    raw.push({ hit, header, recovered: recoverFromScriptPath(scriptPath) });
  }

  // Pass 2: per-slug map of the (unique) recovered root, used to absorb cache-shape runs.
  const recoveredBySlug = new Map<string, Set<string>>();
  for (const r of raw) {
    if (r.recovered === null) continue;
    const set = recoveredBySlug.get(r.hit.slug) ?? new Set<string>();
    set.add(r.recovered);
    recoveredBySlug.set(r.hit.slug, set);
  }

  return raw.map((r) => {
    if (r.recovered !== null) {
      return { hit: r.hit, header: r.header, recovered: true, projectPath: r.recovered };
    }
    const siblings = recoveredBySlug.get(r.hit.slug);
    if (siblings && siblings.size === 1) {
      // Exactly one recovered cwd shares this slug dir -> the cache-shape run is the
      // same project (recovered heuristic, treated as authoritative grouping).
      return { hit: r.hit, header: r.header, recovered: true, projectPath: [...siblings][0]! };
    }
    // No (or ambiguous) recovered sibling -> lossy decode, but still surface the run.
    return { hit: r.hit, header: r.header, recovered: false, projectPath: decodeSlug(r.hit.slug) };
  });
}

// --- public discovery (report variants; thin array wrappers live in index.ts) ---

/**
 * Discover projects under a claude home: every finalized run's authoritative
 * projectPath, de-duped. Reads each run's HEADER only (for scriptPath). NEVER throws.
 */
export async function discoverProjectsReport(
  port: DiscoveryPort,
  claudeHome: string,
): Promise<DiscoveryReport<ProjectRef>> {
  const reasons: DiscoveryReport<unknown>['reasons'] = [];
  const hits = await walkRunFiles(port, claudeHome, reasons);
  const resolved = await readAndResolve(port, hits, reasons);

  // Group by recovered absolute projectPath. Track distinct sessions per project.
  const byPath = new Map<string, { slug: string; sessions: Set<string> }>();
  for (const r of resolved) {
    const entry = byPath.get(r.projectPath);
    if (entry) entry.sessions.add(r.hit.sessionId);
    else byPath.set(r.projectPath, { slug: r.hit.slug, sessions: new Set([r.hit.sessionId]) });
  }

  const items: ProjectRef[] = [...byPath.entries()]
    .map(([projectPath, { slug, sessions }]) => ({
      projectPath,
      slug,
      name: basename(projectPath),
      sessionCount: sessions.size,
    }))
    .sort((a, b) => a.projectPath.localeCompare(b.projectPath));

  return { items, reasons };
}

/**
 * List a project's runs — HEADER fields ONLY (zero transcript / workflowProgress
 * I/O). Runs are keyed by the recovered authoritative projectPath and filtered to
 * the project (so a slug collision surfaces only the runs whose recovered cwd
 * matches `project.projectPath`). NEVER throws.
 *
 * `claudeHome` is the root the project's slug dir lives under. The public
 * `discoverRuns(port, project, claudeHome?)` wrapper in index.ts supplies it
 * (defaulting to the production `~/.claude`); we keep it an explicit arg so the
 * adapter never reads env/HOME itself (stays node:fs-free and side-effect-free).
 */
export async function discoverRunsReport(
  port: DiscoveryPort,
  claudeHome: string,
  project: ProjectRef,
): Promise<DiscoveryReport<RunSummary>> {
  const reasons: DiscoveryReport<unknown>['reasons'] = [];
  const hits = await walkRunFiles(port, claudeHome, reasons, project.slug);
  const resolved = await readAndResolve(port, hits, reasons);

  const items: RunSummary[] = [];
  for (const r of resolved) {
    // Group/dedup by recovered abs path: only runs whose recovered cwd matches this
    // ProjectRef belong to it (a slug collision splits runs across ProjectRefs).
    if (r.projectPath !== project.projectPath) continue;
    const ref: RunRef = {
      projectPath: r.projectPath,
      slug: r.hit.slug,
      sessionId: r.hit.sessionId,
      runId: r.hit.runId,
    };
    items.push(projectRunSummary(r.header, ref).summary);
  }

  // Stable order: newest first (startTime desc), nulls last.
  items.sort((a, b) => (b.startTime ?? -Infinity) - (a.startTime ?? -Infinity));

  return { items, reasons };
}

// --- running-run detection (L1) ---------------------------------------------

/**
 * Detect IN-PROGRESS runs for a project by scanning, in each session, the live journal
 * tree `subagents/workflows/<runId>/journal.jsonl` for runs that have NO finalized
 * `workflows/<runId>.json` yet (F1: the finalized json is written once, at finalize, so
 * its absence + a fresh journal ⇒ the run is still going). Liveness is classified by
 * {@link classifyRunLiveness}; only `running` runs are emitted (a `stale` journal that
 * never finalized — a likely crash — is omitted). HEADER-cheap: per run it does one
 * `exists` (finalized json) + one `stat` (journal mtime); it does NOT read the journal
 * body (agent counts come later, when the client loads the live model). NEVER throws.
 *
 * `nowMs` is injected (the adapter reads no clock). Runs are scoped to `project.slug`
 * and emitted with `ref.projectPath = project.projectPath` (grouped with the project's
 * finalized runs); `startTime` carries the journal mtime as a best-effort "last active".
 */
export async function discoverRunningRunsReport(
  port: RunningDetectPort,
  claudeHome: string,
  project: ProjectRef,
  nowMs: number,
): Promise<DiscoveryReport<RunSummary>> {
  const reasons: DiscoveryReport<unknown>['reasons'] = [];
  const items: RunSummary[] = [];
  const slugPath = join(claudeHome, 'projects', project.slug);

  let sessionDirs: Array<{ name: string; isDir: boolean }>;
  try {
    sessionDirs = await port.listDir(slugPath);
  } catch {
    reasons.push({ code: 'slug-dir-unreadable', detail: project.slug });
    return { items, reasons };
  }

  for (const sessionEntry of sessionDirs) {
    if (!sessionEntry.isDir) continue;
    const sessionId = sessionEntry.name;
    const liveWfDir = join(slugPath, sessionId, 'subagents', 'workflows');

    let runDirs: Array<{ name: string; isDir: boolean }>;
    try {
      runDirs = await port.listDir(liveWfDir);
    } catch {
      continue; // no live journals for this session is normal.
    }

    for (const rd of runDirs) {
      if (!rd.isDir || !/^wf_.+/.test(rd.name)) continue;
      const runId = rd.name;
      const journalPath = join(liveWfDir, runId, 'journal.jsonl');
      const finalizedPath = join(slugPath, sessionId, 'workflows', `${runId}.json`);

      const st = await port.stat(journalPath);
      if (st === null) continue; // no journal file in this run dir.
      const finalizedExists = await port.exists(finalizedPath);

      const liveness = classifyRunLiveness({
        journalExists: true,
        finalizedExists,
        journalMtimeMs: st.mtimeMs,
        nowMs,
      });
      if (liveness !== 'running') continue;

      const ref: RunRef = { projectPath: project.projectPath, slug: project.slug, sessionId, runId };
      items.push({
        ref,
        workflowName: '',
        status: 'running',
        agentCount: 0,
        durationMs: null,
        startTime: st.mtimeMs, // best-effort "last active"; true startTime lands at finalize.
        summary: 'running…',
        partialFailure: false,
      });
    }
  }

  items.sort((a, b) => (b.startTime ?? -Infinity) - (a.startTime ?? -Infinity));
  return { items, reasons };
}

// --- static workflow listing (`export const meta = {...}`) ------------------

/**
 * Parse the `export const meta = {...}` object literal out of a
 * `<project>/.claude/workflows/*.js` source. Tolerant: a file without a parseable
 * `meta` (or any error) yields `null` — NEVER a crash. We do NOT execute the script;
 * we extract the balanced object literal and evaluate ONLY that literal in a Function
 * sandbox (no access to globals/agent/phase/log). Unknown/extra fields are ignored.
 */
export function parseWorkflowMeta(src: string, file = ''): WorkflowMeta | null {
  try {
    const start = src.search(/export\s+const\s+meta\s*=\s*\{/);
    if (start < 0) return null;
    const braceStart = src.indexOf('{', start);
    if (braceStart < 0) return null;

    // Extract the balanced { ... } literal (ignoring braces inside strings).
    const literal = extractBalanced(src, braceStart);
    if (literal === null) return null;

    // Evaluate ONLY the object literal in an isolated function with no arguments.
    // The literal is data (string/array/object); no workflow globals are in scope.
    const value = new Function(`"use strict"; return (${literal});`)() as unknown;
    if (!value || typeof value !== 'object') return null;
    const m = value as Record<string, unknown>;

    const name = typeof m.name === 'string' ? m.name : null;
    if (name === null) return null; // a meta object with no name isn't usable

    const description = typeof m.description === 'string' ? m.description : '';
    const whenToUse = typeof m.whenToUse === 'string' ? m.whenToUse : null;
    const model = typeof m.model === 'string' ? m.model : null;

    const phases: WorkflowMeta['phases'] = Array.isArray(m.phases)
      ? m.phases
          .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
          .map((p) => ({
            title: typeof p.title === 'string' ? p.title : '',
            detail: typeof p.detail === 'string' ? p.detail : null,
          }))
      : [];

    return { file: file ? basename(file) : '', name, description, whenToUse, phases, model };
  } catch {
    return null;
  }
}

/**
 * Return the balanced { ... } substring starting at `open` (an index of '{'),
 * ignoring braces inside strings. Reused by plan.ts to precisely locate+remove the
 * meta literal (the single source of brace-balancing — no second weaker regex).
 */
export function extractBalanced(src: string, open: number): string | null {
  let depth = 0;
  let inStr: string | null = null;
  let escaped = false;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i]!;
    if (inStr) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === inStr) {
        inStr = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null; // unbalanced
}

/**
 * List the static workflow definitions under `<projectPath>/.claude/workflows/*.js`.
 * Unparseable files yield `null` and are dropped (with a coded reason). A missing
 * `.claude/workflows` dir returns empty-with-reason. NEVER throws.
 */
export async function discoverWorkflowMetasReport(
  port: DiscoveryPort,
  projectPath: string,
): Promise<DiscoveryReport<WorkflowMeta>> {
  const reasons: DiscoveryReport<unknown>['reasons'] = [];
  const wfDir = join(projectPath, '.claude', 'workflows');

  let entries: Array<{ name: string; isDir: boolean }>;
  try {
    entries = await port.listDir(wfDir);
  } catch {
    reasons.push({ code: 'workflows-dir-unreadable' });
    return { items: [], reasons };
  }

  const items: WorkflowMeta[] = [];
  for (const e of entries) {
    if (e.isDir) continue;
    if (!e.name.endsWith('.js')) continue;
    let src: string;
    try {
      src = await port.readFile(join(wfDir, e.name));
    } catch {
      reasons.push({ code: 'workflow-file-unreadable', detail: e.name });
      continue;
    }
    const meta = parseWorkflowMeta(src, e.name);
    if (meta === null) {
      reasons.push({ code: 'workflow-meta-unparseable', detail: e.name });
      continue;
    }
    items.push(meta);
  }

  items.sort((a, b) => a.name.localeCompare(b.name));
  return { items, reasons };
}
