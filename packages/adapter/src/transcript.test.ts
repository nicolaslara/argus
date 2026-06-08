import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import {
  scanTranscript,
  projectText,
  isRealUserPrompt,
  extractWorkflowSpawns,
  boundedPreview,
  buildSessionNarrative,
  loadSessionNarrative,
  summarizeScannedSession,
  discoverSessions,
  loadBlockTurns,
  blockTurns,
  NARRATIVE_FORMAT_ENGINE,
  MAX_LINE_BYTES,
  RESPONSE_HEADTAIL,
  TURN_TEXT_HEADTAIL,
  resetRedactionStrategy,
  setRedactionStrategy,
  type FileSystemPort,
} from './index.ts';
import { NARRATIVE_FORMAT } from '@argus/contract';

// Session Narrative ENGINE tests (M0). Mirror live.test.ts's StatPort/MemPort fixture style.
// These pin the LOAD-BEARING parse + segmentation invariants from knowledge.md:
//   (a) a 256 KB+ line is SKIPPED with a coded warning (not a throw);
//   (b) a tool_result.content LIST with an embedded image projects ONLY text — ZERO image
//       bytes in any record/preview — and is counted;
//   (c) synthetic user records (isMeta / <command / Caveat / <task-notification> / [Request
//       interrupted / compaction summary / tool_result carrier) are filtered so they never start
//       a block, leak into a preview, inflate a turn count, or open an empty session-start shell;
//   (d) N real prompts → N blocks, each absorbing the following assistant work;
//   (e) a long response is bounded to head+tail in responsePreview;
//   (f) extractWorkflowSpawns finds a Workflow tool_use.
// Then a guarded REAL-DATA smoke parses the actual 67 MB transcript.

// A representative base64 PNG header that must NEVER survive into any preview/record.
const PNG_BYTES = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';

/** Build one JSONL line from a record object. */
const line = (o: unknown): string => JSON.stringify(o);

/** A real external user prompt record. */
const userPrompt = (text: string, ts: string, extra: Record<string, unknown> = {}): string =>
  line({
    type: 'user',
    userType: 'external',
    promptId: `p-${ts}`,
    timestamp: ts,
    cwd: '/Users/nicolas/devel/argus',
    message: { role: 'user', content: [{ type: 'text', text }] },
    ...extra,
  });

/** An assistant record with arbitrary content blocks. */
const assistant = (content: unknown[], ts: string): string =>
  line({
    type: 'assistant',
    timestamp: ts,
    promptId: `a-${ts}`,
    message: { role: 'assistant', content },
  });

/** A tool_result CARRIER user record (the 2,600 synthetic user records in the real data). */
const toolResultCarrier = (content: unknown, ts: string): string =>
  line({
    type: 'user',
    userType: 'external',
    timestamp: ts,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content }] },
  });

afterEach(() => resetRedactionStrategy());

// --- (a) over-cap line is skipped with a coded warning, never a throw -----------

describe('scanTranscript — 256 KB per-line cap (decision 5)', () => {
  it('SKIPS a 256 KB+ line BEFORE JSON.parse, emitting a coded warning (not a throw)', () => {
    // A real, well-formed JSON line whose byte length exceeds the cap (the 2 MB line analogue).
    const huge = userPrompt('x'.repeat(MAX_LINE_BYTES + 10), '2026-06-07T00:00:00Z');
    expect(huge.length).toBeGreaterThan(MAX_LINE_BYTES);
    const text = [userPrompt('small one', '2026-06-07T00:00:01Z'), huge].join('\n');

    let scanned!: ReturnType<typeof scanTranscript>;
    expect(() => {
      scanned = scanTranscript(text);
    }).not.toThrow();

    // Both lines are COUNTED; the over-cap one is not PARSED into a record.
    expect(scanned.totalLines).toBe(2);
    expect(scanned.records).toHaveLength(1);
    expect(projectText(scanned.records[0]!.content).text).toContain('small one');
    const w = scanned.warnings.find((x) => x.code === 'transcript-line-over-cap');
    expect(w).toBeDefined();
    expect(w!.detail).toBe('1');
    expect(scanned.incomplete).toBe(true);
  });

  it('a torn / non-JSON line is counted (transcript-bad-line), never fatal', () => {
    const text = [userPrompt('ok', '2026-06-07T00:00:00Z'), '{ not json', ''].join('\n');
    const scanned = scanTranscript(text);
    expect(scanned.records).toHaveLength(1);
    const w = scanned.warnings.find((x) => x.code === 'transcript-bad-line');
    expect(w?.detail).toBe('1');
  });

  it('an over-cap line never reaches JSON.parse: even malformed huge JSON does not throw', () => {
    const huge = '{"type":"user","junk":"' + 'y'.repeat(MAX_LINE_BYTES) + '\n';
    expect(() => scanTranscript(huge)).not.toThrow();
  });
});

