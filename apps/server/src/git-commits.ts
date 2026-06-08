// @argus/server — M2 git-commit linkage. Correlate the REPO's real `git log` to a session's
// narrative blocks by author-time, filling each block's `gitCommits`. This is a SERVER concern:
// the adapter is FileSystemPort-only / format-aware-only and must NEVER spawn a process — so all
// `git` reading lives here (mirrors llm/runner.ts's injected, never-throwing process-spawn idiom).
//
// ARCHITECTURE (workpads/narrative/tasks.md §M2, locked):
//   - The readers (`GitLogReader` / `GitRemoteReader`) are INJECTED + testable (default impls
//     spawn `git -C <projectPath> …`). Both NEVER throw and DEGRADE: not-a-repo / git-absent /
//     any error → [] / null. The log is BOUNDED (`--max-count` + a `--since` from the session
//     timeRange) so we never read unbounded history.
//   - CORRELATION (`correlateCommits`) is a cheap, PURE, deterministic POST-step on the (cached or
//     fresh) narrative — it is NOT baked into the stat-keyed disk cache (commits are live; the
//     cache is for segmentation). Each commit lands in the block whose timeRange [start,end]
//     contains its author-time; a commit outside every block is DROPPED (never force-fit).
//   - SECURITY (the whole point of the milestone): shortSha is validated /^[0-9a-f]{7,40}$/;
//     `githubUrl` is built ONLY from a remote whose host is EXACTLY github.com (no free-form
//     concatenation of an untrusted remote); `subject` is capped + control-char-stripped (it is a
//     TEXT node downstream); commits are bounded per block and in total.
//   - READ-ONLY toward the repo: only `git log` / `git remote get-url` — NEVER a mutating command.
//   - Nothing here logs a prompt / commit body (boundaries.md §4).

import { spawn } from 'node:child_process';
import type { GitCommitRef, NarrativeBlock, TimeRange } from '@argus/contract';

/** A raw, parsed commit from `git log` (server-internal; not the wire shape). */
export interface RawCommit {
  /** The full or abbreviated commit hash (validated /^[0-9a-f]{7,40}$/ before use). */
  sha: string;
  /** The commit subject (first line); capped + control-stripped before it reaches the wire. */
  subject: string;
  /** The author timestamp as an ISO-8601 string (git %aI), or null when unparseable. */
  authorIso: string | null;
}

/** Reads the repo's `git log` for a project path. NEVER throws; degrades to [] on any error. */
export type GitLogReader = (projectPath: string, opts?: GitLogOptions) => Promise<RawCommit[]>;

/** Reads `git remote get-url origin` for a project path. NEVER throws; degrades to null. */
export type GitRemoteReader = (projectPath: string) => Promise<string | null>;

/** A small git-reading engine (mirrors the optional deps.narrativeSummary shape). */
export interface GitCommitEngine {
  log: GitLogReader;
  remote: GitRemoteReader;
}

/** Bounds on the git log read so a deep history never costs an unbounded scan. */
export interface GitLogOptions {
  /** The session timeRange — drives a `--since` (start minus slack) so we read only the window. */
  timeRange?: TimeRange;
}

// --- bounds (load-bearing; keep small) -------------------------------------

/** Hard cap on `git log --max-count` — a sane ceiling so a huge history never floods. */
export const GIT_LOG_MAX_COUNT = 500;
/** Slack subtracted from the session start for `--since` (a commit may land just before a prompt). */
export const GIT_SINCE_SLACK_MS = 60 * 60 * 1000; // 1 hour
/** Per-block commit cap (the wire stays small; a pathological window can't flood one card). */
export const MAX_COMMITS_PER_BLOCK = 50;
/** Total commit cap across a narrative (defense-in-depth on the whole correlation). */
export const MAX_COMMITS_TOTAL = 500;
/** Subject length cap (it's a TEXT node downstream; long subjects are sliced + ellipsised). */
export const MAX_SUBJECT_LEN = 200;
/** Hard cap on the `git log` stdout we buffer (a runaway repo can't OOM the read). */
const GIT_STDOUT_CAP = 8 * 1024 * 1024;
/** Hard timeout on a single git invocation; a hung child is killed and we degrade. */
export const GIT_TIMEOUT_MS = 10_000;

