import { describe, it, expect } from 'vitest';
import {
  agentActivityFromTranscript,
  agentActivityFromDir,
  ACTIVITY_TIMELINE_CAP,
  type FileSystemPort,
} from './index.ts';

// --- synthetic transcript builder ------------------------------------------
//
// A few user/assistant events shaped exactly like a real `agent-<id>.jsonl`:
// a prompt (user), an assistant turn with usage + a tool_use, another with usage +
// two tool_use + a text turn, and a trailing assistant socket-error text. One line in
// the middle is deliberately malformed JSON (must be SKIPPED, never thrown on).

function userPrompt(text: string, t: string): string {
  return JSON.stringify({ type: 'user', timestamp: t, message: { role: 'user', content: text } });
}
function assistantTurn(
  t: string,
  usage: { input?: number; output?: number; cacheRead?: number },
  blocks: Array<{ type: 'tool_use'; name: string } | { type: 'text'; text: string }>,
): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: t,
    message: {
      role: 'assistant',
      content: blocks,
      usage: {
        input_tokens: usage.input,
        output_tokens: usage.output,
        cache_read_input_tokens: usage.cacheRead,
      },
    },
  });
}

const TRANSCRIPT = [
  userPrompt('Diagnose the failing run\nand report the root cause.', '2026-06-05T21:58:01.000Z'),
  assistantTurn(
    '2026-06-05T21:58:10.000Z',
    { input: 1000, output: 4, cacheRead: 500 },
    [{ type: 'text', text: "I'll read the files." }, { type: 'tool_use', name: 'Read' }],
  ),
  '{ this is a TORN malformed line', // <- must be skipped, never throw
  assistantTurn(
    '2026-06-05T22:00:00.000Z',
    { input: 2000, output: 50, cacheRead: 1000 },
    [
      { type: 'tool_use', name: 'Bash' },
      { type: 'tool_use', name: 'Read' },
      { type: 'text', text: 'Edits applied.' },
    ],
  ),
  // trailing socket-error text (the root-cause line for a failed agent)
  assistantTurn(
    '2026-06-05T22:02:01.000Z',
    { input: 100, output: 0, cacheRead: 0 },
    [{ type: 'text', text: 'API Error: The socket connection was closed unexpectedly' }],
  ),
  '', // trailing blank line (live append) — ignored
].join('\n');

describe('agentActivityFromTranscript', () => {
  const a = agentActivityFromTranscript(TRANSCRIPT, 'agent-x');

  it('does not throw and carries the agentId', () => {
    expect(a.agentId).toBe('agent-x');
  });

  it('derives the label from the first user message first line', () => {
    expect(a.label).toBe('Diagnose the failing run');
  });

  it('captures the full first user message as the prompt', () => {
    expect(a.prompt).toBe('Diagnose the failing run\nand report the root cause.');
  });

  it('sums tokens across assistant usage', () => {
    expect(a.tokens).toEqual({ input: 3100, output: 54, cacheRead: 1500 });
  });

  it('counts tool_use by name (distinct + total)', () => {
    expect(a.tools).toEqual([
      { name: 'Read', count: 2 },
      { name: 'Bash', count: 1 },
    ]);
    expect(a.toolCalls).toBe(3);
  });

  it('computes durationMs from first→last timestamp', () => {
    expect(a.startedAt).toBe('2026-06-05T21:58:01.000Z');
    expect(a.lastAt).toBe('2026-06-05T22:02:01.000Z');
    expect(a.durationMs).toBe(4 * 60 * 1000); // 21:58:01 → 22:02:01 = 240_000ms
  });

  it('captures the last assistant text as lastText and detects the error line', () => {
    expect(a.lastText).toBe('API Error: The socket connection was closed unexpectedly');
    expect(a.error).toBe('API Error: The socket connection was closed unexpectedly');
  });

  it('builds an ordered tool/text timeline (malformed line skipped, no throw)', () => {
    expect(a.timeline.map((e) => `${e.kind}:${e.name ?? ''}`)).toEqual([
      'text:',
      'tool:Read',
      'tool:Bash',
      'tool:Read',
      'text:',
      'text:',
    ]);
    expect(a.timeline[0]!.t).toBe('2026-06-05T21:58:10.000Z');
  });
});

describe('agentActivityFromTranscript — defensive', () => {
  it('returns nulls/empties (never throws) on empty / all-malformed input', () => {
    const empty = agentActivityFromTranscript('', 'a');
    expect(empty.tokens).toBeNull();
    expect(empty.tools).toEqual([]);
    expect(empty.toolCalls).toBe(0);
    expect(empty.timeline).toEqual([]);
    expect(empty.label).toBeUndefined();
    expect(empty.prompt).toBeUndefined();
    expect(empty.durationMs).toBeUndefined();

    const garbage = agentActivityFromTranscript('not json\n{also bad\n42\nnull', 'a');
    expect(garbage.tokens).toBeNull();
    expect(garbage.timeline).toEqual([]);
    expect(garbage.prompt).toBeUndefined();
  });

  it('caps a huge prompt to a sane length', () => {
    const huge = 'x'.repeat(20_000);
    const a = agentActivityFromTranscript(userPrompt(huge, '2026-06-05T22:00:00.000Z'), 'a');
    expect(a.prompt).toBeDefined();
    expect(a.prompt!.length).toBe(4000);
  });

  it('caps the timeline at ACTIVITY_TIMELINE_CAP', () => {
    const lines: string[] = [];
    for (let i = 0; i < ACTIVITY_TIMELINE_CAP + 50; i += 1) {
      lines.push(assistantTurn('2026-06-05T22:00:00.000Z', { input: 1, output: 1 }, [{ type: 'tool_use', name: 'Read' }]));
    }
    const a = agentActivityFromTranscript(lines.join('\n'), 'a');
    expect(a.timeline.length).toBe(ACTIVITY_TIMELINE_CAP);
    // tool COUNTS are not capped — every call is still counted.
    expect(a.toolCalls).toBe(ACTIVITY_TIMELINE_CAP + 50);
  });
});

describe('agentActivityFromDir', () => {
  function fakePort(files: Record<string, string>): FileSystemPort {
    return {
      readFile: async (p) => {
        if (p in files) return files[p]!;
        throw new Error('ENOENT');
      },
      readJson: async () => ({}),
      listDir: async () => [],
      stat: async () => null,
      exists: async (p) => p in files,
      watch: () => () => {},
    };
  }

  it('reads <runDir>/agent-<id>.jsonl through the port', async () => {
    const runDir = '/run/subagents/workflows/wf_1';
    const port = fakePort({ [`${runDir}/agent-a1.jsonl`]: TRANSCRIPT });
    const a = await agentActivityFromDir(port, runDir, 'a1');
    expect(a).not.toBeNull();
    expect(a!.agentId).toBe('a1');
    expect(a!.label).toBe('Diagnose the failing run');
  });

  it('returns null when the transcript is absent (cleaned/old run)', async () => {
    const port = fakePort({});
    const a = await agentActivityFromDir(port, '/run/subagents/workflows/wf_1', 'missing');
    expect(a).toBeNull();
  });
});