// --- (b) tool_result list with an image → text only, ZERO image bytes -----------

describe('projectText — image/tool_reference allowlist (decision 2)', () => {
  it('projects ONLY {type:text}.text from a tool_result LIST; drops the image; counts both', () => {
    const content: unknown[] = [
      { type: 'text', text: 'Ran Playwright: screenshot captured' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_BYTES } },
      { type: 'tool_reference', id: 'ref-1' },
    ];
    // A tool_result block nesting that list (the real shape).
    const projected = projectText([{ type: 'tool_result', content }]);
    expect(projected.text).toBe('Ran Playwright: screenshot captured');
    expect(projected.text).not.toContain(PNG_BYTES);
    expect(projected.text).not.toContain('iVBOR');
    expect(projected.droppedImages).toBe(1);
    expect(projected.droppedOther).toBe(1); // the tool_reference
  });

  it('NO image bytes reach any NarrativeRecord/preview when a carrier holds an image', () => {
    const text = [
      userPrompt('look at the page', '2026-06-07T00:00:00Z'),
      assistant([{ type: 'tool_use', name: 'browser_take_screenshot', input: {} }], '2026-06-07T00:00:01Z'),
      toolResultCarrier(
        [
          { type: 'text', text: 'screenshot saved' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_BYTES } },
        ],
        '2026-06-07T00:00:02Z',
      ),
    ].join('\n');

    const nar = buildSessionNarrative(text, 'sess-img');
    // The image bytes appear NOWHERE — not in any preview, label, or serialized block.
    const serialized = JSON.stringify(nar);
    expect(serialized).not.toContain(PNG_BYTES);
    expect(serialized).not.toContain('iVBOR');
    // and the drop is counted on the narrative.
    const w = nar.warnings.find((x) => x.code === 'transcript-image-dropped');
    expect(w?.detail).toBe('1');
    // the surviving text is still projected into the (single) block's response.
    expect(nar.blocks[0]!.responsePreview.text).toContain('screenshot saved');
  });

  it('a bare-string content union passes through unchanged (no false image-drop)', () => {
    expect(projectText('plain string result')).toEqual({
      text: 'plain string result',
      droppedImages: 0,
      droppedOther: 0,
    });
  });
});

// --- (c) synthetic user records are filtered --------------------------------

describe('isRealUserPrompt — the load-bearing synthetic filter (decision 3)', () => {
  const scan1 = (l: string) => scanTranscript(l).records[0]!;

  it('ACCEPTS a real external user-role text prompt', () => {
    expect(isRealUserPrompt(scan1(userPrompt('please fix the bug', '2026-06-07T00:00:00Z')))).toBe(true);
  });

  it('REJECTS isMeta', () => {
    expect(isRealUserPrompt(scan1(userPrompt('hi', '2026-06-07T00:00:00Z', { isMeta: true })))).toBe(false);
  });

  it('REJECTS <command / <local-command / Caveat prefixes', () => {
    for (const t of ['<command-name>/model</command-name>', '<local-command-caveat>x', 'Caveat: generated by']) {
      expect(isRealUserPrompt(scan1(userPrompt(t, '2026-06-07T00:00:00Z')))).toBe(false);
    }
  });

  it('REJECTS harness-injected markers: <task-notification>, [Request interrupted, compaction summary', () => {
    // Observed leaking past the original filter on the real argus session (d2cfe0e6): 58
    // task-notifications, 2 interrupts, 5 compaction handoffs — none are user prompts.
    for (const t of [
      '<task-notification>\n<task-id>w405q7cl8</task-id>',
      '[Request interrupted by user]',
      '[Request interrupted by user for tool use]',
      'This session is being continued from a previous conversation that ran out of context.',
    ]) {
      expect(isRealUserPrompt(scan1(userPrompt(t, '2026-06-07T00:00:00Z')))).toBe(false);
    }
  });

  it('REJECTS a tool_result carrier (it is not a real prompt even though type==user)', () => {
    expect(isRealUserPrompt(scan1(toolResultCarrier('out', '2026-06-07T00:00:00Z')))).toBe(false);
  });

  it('REJECTS non-external userType and non-user role', () => {
    expect(isRealUserPrompt(scan1(userPrompt('x', '2026-06-07T00:00:00Z', { userType: 'internal' })))).toBe(false);
  });

  it('synthetic records never START a block nor LEAK into a promptPreview', () => {
    const text = [
      userPrompt('<command-name>/model</command-name>', '2026-06-07T00:00:00Z'), // synthetic
      userPrompt('Caveat: do not respond', '2026-06-07T00:00:01Z', { isMeta: true }), // synthetic
      userPrompt('REAL: build the parser', '2026-06-07T00:00:02Z'), // the ONLY real prompt
      assistant([{ type: 'text', text: 'on it' }], '2026-06-07T00:00:03Z'),
      toolResultCarrier('tool output', '2026-06-07T00:00:04Z'), // synthetic carrier
    ].join('\n');

    const nar = buildSessionNarrative(text, 'sess-syn');
    // Exactly ONE real-prompt block. The leading synthetics are dropped entirely (they neither
    // anchor a block nor open an empty session-start shell), so the real prompt is block 0.
    const promptBlocks = nar.blocks.filter((b) => b.cutReason === 'prompt');
    expect(promptBlocks).toHaveLength(1);
    expect(promptBlocks[0]!.promptPreview.text).toContain('REAL: build the parser');
    // No synthetic text leaks into ANY promptPreview.
    for (const b of nar.blocks) {
      expect(b.promptPreview.text).not.toContain('<command-name>');
      expect(b.promptPreview.text).not.toContain('Caveat: do not respond');
    }
  });
});