// --- the strict --pretty format (collision-resistant separators) -----------
//
// Fields are separated by US (unit separator, U+001F) and records by RS (record separator, U+001E).
// These bytes never appear in a commit subject / sha / date, so a defensive split is robust even
// against multiline subjects. git's `--pretty=format:` understands %x1f / %x1e as literal-byte
// escapes, so we ask git to emit the exact separators we split on (no literal control bytes here).
const FIELD_SEP = '\x1f';
const RECORD_SEP = '\x1e';
const PRETTY_FORMAT = '%H%x1f%aI%x1f%s%x1e';

/** shortSha MUST validate as 7–40 lowercase hex chars; anything else is rejected (no link, no chip). */
export const SHORT_SHA_RE = /^[0-9a-f]{7,40}$/;

export function isValidShortSha(sha: string): boolean {
  return SHORT_SHA_RE.test(sha);
}

/**
 * Cap + sanitize a commit subject for the wire. It renders as a TEXT node downstream, so this is a
 * defense-in-depth bound (length + control chars), NOT an escape: strip C0/C1 control chars (incl.
 * the field/record separators), collapse internal whitespace, and cap to {@link MAX_SUBJECT_LEN}.
 */
export function sanitizeSubject(subject: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = subject.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (stripped.length <= MAX_SUBJECT_LEN) return stripped;
  return stripped.slice(0, MAX_SUBJECT_LEN - 1) + '…';
}

/**
 * Parse the strict `--pretty` output into RawCommit[]. Splits on the record separator, then each
 * record on the field separator. A malformed record (wrong field count, empty sha) is SKIPPED, never
 * thrown. Handles multiline / odd subjects (the subject is everything after the 2nd field separator,
 * up to the record separator — a separator can never appear inside it). NEVER throws.
 */
export function parseGitLog(stdout: string): RawCommit[] {
  if (typeof stdout !== 'string' || stdout.length === 0) return [];
  const out: RawCommit[] = [];
  for (const recordRaw of stdout.split(RECORD_SEP)) {
    const record = recordRaw.replace(/^\r?\n/, ''); // git emits a newline between records
    if (record.trim() === '') continue;
    // Split into AT MOST 3 fields so a stray separator never corrupts a later one; the subject is
    // the remainder (it can carry newlines but never a FIELD_SEP/RECORD_SEP).
    const firstSep = record.indexOf(FIELD_SEP);
    if (firstSep === -1) continue;
    const secondSep = record.indexOf(FIELD_SEP, firstSep + 1);
    if (secondSep === -1) continue;
    const sha = record.slice(0, firstSep).trim();
    const authorRaw = record.slice(firstSep + 1, secondSep).trim();
    const subject = record.slice(secondSep + 1);
    if (sha === '') continue; // a record with no sha is unusable → skip
    const authorIso = normalizeIso(authorRaw);
    out.push({ sha, subject, authorIso });
  }
  return out;
}

/** Normalize a git %aI date to a canonical ISO string, or null when unparseable. NEVER throws. */
function normalizeIso(raw: string): string | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

// --- the GitHub URL builder (the headline security case) -------------------

/** A parsed github.com owner/repo, when (and only when) the host is EXACTLY github.com. */
interface GithubOwnerRepo {
  owner: string;
  repo: string;
}

/** Owner / repo path segments are conservative: a leading alnum then alnum/dot/dash/underscore. */
const GH_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Parse a git remote into a github.com {owner, repo} ONLY when the host is EXACTLY `github.com`.
 * Handles the two real remote shapes:
 *   - SCP/SSH:  git@github.com:owner/repo.git
 *   - HTTP(S):  https://github.com/owner/repo(.git)
 * ANY other host (evil.com, github.com.evil.com, a userinfo-embedded `@`, a non-github host, a
 * `javascript:` scheme, …) → null. We never free-form-concatenate the raw remote into a URL — the
 * host is matched EXACTLY, parsed via the URL API (https form) or a strict anchored regex (scp form).
 * NEVER throws.
 */
