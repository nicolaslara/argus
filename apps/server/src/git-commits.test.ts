import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import type { NarrativeBlock } from '@argus/contract';
import {
  parseGitLog,
  correlateCommits,
  isValidShortSha,
  sanitizeSubject,
  parseGithubRemote,
  buildGithubCommitUrl,
  toCommitRef,
  defaultGitLogReader,
  defaultGitRemoteReader,
  MAX_COMMITS_PER_BLOCK,
  MAX_SUBJECT_LEN,
  type RawCommit,
} from './git-commits.ts';

// M2 git-commit linkage unit test. Pure parsing / correlation / security (no real git). The headline
// acceptance case is the POISONED-REMOTE set — a foreign or spoofed host must yield githubUrl null.

const US = '\x1f'; // field separator (git %x1f)
const RS = '\x1e'; // record separator (git %x1e)

/** Build a strict --pretty record exactly as git emits it (newline-prefixed, separator-joined). */
function rec(sha: string, iso: string, subject: string): string {
  return `${sha}${US}${iso}${US}${subject}${RS}`;
}

// --- parseGitLog ------------------------------------------------------------

describe('parseGitLog (strict %x1f/%x1e format, defensive)', () => {
  it('parses well-formed records into sha / authorIso / subject', () => {
    const stdout =
      rec('a'.repeat(40), '2026-06-08T10:00:00+00:00', 'feat: wire M2 git linkage') +
      '\n' +
      rec('b'.repeat(40), '2026-06-08T11:30:00+02:00', 'fix: bound the log');
    const commits = parseGitLog(stdout);
    expect(commits).toHaveLength(2);
    expect(commits[0]!.sha).toBe('a'.repeat(40));
    expect(commits[0]!.subject).toBe('feat: wire M2 git linkage');
    expect(commits[0]!.authorIso).toBe('2026-06-08T10:00:00.000Z');
    // a +02:00 offset normalizes to UTC.
    expect(commits[1]!.authorIso).toBe('2026-06-08T09:30:00.000Z');
  });

  it('handles a MULTILINE / odd subject (the separator never appears inside the subject)', () => {
    const weird = 'fix: handle\nan embedded newline and a : colon and "quotes"';
    const stdout = rec('c'.repeat(40), '2026-06-08T10:00:00Z', weird);
    const commits = parseGitLog(stdout);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.subject).toBe(weird); // raw subject preserved at parse time (sanitized later)
  });

  it('SKIPS malformed records (wrong field count / empty sha) and never throws', () => {
    const stdout =
      'no-separators-at-all-just-garbage' +
      RS +
      '\n' +
      `${'d'.repeat(40)}${US}only-one-separator` + // missing 2nd field sep → skipped
      RS +
      '\n' +
      `${US}2026-06-08T10:00:00Z${US}subject-with-empty-sha` + // empty sha → skipped
      RS +
      '\n' +
      rec('e'.repeat(40), '2026-06-08T12:00:00Z', 'good one'); // the only valid record
    const commits = parseGitLog(stdout);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.sha).toBe('e'.repeat(40));
  });

  it('returns [] for empty / non-string input (never throws)', () => {
    expect(parseGitLog('')).toEqual([]);
    expect(parseGitLog(undefined as unknown as string)).toEqual([]);
    expect(parseGitLog('\n\n')).toEqual([]);
  });

  it('keeps an unparseable date as authorIso null but still parses the record', () => {
    const stdout = rec('f'.repeat(40), 'not-a-date', 'subject');
    const commits = parseGitLog(stdout);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.authorIso).toBeNull();
  });
});

// --- shortSha validation ----------------------------------------------------

describe('isValidShortSha (/^[0-9a-f]{7,40}$/)', () => {
  it('accepts 7..40 lowercase hex', () => {
    expect(isValidShortSha('abc1234')).toBe(true); // 7
    expect(isValidShortSha('a'.repeat(40))).toBe(true); // 40
    expect(isValidShortSha('0123456789abcdef')).toBe(true);
  });
  it('rejects non-hex, wrong length, or uppercase', () => {
    expect(isValidShortSha('abc123')).toBe(false); // 6 — too short
    expect(isValidShortSha('a'.repeat(41))).toBe(false); // 41 — too long
    expect(isValidShortSha('ABC1234')).toBe(false); // uppercase
    expect(isValidShortSha('xyz1234')).toBe(false); // non-hex letters
    expect(isValidShortSha('abc 123')).toBe(false); // whitespace
    expect(isValidShortSha('abc123g')).toBe(false); // g is not hex
    expect(isValidShortSha('')).toBe(false);
    expect(isValidShortSha('../../etc')).toBe(false);
  });
});