// --- (d) N real prompts → N blocks, each absorbing following assistant work ------

describe('segmentTranscript — real-prompt anchored blocks (decision 3)', () => {
  it('N real prompts → N blocks; each block absorbs the work until the NEXT prompt', () => {
    const text = [
      userPrompt('prompt one', '2026-06-07T00:00:00Z'),
      assistant([{ type: 'text', text: 'answer one' }, { type: 'tool_use', name: 'Read', input: { file_path: '/a/x.ts' } }], '2026-06-07T00:00:01Z'),
      toolResultCarrier('read ok', '2026-06-07T00:00:02Z'),
      userPrompt('prompt two', '2026-06-07T00:00:03Z'),
      assistant([{ type: 'text', text: 'answer two' }, { type: 'tool_use', name: 'Bash', input: {} }], '2026-06-07T00:00:04Z'),
      userPrompt('prompt three', '2026-06-07T00:00:05Z'),
      assistant([{ type: 'text', text: 'answer three' }], '2026-06-07T00:00:06Z'),
    ].join('\n');

    const nar = buildSessionNarrative(text, 'sess-seg');
    expect(nar.blocks).toHaveLength(3);
    expect(nar.blocks.every((b) => b.cutReason === 'prompt')).toBe(true);

    // block 0 absorbed the Read + its tool_result carrier; recordRange is contiguous.
    const b0 = nar.blocks[0]!;
    expect(b0.recordRange).toEqual({ start: 0, end: 2 });
    expect(b0.promptPreview.text).toContain('prompt one');
    expect(b0.responsePreview.text).toContain('answer one');
    expect(b0.responsePreview.text).toContain('read ok'); // the carrier's text folded in
    expect(b0.toolCounts).toEqual({ Read: 1 });
    expect(b0.filesTouched).toEqual(['x.ts']); // BASENAME only (decision 9)
    expect(b0.turnCount).toBe(3); // prompt + assistant + carrier

    // block 1 has the Bash call; block 2 just text.
    expect(nar.blocks[1]!.toolCounts).toEqual({ Bash: 1 });
    expect(nar.blocks[1]!.recordRange).toEqual({ start: 3, end: 4 });
    expect(nar.blocks[2]!.recordRange).toEqual({ start: 5, end: 6 });

    // ids are stable + distinct (hash of range+timestamps, NOT content).
    const ids = nar.blocks.map((b) => b.id);
    expect(new Set(ids).size).toBe(3);
    expect(buildSessionNarrative(text, 'sess-seg').blocks.map((b) => b.id)).toEqual(ids);
  });

  it('records BEFORE the first real prompt open a session-start block (nothing lost)', () => {
    const text = [
      toolResultCarrier('orphan tool output', '2026-06-07T00:00:00Z'), // pre-prompt
      assistant([{ type: 'text', text: 'pre-amble' }], '2026-06-07T00:00:01Z'),
      userPrompt('the first real prompt', '2026-06-07T00:00:02Z'),
      assistant([{ type: 'text', text: 'reply' }], '2026-06-07T00:00:03Z'),
    ].join('\n');
    const nar = buildSessionNarrative(text, 'sess-start');
    expect(nar.blocks).toHaveLength(2);
    expect(nar.blocks[0]!.cutReason).toBe('session-start');
    expect(nar.blocks[0]!.recordRange).toEqual({ start: 0, end: 1 });
    expect(nar.blocks[1]!.cutReason).toBe('prompt');
  });

  it('drops synthetic records from accumulation — no preview pollution, no turn inflation', () => {
    const text = [
      userPrompt('<command-name>/clear</command-name>', '2026-06-07T00:00:00Z'), // synthetic preamble
      userPrompt('REAL prompt', '2026-06-07T00:00:01Z'), // the only real anchor
      assistant([{ type: 'text', text: 'working' }], '2026-06-07T00:00:02Z'),
      userPrompt('<task-notification>\n<task-id>w1</task-id>', '2026-06-07T00:00:03Z'), // mid-block synthetic
      assistant([{ type: 'text', text: 'more work' }], '2026-06-07T00:00:04Z'),
    ].join('\n');
    const nar = buildSessionNarrative(text, 'sess-acc');
    // The all-synthetic preamble opened NO session-start block — block 0 is the real prompt.
    expect(nar.blocks).toHaveLength(1);
    const b0 = nar.blocks[0]!;
    expect(b0.cutReason).toBe('prompt');
    expect(b0.promptPreview.text).toContain('REAL prompt');
    // The mid-block <task-notification> text never folded into the response preview...
    expect(b0.responsePreview.text).not.toContain('task-notification');
    expect(b0.responsePreview.text).toContain('working');
    expect(b0.responsePreview.text).toContain('more work');
    // ...and it did not inflate the turn count (prompt + 2 assistants = 3, NOT 4).
    expect(b0.turnCount).toBe(3);
  });

  it('SUPPRESSES an empty session-start shell (only synthetic/system preamble, no real turns)', () => {
    const systemRec = line({ type: 'system', timestamp: '2026-06-07T00:00:00Z', content: 'boot' });
    const text = [
      systemRec, // a system record opens a session-start builder but contributes no turn
      userPrompt('<command-name>/model</command-name>', '2026-06-07T00:00:01Z'), // synthetic, skipped
      userPrompt('the first real prompt', '2026-06-07T00:00:02Z'),
      assistant([{ type: 'text', text: 'reply' }], '2026-06-07T00:00:03Z'),
    ].join('\n');
    const nar = buildSessionNarrative(text, 'sess-empty-start');
    // No blank "Session start" card: the empty (turnCount 0) shell is dropped; block 0 is the prompt.
    expect(nar.blocks).toHaveLength(1);
    expect(nar.blocks.every((b) => b.cutReason === 'prompt')).toBe(true);
    expect(nar.blocks[0]!.promptPreview.text).toContain('the first real prompt');
  });

  it('stamps the NARRATIVE_FORMAT pin + recovers projectPath from cwd', () => {
    const nar = buildSessionNarrative(userPrompt('x', '2026-06-07T00:00:00Z'), 'sess-fmt');
    expect(nar.format).toBe(NARRATIVE_FORMAT);
    expect(NARRATIVE_FORMAT_ENGINE).toBe(NARRATIVE_FORMAT); // engine pin === contract pin
    expect(nar.projectPath).toBe('/Users/nicolas/devel/argus');
  });
});