export function parseGithubRemote(remote: string | null): GithubOwnerRepo | null {
  if (typeof remote !== 'string') return null;
  const trimmed = remote.trim();
  if (trimmed === '') return null;

  // 1) SCP-like SSH shape: git@github.com:owner/repo(.git). The host between `@` and `:` must be
  //    EXACTLY github.com (an anchored match — no userinfo trickery, no extra labels). A `git@`
  //    that is actually a URL userinfo (https://github.com@evil.com) does NOT match this anchor
  //    (it has a `//` and no `:` directly after the host) and falls through to the URL parser,
  //    which reads its hostname as evil.com and rejects it.
  const scp = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(trimmed);
  if (scp) {
    return validOwnerRepo(scp[1]!, scp[2]!);
  }

  // 2) URL shape (https / http / ssh): parse with the URL API and require hostname === 'github.com'.
  //    `url.hostname` is the bare host (no port, no userinfo), so an embedded `@` or a port can
  //    NEVER spoof it — `https://github.com.evil.com/…`.hostname is `github.com.evil.com` (rejected),
  //    and `https://github.com@evil.com/…`.hostname is `evil.com` (rejected). A `javascript:` URL
  //    has no hostname (rejected), and only http/https/ssh schemes are accepted.
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null; // not a parseable URL and not the scp shape → no link
  }
  if (url.hostname !== 'github.com') return null;
  if (url.protocol !== 'https:' && url.protocol !== 'http:' && url.protocol !== 'ssh:') return null;
  const parts = url.pathname.replace(/^\/+/, '').split('/');
  if (parts.length < 2) return null;
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/, '');
  return validOwnerRepo(owner, repo);
}

/** Validate owner + repo against the conservative segment charset, or null. */
function validOwnerRepo(owner: string, repo: string): GithubOwnerRepo | null {
  const o = owner.trim();
  const r = repo.trim().replace(/\.git$/, '');
  if (!GH_SEGMENT_RE.test(o) || !GH_SEGMENT_RE.test(r)) return null;
  return { owner: o, repo: r };
}

/**
 * Build the GitHub commit URL for a VALIDATED sha + a parsed github.com remote, or null. The shape is
 * FIXED: https://github.com/<owner>/<repo>/commit/<validatedSha>. Returns null when the sha is invalid
 * OR the remote is not a github.com remote (a poisoned/foreign remote yields NO link). NEVER throws.
 */
export function buildGithubCommitUrl(sha: string, remote: string | null): string | null {
  if (!isValidShortSha(sha)) return null;
  const gh = parseGithubRemote(remote);
  if (gh === null) return null;
  return `https://github.com/${gh.owner}/${gh.repo}/commit/${sha}`;
}

/**
 * Project a RawCommit + the (validated) remote onto the wire {@link GitCommitRef}, or null when the
 * sha fails validation (we never emit a chip we can't trust). `githubUrl` is built ONLY from the
 * fixed github.com host; `subject` is capped + control-stripped; `subsystems` is left null in M2.
 */
export function toCommitRef(commit: RawCommit, remote: string | null): GitCommitRef | null {
  if (!isValidShortSha(commit.sha)) return null;
  return {
    shortSha: commit.sha,
    subject: sanitizeSubject(commit.subject),
    timestamp: commit.authorIso,
    githubUrl: buildGithubCommitUrl(commit.sha, remote),
    subsystems: null, // OPTIONAL in M2 — left null (the contract allows it).
  };
}

// --- correlation (pure, deterministic, O(n+m)) -----------------------------

