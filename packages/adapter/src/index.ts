// @argus/adapter — the ONLY module that knows the raw on-disk Claude Code workflow
// format. Everything downstream consumes @argus/contract types. Disk access goes
// through an injected FileSystemPort (no direct node:fs import) so this package can
// later run in a Tauri sidecar / browser / remote host. See boundaries.md §2.

import type { RunModel, RunSummary, ProjectRef, RunRef } from '@argus/contract';

/** Observed-format pin. The "tested on" client version (best-effort) is resolved lazily. */
export const ADAPTER_FORMAT = 'cc-workflow/observed-2026-06-04' as const;

/** Injected filesystem seam. The node implementation lives in apps/server. */
export interface FileSystemPort {
  readFile(path: string): Promise<string>;
  readJson(path: string): Promise<unknown>;
  listDir(path: string): Promise<Array<{ name: string; isDir: boolean }>>;
  stat(path: string): Promise<{ size: number; mtimeMs: number } | null>;
  exists(path: string): Promise<boolean>;
  /** Returns an unwatch function. The node impl is chokidar-backed. */
  watch(path: string, onEvent: (event: { path: string; type: string }) => void): () => void;
}

/**
 * Derive the on-disk project-slug from an absolute cwd: every non-alphanumeric
 * character becomes "-". Verified rule (boundaries.md §0):
 *   /Users/nicolas/devel/modal-rust   -> -Users-nicolas-devel-modal-rust
 *   /Users/nicolas/.config/ghostty    -> -Users-nicolas--config-ghostty
 * NOTE: lossy and collision-prone — use recoverProjectPath() for the authoritative key.
 */
export function deriveSlug(absCwd: string): string {
  return absCwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Recover the authoritative absolute project path from a run's persisted `scriptPath`
 * (e.g. /Users/nicolas/devel/modal-rust/.claude/workflows/plan-research.js ->
 * /Users/nicolas/devel/modal-rust). Strips the trailing `.claude/workflows/<file>`.
 * Returns null if the path doesn't contain that segment. No transcript I/O.
 */
export function recoverProjectPath(scriptPath: string): string | null {
  const m = scriptPath.split(/[/\\]\.claude[/\\]workflows[/\\]/);
  return m.length > 1 ? m[0]! : null;
}

// --- Parsing surface (implemented in prototype M1+; declared here as the contract). ---

export interface AdapterContext {
  ref: RunRef;
  clientVersion?: string;
}

/** Parse a finalized wf_*.json into the normalized RunModel. PURE. (M1) */
export function parseFinalizedRun(_raw: unknown, _ctx: AdapterContext): RunModel {
  throw new Error('parseFinalizedRun: not implemented until prototype M1');
}

/** Discover projects under a claude home. (M2) */
export function discoverProjects(_port: FileSystemPort, _claudeHome: string): Promise<ProjectRef[]> {
  throw new Error('discoverProjects: not implemented until prototype M2');
}

/** List a project's runs (header fields only; zero transcript I/O). (M2) */
export function discoverRuns(_port: FileSystemPort, _project: ProjectRef): Promise<RunSummary[]> {
  throw new Error('discoverRuns: not implemented until prototype M2');
}