// --- (e) long response bounded to head+tail ---------------------------------

describe('boundedPreview / responsePreview — head+tail bounding (decision 5, B-pick)', () => {
  it('a short response is returned whole, NOT truncated', () => {
    const p = boundedPreview('short answer', RESPONSE_HEADTAIL);
    expect(p.truncated).toBe(false);
    expect(p.text).toBe('short answer');
  });

  it('a long response keeps the HEAD and the TAIL, drops the middle, marks truncated', () => {
    const head = 'HEAD_MARKER ' + 'a'.repeat(RESPONSE_HEADTAIL);
    const mid = 'MIDDLE_SECRET '.repeat(5000);
    const tail = 'b'.repeat(RESPONSE_HEADTAIL) + ' TAIL_MARKER';
    const p = boundedPreview(head + mid + tail, RESPONSE_HEADTAIL);
    expect(p.truncated).toBe(true);
    expect(p.text).toContain('HEAD_MARKER');
    expect(p.text).toContain('TAIL_MARKER');
    expect(p.text).not.toContain('MIDDLE_SECRET'); // the middle is elided
    // bounded to ~2x the per-end budget + the elision marker — never the whole body.
    expect(Buffer.byteLength(p.text, 'utf8')).toBeLessThanOrEqual(RESPONSE_HEADTAIL * 2 + 16);
  });

  it('never HOLDS/EMITS the whole multi-MB response — bounds an ASSEMBLED response to head+tail', () => {
    // A large response assembled across MANY under-cap assistant records (a single 4 MB JSONL
    // line would instead be skipped by the 256 KB line cap). 60 records × ~100 KB ≈ 6 MB.
    const lines = [userPrompt('do a huge thing', '2026-06-07T00:00:00Z')];
    lines.push(assistant([{ type: 'text', text: 'START_OF_RESPONSE' }], '2026-06-07T00:00:01Z'));
    for (let i = 0; i < 60; i += 1) {
      lines.push(assistant([{ type: 'text', text: 'm'.repeat(100 * 1024) }], `2026-06-07T00:0${1}:${i}Z`));
    }
    lines.push(assistant([{ type: 'text', text: 'END_OF_RESPONSE' }], '2026-06-07T00:05:00Z'));
    const nar = buildSessionNarrative(lines.join('\n'), 'sess-big');
    const rp = nar.blocks[0]!.responsePreview;
    expect(rp.truncated).toBe(true);
    // Bounded to ~2x the per-end budget + elision — never the whole ~6 MB assembled body.
    expect(Buffer.byteLength(rp.text, 'utf8')).toBeLessThanOrEqual(RESPONSE_HEADTAIL * 2 + 16);
    expect(rp.text).toContain('START_OF_RESPONSE'); // head preserved
    expect(rp.text).toContain('END_OF_RESPONSE'); // tail preserved
    expect(rp.text).toContain('…'); // elision marker between head and tail
  });

  it('all emitted previews route through redact() (the seam) — a swapped strategy IS applied', () => {
    setRedactionStrategy({ redact: (t) => t.replace(/SECRET/g, '[REDACTED]') });
    const text = [
      userPrompt('here is a SECRET prompt', '2026-06-07T00:00:00Z'),
      assistant([{ type: 'text', text: 'a SECRET response' }], '2026-06-07T00:00:01Z'),
    ].join('\n');
    const nar = buildSessionNarrative(text, 'sess-redact');
    expect(nar.blocks[0]!.promptPreview.text).toBe('here is a [REDACTED] prompt');
    expect(nar.blocks[0]!.responsePreview.text).toBe('a [REDACTED] response');
    expect(nar.blocks[0]!.topicLabel).toBe('here is a [REDACTED] prompt');
  });
});