// --- sanitizeSubject --------------------------------------------------------

describe('sanitizeSubject (TEXT-node defense in depth)', () => {
  it('strips control chars (incl. the field/record separators) + collapses whitespace', () => {
    expect(sanitizeSubject(`a${US}b${RS}c\t d`)).toBe('a b c d');
    expect(sanitizeSubject('line1\nline2')).toBe('line1 line2');
  });
  it('caps an over-long subject with an ellipsis', () => {
    const long = 'x'.repeat(MAX_SUBJECT_LEN + 50);
    const out = sanitizeSubject(long);
    expect(out.length).toBe(MAX_SUBJECT_LEN);
    expect(out.endsWith('…')).toBe(true);
  });
  it('leaves a normal subject intact', () => {
    expect(sanitizeSubject('feat: add the thing')).toBe('feat: add the thing');
  });
});

// --- buildGithubCommitUrl / parseGithubRemote (the HEADLINE security case) --

describe('buildGithubCommitUrl + parseGithubRemote (host-locked to github.com)', () => {
  const SHA = 'a'.repeat(40);

  it('builds /commit/<sha> from the SCP form git@github.com:o/r.git', () => {
    expect(buildGithubCommitUrl(SHA, 'git@github.com:nicolaslara/argus.git')).toBe(
      `https://github.com/nicolaslara/argus/commit/${SHA}`,
    );
  });

  it('builds /commit/<sha> from the https form https://github.com/o/r(.git)', () => {
    expect(buildGithubCommitUrl(SHA, 'https://github.com/nicolaslara/argus')).toBe(
      `https://github.com/nicolaslara/argus/commit/${SHA}`,
    );
    expect(buildGithubCommitUrl(SHA, 'https://github.com/nicolaslara/argus.git')).toBe(
      `https://github.com/nicolaslara/argus/commit/${SHA}`,
    );
  });

  it('builds /commit/<sha> from the ssh:// form', () => {
    expect(buildGithubCommitUrl(SHA, 'ssh://git@github.com/nicolaslara/argus.git')).toBe(
      `https://github.com/nicolaslara/argus/commit/${SHA}`,
    );
  });

  it('POISONED REMOTES yield NO foreign-host link (githubUrl null)', () => {
    // A plain foreign host.
    expect(buildGithubCommitUrl(SHA, 'https://evil.com/o/r')).toBeNull();
    // A subdomain-suffix spoof — github.com.evil.com is NOT github.com.
    expect(buildGithubCommitUrl(SHA, 'https://github.com.evil.com/o/r')).toBeNull();
    // A userinfo-embedded `@` — the real host is evil.com.
    expect(buildGithubCommitUrl(SHA, 'https://github.com@evil.com/o/r')).toBeNull();
    expect(buildGithubCommitUrl(SHA, 'https://user@github.com.evil.com/o/r')).toBeNull();
    // A javascript: scheme — no host, never a link.
    expect(buildGithubCommitUrl(SHA, 'javascript:alert(1)//github.com/o/r')).toBeNull();
    // An SCP form to a foreign host.
    expect(buildGithubCommitUrl(SHA, 'git@evil.com:o/r.git')).toBeNull();
    // An SCP form whose host has an extra label.
    expect(buildGithubCommitUrl(SHA, 'git@github.com.evil.com:o/r.git')).toBeNull();
    // A bare prefix-collision host.
    expect(buildGithubCommitUrl(SHA, 'https://notgithub.com/o/r')).toBeNull();
    // Empty / null remote.
    expect(buildGithubCommitUrl(SHA, null)).toBeNull();
    expect(buildGithubCommitUrl(SHA, '')).toBeNull();
  });

  it('returns null when the SHA is invalid even for a real github remote', () => {
    expect(buildGithubCommitUrl('NOTHEX', 'https://github.com/o/r')).toBeNull();
    expect(buildGithubCommitUrl('abc', 'git@github.com:o/r.git')).toBeNull(); // too short
  });

  it('parseGithubRemote rejects an owner/repo whose segment fails the leading-alnum charset', () => {
    // A `..` owner fails the leading-alnum anchor of GH_SEGMENT_RE → rejected (no link).
    expect(parseGithubRemote('https://github.com/..%2f/x')).toBeNull();
    expect(parseGithubRemote('https://github.com/.hidden/repo')).toBeNull();
    expect(parseGithubRemote('https://github.com//')).toBeNull(); // empty owner
    expect(parseGithubRemote('https://github.com/onlyowner')).toBeNull(); // no repo segment
    // A normal owner/repo passes.
    expect(parseGithubRemote('https://github.com/owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
  });
});

// --- toCommitRef ------------------------------------------------------------

describe('toCommitRef', () => {
  it('projects a valid commit + github remote onto the wire shape', () => {
    const ref = toCommitRef(
      { sha: 'a'.repeat(40), subject: 'feat: x', authorIso: '2026-06-08T10:00:00.000Z' },
      'git@github.com:o/r.git',
    )!;
    expect(ref.shortSha).toBe('a'.repeat(40));
    expect(ref.subject).toBe('feat: x');
    expect(ref.githubUrl).toBe(`https://github.com/o/r/commit/${'a'.repeat(40)}`);
    expect(ref.subsystems).toBeNull(); // M2 leaves subsystems null
  });
  it('returns null for an invalid sha (never emit an untrusted chip)', () => {
    expect(toCommitRef({ sha: 'ZZZ', subject: 's', authorIso: null }, null)).toBeNull();
  });
  it('emits a chip with githubUrl null for a non-github remote (still a valid commit)', () => {
    const ref = toCommitRef(
      { sha: 'b'.repeat(40), subject: 's', authorIso: null },
      'https://gitlab.com/o/r',
    )!;
    expect(ref.shortSha).toBe('b'.repeat(40));
    expect(ref.githubUrl).toBeNull();
  });
});

// --- correlateCommits (author-time windows, deterministic, boundaries) ------

/** A minimal NarrativeBlock with a time window (the only fields correlation reads). */
function block(id: string, start: string | null, end: string | null): NarrativeBlock {
  return {
    id,
    recordRange: { start: 0, end: 1 },
    timeRange: { start, end },
    topicLabel: null,
    cutReason: 'prompt',
    turnCount: 1,
    toolCounts: {},
    asks: [],
    workflowSpawns: [],
    gitCommits: [],
    filesTouched: [],
    promptPreview: { text: 'p', truncated: false },
    responsePreview: { text: 'r', truncated: false },
    summary: null,
  };
}

function commit(sha: string, iso: string | null): RawCommit {
  return { sha, subject: `subj ${sha.slice(0, 4)}`, authorIso: iso };
}

describe('correlateCommits (assign by author-time window)', () => {
  const A = block('A', '2026-06-08T10:00:00.000Z', '2026-06-08T11:00:00.000Z');
  const B = block('B', '2026-06-08T11:00:01.000Z', '2026-06-08T12:00:00.000Z');
  const blocks = [A, B];

  it('places a commit inside block B into B.gitCommits', () => {
    const out = correlateCommits(blocks, [commit('a'.repeat(40), '2026-06-08T11:30:00.000Z')]);
    expect(out[0]!.gitCommits).toHaveLength(0);
    expect(out[1]!.gitCommits).toHaveLength(1);
    expect(out[1]!.gitCommits[0]!.shortSha).toBe('a'.repeat(40));
  });

  it('DROPS a commit outside every block window (no force-fit)', () => {
    const before = commit('a'.repeat(40), '2026-06-08T09:00:00.000Z'); // before A
    const after = commit('b'.repeat(40), '2026-06-08T13:00:00.000Z'); // after B
    const out = correlateCommits(blocks, [before, after]);
    expect(out[0]!.gitCommits).toHaveLength(0);
    expect(out[1]!.gitCommits).toHaveLength(0);
  });

  it('handles boundary timestamps == start and == end (inclusive)', () => {
    const atStart = commit('a'.repeat(40), '2026-06-08T10:00:00.000Z'); // == A.start
    const atEnd = commit('b'.repeat(40), '2026-06-08T11:00:00.000Z'); // == A.end
    const out = correlateCommits(blocks, [atStart, atEnd]);
    expect(out[0]!.gitCommits.map((c) => c.shortSha)).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
    expect(out[1]!.gitCommits).toHaveLength(0);
  });

  it('is deterministic (same input → same buckets) and does NOT mutate the input blocks', () => {
    const commits = [
      commit('a'.repeat(40), '2026-06-08T10:30:00.000Z'),
      commit('b'.repeat(40), '2026-06-08T11:30:00.000Z'),
    ];
    const out1 = correlateCommits(blocks, commits);
    const out2 = correlateCommits(blocks, commits);
    expect(JSON.stringify(out1)).toBe(JSON.stringify(out2));
    // input blocks are untouched (gitCommits still [])
    expect(A.gitCommits).toHaveLength(0);
    expect(B.gitCommits).toHaveLength(0);
  });

  it('drops a commit with no author-time and one with an invalid sha', () => {
    const out = correlateCommits(blocks, [
      commit('a'.repeat(40), null), // no time → dropped
      { sha: 'NOTHEX', subject: 's', authorIso: '2026-06-08T10:30:00.000Z' }, // bad sha → dropped
      commit('c'.repeat(40), '2026-06-08T10:30:00.000Z'), // good
    ]);
    expect(out[0]!.gitCommits.map((c) => c.shortSha)).toEqual(['c'.repeat(40)]);
  });

  it('skips a block with a null time bound', () => {
    const open = [block('A', null, '2026-06-08T11:00:00.000Z'), block('B', '2026-06-08T11:00:01.000Z', '2026-06-08T12:00:00.000Z')];
    const out = correlateCommits(open, [commit('a'.repeat(40), '2026-06-08T10:30:00.000Z')]);
    expect(out[0]!.gitCommits).toHaveLength(0); // A has a null start → can't contain anything
  });

  it('caps per-block commits at MAX_COMMITS_PER_BLOCK', () => {
    const many: RawCommit[] = [];
    for (let i = 0; i < MAX_COMMITS_PER_BLOCK + 10; i += 1) {
      // distinct valid 40-hex shas, all inside A
      const sha = (i.toString(16).padStart(2, '0') + 'a'.repeat(38)).slice(0, 40);
      many.push(commit(sha, '2026-06-08T10:30:00.000Z'));
    }
    const out = correlateCommits(blocks, many);
    expect(out[0]!.gitCommits.length).toBe(MAX_COMMITS_PER_BLOCK);
  });

  it('returns [] for an empty block list', () => {
    expect(correlateCommits([], [commit('a'.repeat(40), '2026-06-08T10:30:00.000Z')])).toEqual([]);
  });

  it('threads the remote into the github URL of correlated commits', () => {
    const out = correlateCommits(
      blocks,
      [commit('a'.repeat(40), '2026-06-08T10:30:00.000Z')],
      'git@github.com:o/r.git',
    );
    expect(out[0]!.gitCommits[0]!.githubUrl).toBe(`https://github.com/o/r/commit/${'a'.repeat(40)}`);
  });
});

// --- default readers degrade (no real git) ----------------------------------

/**
 * A fake `spawn` that drives the runGit state machine: `mode` decides whether the child errors
 * (git absent / ENOENT), exits non-zero (not-a-repo), or exits 0 with the given stdout.
 */
function fakeSpawn(
  mode: 'error' | 'nonzero' | 'ok',
  stdout = '',
): typeof spawn {
  return ((_cmd: string, _args: readonly string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.kill = () => {};
    // Defer the events so the caller can attach listeners first (like a real async child).
    queueMicrotask(() => {
      if (mode === 'error') {
        child.emit('error', new Error('spawn git ENOENT'));
        return;
      }
      if (stdout) child.stdout.emit('data', Buffer.from(stdout, 'utf8'));
      child.emit('close', mode === 'ok' ? 0 : 128);
    });
    return child as unknown as ReturnType<typeof spawn>;
  }) as unknown as typeof spawn;
}

describe('defaultGitLogReader / defaultGitRemoteReader degrade (never throw)', () => {
  it('git absent (spawn error / ENOENT) → [] / null', async () => {
    const log = defaultGitLogReader(fakeSpawn('error'));
    const remote = defaultGitRemoteReader(fakeSpawn('error'));
    expect(await log('/some/repo')).toEqual([]);
    expect(await remote('/some/repo')).toBeNull();
  });

  it('not-a-git-repo (non-zero exit) → [] / null', async () => {
    const log = defaultGitLogReader(fakeSpawn('nonzero'));
    const remote = defaultGitRemoteReader(fakeSpawn('nonzero'));
    expect(await log('/not/a/repo')).toEqual([]);
    expect(await remote('/not/a/repo')).toBeNull();
  });

  it('a real-shaped log (exit 0) parses; a real-shaped remote trims', async () => {
    const stdout = rec('a'.repeat(40), '2026-06-08T10:00:00Z', 'feat: ok');
    const log = defaultGitLogReader(fakeSpawn('ok', stdout));
    const remote = defaultGitRemoteReader(fakeSpawn('ok', '  git@github.com:o/r.git\n'));
    const commits = await log('/repo', { timeRange: { start: '2026-06-08T09:00:00Z', end: null } });
    expect(commits).toHaveLength(1);
    expect(commits[0]!.subject).toBe('feat: ok');
    expect(await remote('/repo')).toBe('git@github.com:o/r.git');
  });

  it('an empty projectPath short-circuits to [] / null (no spawn attempted)', async () => {
    let spawned = false;
    const spy = (() => {
      spawned = true;
      throw new Error('should not spawn');
    }) as unknown as typeof spawn;
    expect(await defaultGitLogReader(spy)('')).toEqual([]);
    expect(await defaultGitRemoteReader(spy)('   ')).toBeNull();
    expect(spawned).toBe(false);
  });
});