/** Parse an ISO timestamp to epoch ms, or null. */
function isoMs(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Assign each commit to the block whose timeRange [start,end] CONTAINS the commit's author-time
 * (inclusive on both ends), and emit a NEW blocks array with `gitCommits` filled. Deterministic +
 * pure + O(n+m): blocks are scanned in order; a commit lands in the FIRST block that contains it
 * (blocks are time-ordered + non-overlapping in practice, so "first containing" is unambiguous). A
 * commit outside every block's window is DROPPED (never force-fit). Commits with no author-time, an
 * invalid sha, or a block with a null start/end bound are skipped for that pairing. Per-block and
 * total caps bound the wire. NEVER throws; never mutates the input blocks.
 */
export function correlateCommits(
  blocks: NarrativeBlock[],
  commits: RawCommit[],
  remote: string | null = null,
): NarrativeBlock[] {
  // Always return a fresh array with gitCommits reset (so a re-correlate is idempotent and never
  // mutates the caller's blocks).
  if (blocks.length === 0) return [];

  // Pre-project each block's [start,end] window once (O(n)).
  const windows = blocks.map((b) => ({
    start: isoMs(b.timeRange.start),
    end: isoMs(b.timeRange.end),
  }));
  const buckets: GitCommitRef[][] = blocks.map(() => []);

  let total = 0;
  for (const commit of commits) {
    if (total >= MAX_COMMITS_TOTAL) break;
    const at = isoMs(commit.authorIso);
    if (at === null) continue; // a commit with no author-time can't be placed → drop
    // Find the FIRST block whose window contains the author-time (inclusive bounds).
    let target = -1;
    for (let i = 0; i < windows.length; i += 1) {
      const w = windows[i]!;
      if (w.start === null || w.end === null) continue;
      if (at >= w.start && at <= w.end) {
        target = i;
        break;
      }
    }
    if (target === -1) continue; // outside every block → drop (no force-fit)
    if (buckets[target]!.length >= MAX_COMMITS_PER_BLOCK) continue; // this block is full
    const ref = toCommitRef(commit, remote);
    if (ref === null) continue; // invalid sha → never emitted
    buckets[target]!.push(ref);
    total += 1;
  }

  return blocks.map((b, i) => ({ ...b, gitCommits: buckets[i]! }));
}

// --- the default, process-spawning readers (NEVER throw; degrade) ----------

/**
 * Spawn a `git` subprocess (read-only) and resolve its stdout, or null on absent-git / non-zero /
 * timeout / any error. MIRRORS llm/runner.ts's defaultClaudeRunner: a single settle, a hard timeout
 * that SIGKILLs a hung child, a stdout cap, and an `error` handler that catches ENOENT (git absent).
 * stdin is closed immediately (git reads none). NEVER throws, NEVER leaves a hung child.
 */
function runGit(args: string[], spawnFn: typeof spawn): Promise<string | null> {
  return new Promise<string | null>((resolveResult) => {
    let settled = false;
    const done = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolveResult(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnFn('git', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      done(null); // `git` not spawnable at all → degrade
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      done(null);
    }, GIT_TIMEOUT_MS);

    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      if (out.length > GIT_STDOUT_CAP) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    });
    child.on('error', () => {
      clearTimeout(timer);
      done(null); // ENOENT (git absent) / not-a-repo spawn error lands here
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        done(null); // not-a-repo / any git error → degrade (no partial output trusted)
        return;
      }
      done(out);
    });
  });
}

/** Compute the `--since` argument from the session start (minus slack), or null when unknown. */
function sinceArg(timeRange: TimeRange | undefined): string | null {
  const startMs = isoMs(timeRange?.start ?? null);
  if (startMs === null) return null;
  return new Date(startMs - GIT_SINCE_SLACK_MS).toISOString();
}

/**
 * The default `git log` reader: `git -C <projectPath> log --max-count=N --no-color
 * --pretty=<strict> [--since=<iso>]`. BOUNDED (max-count + a since derived from the session window)
 * so we never read unbounded history. Read-only. NEVER throws — a not-a-repo / git-absent / error
 * resolves to []. The output is parsed defensively by {@link parseGitLog} (malformed records skipped).
 */
export function defaultGitLogReader(spawnFn: typeof spawn = spawn): GitLogReader {
  return async (projectPath: string, opts?: GitLogOptions): Promise<RawCommit[]> => {
    if (typeof projectPath !== 'string' || projectPath.trim() === '') return [];
    const args = [
      '-C',
      projectPath,
      'log',
      `--max-count=${GIT_LOG_MAX_COUNT}`,
      '--no-color',
      `--pretty=format:${PRETTY_FORMAT}`,
    ];
    const since = sinceArg(opts?.timeRange);
    if (since !== null) args.push(`--since=${since}`);
    const stdout = await runGit(args, spawnFn);
    if (stdout === null) return [];
    return parseGitLog(stdout);
  };
}

/**
 * The default `git remote get-url origin` reader. Returns the trimmed remote URL, or null on
 * absent-git / not-a-repo / no-origin / error. Read-only. NEVER throws. The host is validated
 * downstream by {@link parseGithubRemote} before any URL is built.
 */
export function defaultGitRemoteReader(spawnFn: typeof spawn = spawn): GitRemoteReader {
  return async (projectPath: string): Promise<string | null> => {
    if (typeof projectPath !== 'string' || projectPath.trim() === '') return null;
    const stdout = await runGit(['-C', projectPath, 'remote', 'get-url', 'origin'], spawnFn);
    if (stdout === null) return null;
    const trimmed = stdout.trim();
    return trimmed === '' ? null : trimmed;
  };
}

/** Construct the default git engine (the two process-spawning readers). Injected in index.ts. */
export function defaultGitCommitEngine(spawnFn: typeof spawn = spawn): GitCommitEngine {
  return {
    log: defaultGitLogReader(spawnFn),
    remote: defaultGitRemoteReader(spawnFn),
  };
}