// --- (f) extractWorkflowSpawns ----------------------------------------------

describe('extractWorkflowSpawns — Workflow tool_use launches', () => {
  const scanAsst = (content: unknown[]) =>
    scanTranscript(assistant(content, '2026-06-07T00:00:00Z')).records[0]!;

  it('finds a Workflow tool_use; basename + a SHORT args digest, runId null (M0)', () => {
    const r = scanAsst([
      {
        type: 'tool_use',
        name: 'Workflow',
        input: { scriptPath: '/Users/nicolas/devel/argus/.claude/workflows/plan-research.js', args: '{"date":"2026-06-07"}' },
      },
    ]);
    const spawns = extractWorkflowSpawns(r);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.scriptBasename).toBe('plan-research.js');
    expect(spawns[0]!.runId).toBeNull();
    expect(spawns[0]!.timestamp).toBe('2026-06-07T00:00:00Z');
    expect(spawns[0]!.argsDigest).toBe('{"date":"2026-06-07"}');
    expect(spawns[0]!.argsDigest.length).toBeLessThanOrEqual(120);
  });

  it('skips a Workflow tool_use missing a usable scriptPath (defensive — never throws)', () => {
    expect(extractWorkflowSpawns(scanAsst([{ type: 'tool_use', name: 'Workflow', input: {} }]))).toEqual([]);
    expect(extractWorkflowSpawns(scanAsst([{ type: 'tool_use', name: 'Bash', input: {} }]))).toEqual([]);
  });

  it('a block surfaces its workflow spawns in segmentTranscript', () => {
    const text = [
      userPrompt('launch research', '2026-06-07T00:00:00Z'),
      assistant(
        [{ type: 'tool_use', name: 'Workflow', input: { scriptPath: '/p/.claude/workflows/refine-plan.js', args: '{}' } }],
        '2026-06-07T00:00:01Z',
      ),
    ].join('\n');
    const nar = buildSessionNarrative(text, 'sess-wf');
    expect(nar.blocks[0]!.workflowSpawns).toHaveLength(1);
    expect(nar.blocks[0]!.workflowSpawns[0]!.scriptBasename).toBe('refine-plan.js');
    expect(nar.blocks[0]!.toolCounts).toEqual({ Workflow: 1 });
  });
});

// --- loadSessionNarrative through a FileSystemPort (StatPort fixture style) ------

class StatPort implements FileSystemPort {
  private files = new Map<string, { content: string; mtimeMs: number }>();
  set(path: string, content: string, mtimeMs = 0): this {
    this.files.set(path, { content, mtimeMs });
    return this;
  }
  async readFile(path: string): Promise<string> {
    const v = this.files.get(path);
    if (!v) throw new Error(`ENOENT ${path}`);
    return v.content;
  }
  async readJson(path: string): Promise<unknown> {
    return JSON.parse(await this.readFile(path)) as unknown;
  }
  async listDir(path: string): Promise<Array<{ name: string; isDir: boolean }>> {
    const prefix = path.replace(/\/+$/, '') + '/';
    const names = new Map<string, boolean>();
    let any = false;
    for (const f of this.files.keys()) {
      if (!f.startsWith(prefix)) continue;
      any = true;
      const rest = f.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) names.set(rest, false);
      else names.set(rest.slice(0, slash), true);
    }
    if (!any) throw new Error(`ENOENT ${path}`);
    return [...names.entries()].map(([name, isDir]) => ({ name, isDir }));
  }
  async stat(path: string) {
    const v = this.files.get(path);
    return v ? { size: v.content.length, mtimeMs: v.mtimeMs } : null;
  }
  async exists(path: string) {
    return this.files.has(path);
  }
  watch(): () => void {
    return () => {};
  }
}

describe('loadSessionNarrative (port-injected, no node:fs)', () => {
  it('reads a transcript through the port and segments it', async () => {
    const port = new StatPort();
    const path = '/home/.claude/projects/-Users-nicolas-devel-argus/sess-port.jsonl';
    port.set(
      path,
      [
        userPrompt('via the port', '2026-06-07T00:00:00Z'),
        assistant([{ type: 'text', text: 'ack' }], '2026-06-07T00:00:01Z'),
      ].join('\n'),
    );
    const nar = await loadSessionNarrative(port, path, 'sess-port');
    expect(nar.sessionId).toBe('sess-port');
    expect(nar.blocks).toHaveLength(1);
    expect(nar.blocks[0]!.promptPreview.text).toContain('via the port');
  });
});

// --- discoverSessions (M1: the project session-timeline source) -----------------

describe('discoverSessions (port-injected, no node:fs)', () => {
  const SLUG = '-Users-nicolas-devel-argus';
  const HOME = '/home/.claude';
  const slugDir = `${HOME}/projects/${SLUG}`;

  it('lists SIBLING *.jsonl files over a 2-file fixture, newest-first by end span', async () => {
    const port = new StatPort();
    // Session A: older end span; carries a cwd + a Workflow spawn.
    port.set(
      `${slugDir}/sess-A.jsonl`,
      [
        userPrompt('first session', '2026-06-01T00:00:00Z'),
        assistant(
          [{ type: 'tool_use', name: 'Workflow', input: { scriptPath: '/p/.claude/workflows/plan-research.js', args: '{}' } }],
          '2026-06-01T00:05:00Z',
        ),
      ].join('\n'),
    );
    // Session B: newer end span; two real prompts, no Workflow spawn.
    port.set(
      `${slugDir}/sess-B.jsonl`,
      [
        userPrompt('second session', '2026-06-07T09:00:00Z'),
        assistant([{ type: 'text', text: 'working' }], '2026-06-07T09:01:00Z'),
        userPrompt('again', '2026-06-07T10:00:00Z'),
      ].join('\n'),
    );

    const sessions = await discoverSessions(port, HOME, SLUG);
    expect(sessions).toHaveLength(2);
    // Newest end-span first: B (ends 10:00 on the 7th) before A (ends 00:05 on the 1st).
    expect(sessions.map((s) => s.sessionId)).toEqual(['sess-B', 'sess-A']);

    const a = sessions.find((s) => s.sessionId === 'sess-A')!;
    expect(a.timeRange).toEqual({ start: '2026-06-01T00:00:00Z', end: '2026-06-01T00:05:00Z' });
    expect(a.recordCount).toBe(2);
    expect(a.workflowSpawnCount).toBe(1);
    expect(a.commitCount).toBe(0); // M0/M1 emit 0 (M2 correlates real commits)
    expect(a.projectPath).toBe('/Users/nicolas/devel/argus'); // recovered from cwd

    const b = sessions.find((s) => s.sessionId === 'sess-B')!;
    expect(b.timeRange).toEqual({ start: '2026-06-07T09:00:00Z', end: '2026-06-07T10:00:00Z' });
    expect(b.recordCount).toBe(3);
    expect(b.workflowSpawnCount).toBe(0);
  });

  it('SKIPS directories (incl. the <sessionId>/ run subdir) and non-.jsonl files', async () => {
    const port = new StatPort();
    port.set(`${slugDir}/sess-real.jsonl`, userPrompt('real', '2026-06-07T00:00:00Z'));
    // A run subdir (must be skipped — discoverSessions lists SIBLING .jsonl only).
    port.set(`${slugDir}/sess-real/workflows/wf_abc.json`, '{}');
    // A non-transcript file (must be skipped).
    port.set(`${slugDir}/notes.txt`, 'ignore me');
    const sessions = await discoverSessions(port, HOME, SLUG);
    expect(sessions.map((s) => s.sessionId)).toEqual(['sess-real']);
  });

  it('an absent/unreadable slug dir yields [] (never throws)', async () => {
    const port = new StatPort();
    await expect(discoverSessions(port, HOME, SLUG)).resolves.toEqual([]);
  });

  it('backfills projectPath from the caller when a session carries no cwd', async () => {
    const port = new StatPort();
    // A prompt with NO cwd field (StatPort's listDir works; the record has no cwd).
    port.set(
      `${slugDir}/sess-nocwd.jsonl`,
      line({
        type: 'user',
        userType: 'external',
        timestamp: '2026-06-07T00:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'no cwd here' }] },
      }),
    );
    const sessions = await discoverSessions(port, HOME, SLUG, '/Users/nicolas/devel/argus');
    expect(sessions[0]!.projectPath).toBe('/Users/nicolas/devel/argus'); // backfilled
  });
});

describe('summarizeScannedSession (cheap, no re-segment)', () => {
  it('derives span + counts WITHOUT segmenting', () => {
    const text = [
      userPrompt('a', '2026-06-07T00:00:00Z'),
      assistant(
        [{ type: 'tool_use', name: 'Workflow', input: { scriptPath: '/p/.claude/workflows/x.js', args: '{}' } }],
        '2026-06-07T00:01:00Z',
      ),
      toolResultCarrier('ok', '2026-06-07T00:02:00Z'),
    ].join('\n');
    const s = summarizeScannedSession(scanTranscript(text), 'sess-sum');
    expect(s.sessionId).toBe('sess-sum');
    expect(s.recordCount).toBe(3);
    expect(s.workflowSpawnCount).toBe(1);
    expect(s.commitCount).toBe(0);
    expect(s.timeRange).toEqual({ start: '2026-06-07T00:00:00Z', end: '2026-06-07T00:02:00Z' });
  });
});

// --- loadBlockTurns / blockTurns (M1: the lazy click-in view) -------------------

describe('loadBlockTurns / blockTurns — full turns of one block', () => {
  it('slices the record range and projects each user/assistant record to a Turn', async () => {
    const port = new StatPort();
    const path = `/home/.claude/projects/-Users-nicolas-devel-argus/sess-turns.jsonl`;
    port.set(
      path,
      [
        userPrompt('the prompt', '2026-06-07T00:00:00Z'), // 0
        assistant(
          [
            { type: 'text', text: 'let me read it' },
            { type: 'tool_use', name: 'Read', input: { file_path: '/a/b/file.ts' } },
          ],
          '2026-06-07T00:00:01Z',
        ), // 1
        toolResultCarrier('read ok', '2026-06-07T00:00:02Z'), // 2 (a user-type carrier → still a Turn)
        userPrompt('the NEXT prompt', '2026-06-07T00:00:03Z'), // 3 — outside the range
      ].join('\n'),
    );

    // The block covers records [0..2] (prompt + assistant + its carrier).
    const turns = await loadBlockTurns(port, path, { start: 0, end: 2 });
    expect(turns).toHaveLength(3);

    expect(turns[0]!.role).toBe('user');
    expect(turns[0]!.promptId).toBe('p-2026-06-07T00:00:00Z');
    expect(turns[0]!.textPreview.text).toContain('the prompt');
    expect(turns[0]!.toolCalls).toEqual([]);

    expect(turns[1]!.role).toBe('assistant');
    expect(turns[1]!.textPreview.text).toContain('let me read it');
    expect(turns[1]!.toolCalls).toHaveLength(1);
    expect(turns[1]!.toolCalls[0]!.name).toBe('Read');
    expect(turns[1]!.toolCalls[0]!.briefArgs).toContain('file.ts'); // a short args digest

    expect(turns[2]!.role).toBe('user'); // the tool_result carrier
    expect(turns[2]!.textPreview.text).toContain('read ok');

    // The record OUTSIDE the range (the next prompt) is NOT included.
    expect(turns.some((t) => t.textPreview.text.includes('the NEXT prompt'))).toBe(false);
  });

  it('a Turn textPreview is head+tail-bounded + redact()-routed (never a whole body / image byte)', () => {
    const big = 'HEAD_T ' + 'q'.repeat(TURN_TEXT_HEADTAIL * 3) + ' TAIL_T';
    const text = [
      userPrompt('go', '2026-06-07T00:00:00Z'),
      // An assistant record with a long text block AND an image block (must be dropped).
      assistant(
        [
          { type: 'text', text: big },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_BYTES } },
        ],
        '2026-06-07T00:00:01Z',
      ),
    ].join('\n');
    const turns = blockTurns(scanTranscript(text), { start: 0, end: 1 });
    const asst = turns.find((t) => t.role === 'assistant')!;
    expect(asst.textPreview.truncated).toBe(true);
    expect(Buffer.byteLength(asst.textPreview.text, 'utf8')).toBeLessThanOrEqual(TURN_TEXT_HEADTAIL * 2 + 16);
    expect(asst.textPreview.text).toContain('HEAD_T');
    expect(asst.textPreview.text).toContain('TAIL_T');
    // ZERO image bytes survive into a click-in turn (the load-bearing privacy invariant).
    expect(JSON.stringify(turns)).not.toContain(PNG_BYTES);
    expect(JSON.stringify(turns)).not.toContain('iVBOR');
  });

  it('skips non-user/assistant records and clamps an oversized/inverted range', () => {
    const text = [
      line({ type: 'system', timestamp: '2026-06-07T00:00:00Z' }), // 0 — not a turn
      userPrompt('hi', '2026-06-07T00:00:01Z'), // 1
      assistant([{ type: 'text', text: 'yo' }], '2026-06-07T00:00:02Z'), // 2
    ].join('\n');
    const scanned = scanTranscript(text);
    // Oversized end clamps to the last record; the system record at 0 is skipped.
    const turns = blockTurns(scanned, { start: 0, end: 999 });
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    // An inverted / empty range yields [].
    expect(blockTurns(scanned, { start: 2, end: 1 })).toEqual([]);
  });

  it('Turn tool-call briefArgs routes through the redact() seam', () => {
    setRedactionStrategy({ redact: (t) => t.replace(/SECRET/g, '[R]') });
    const text = assistant(
      [{ type: 'tool_use', name: 'Bash', input: { command: 'echo SECRET' } }],
      '2026-06-07T00:00:00Z',
    );
    const turns = blockTurns(scanTranscript(text), { start: 0, end: 0 });
    expect(turns[0]!.toolCalls[0]!.briefArgs).toContain('[R]');
    expect(turns[0]!.toolCalls[0]!.briefArgs).not.toContain('SECRET');
  });
});

// --- REAL-DATA smoke (guarded: skips when the file is absent) -------------------

const REAL_PATH = '/Users/nicolas/.claude/projects/-Users-nicolas-devel-argus/d2cfe0e6-8f9f-4491-a5ac-b2622cf741bf.jsonl';
const REAL_PRESENT = existsSync(REAL_PATH);

describe.runIf(REAL_PRESENT)('REAL-DATA smoke — the actual ~67 MB transcript', () => {
  it('parses + segments without throwing; plausible block count; no image-blob leak; timed', () => {
    const sizeMb = statSync(REAL_PATH).size / 1024 / 1024;
    const t0 = performance.now();
    const text = readFileSync(REAL_PATH, 'utf8');
    const tRead = performance.now();

    let nar!: ReturnType<typeof buildSessionNarrative>;
    expect(() => {
      nar = buildSessionNarrative(text, 'd2cfe0e6-8f9f-4491-a5ac-b2622cf741bf');
    }).not.toThrow();
    const tSeg = performance.now();

    // Plausible block count: roughly tens to ~120+ real prompts (the file grows live).
    expect(nar.blocks.length).toBeGreaterThan(20);
    expect(nar.blocks.length).toBeLessThan(400);

    // Over-cap (the 2 MB line) + image drops are observed + counted, never fatal.
    expect(nar.warnings.find((w) => w.code === 'transcript-line-over-cap')).toBeDefined();
    expect(nar.warnings.find((w) => w.code === 'transcript-image-dropped')).toBeDefined();
    expect(nar.incomplete).toBe(true);

    // No image BLOB leaks into the emitted narrative (the load-bearing privacy invariant). The
    // unit tests above prove image BLOCKS are dropped deterministically (projectContent never even
    // retains `source`); here on real data we target the actual risk — a multi-KB base64 image
    // body surviving into a preview. We do NOT substring-match a short marker like 'iVBOR': this
    // dogfood transcript legitimately contains source code (incl. THIS test's own PNG_BYTES
    // constant, read during the session) as projected TEXT, which is not a leak. A contiguous
    // base64 run ≥ 1 KB, however, can only be a real image/blob escaping the allowlist.
    const serialized = JSON.stringify(nar);
    const longBase64 = serialized.match(/[A-Za-z0-9+/]{1024,}={0,2}/);
    expect(longBase64, longBase64 ? `leaked base64 blob: ${longBase64[0].slice(0, 60)}…` : '').toBeNull();

    // Every responsePreview is head+tail-bounded — never a multi-MB body on the wire.
    for (const b of nar.blocks) {
      expect(Buffer.byteLength(b.responsePreview.text, 'utf8')).toBeLessThanOrEqual(RESPONSE_HEADTAIL * 2 + 16);
    }

    // projectPath recovered + format pinned.
    expect(nar.projectPath).toBe('/Users/nicolas/devel/argus');
    expect(nar.format).toBe(NARRATIVE_FORMAT_ENGINE);

    // Record the timing as an explicit acceptance gate (knowledge.md decision 5).
    console.log(
      `[narrative real-data smoke] sizeMB=${sizeMb.toFixed(1)} records=${nar.totalRecords} ` +
        `blocks=${nar.blocks.length} readMs=${(tRead - t0).toFixed(0)} segMs=${(tSeg - tRead).toFixed(0)} ` +
        `totalMs=${(tSeg - t0).toFixed(0)} heapMB=${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0)}`,
    );
    // A loose performance gate so a future O(n^2) regression fails the suite.
    expect(tSeg - t0).toBeLessThan(30_000);
  });
});
