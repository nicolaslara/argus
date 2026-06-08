// @argus/server — the ONE place argus shells out to a local model. Every LLM feature (node
// captions, sub-UI panels, run-describe, and the M4 narrative summaries) goes through this
// runner, so the model / flags / timeout / degradation policy live in a single spot you can
// tune. Headless `claude -p`; reads the `result` field of `--output-format json`. NEVER throws,
// NEVER leaves a hung child, and resolves null on absent/error/timeout so every caller degrades
// to its deterministic baseline. Nothing here is logged with the prompt/result (boundaries §4).

import { spawn } from 'node:child_process';

/** The model used for the cheap, high-volume annotation calls. One place to swap it. */
export const LLM_MODEL = 'haiku';

/** Hard cap on a single generation; a hung/slow child is killed and the caller degrades. */
export const CLAUDE_TIMEOUT_MS = 30_000;

/** A prompt → raw model text (or null on absent/error/timeout → caller falls back). */
export type ClaudeRunner = (prompt: string) => Promise<string | null>;

/**
 * The default `claude -p` runner. Detects `claude` on PATH implicitly: if the binary is absent
 * the spawn errors → we resolve null (graceful degrade). Uses {@link LLM_MODEL} (cheap) +
 * `--output-format json` and reads the `result` field. Injected so tests stub it (no real spawn).
 */
export function defaultClaudeRunner(spawnFn: typeof spawn = spawn): ClaudeRunner {
  return (prompt: string) =>
    new Promise<string | null>((resolveResult) => {
      let settled = false;
      const done = (value: string | null) => {
        if (settled) return;
        settled = true;
        resolveResult(value);
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawnFn('claude', ['-p', '--model', LLM_MODEL, '--output-format', 'json'], {
          stdio: ['pipe', 'pipe', 'ignore'],
        });
      } catch {
        done(null); // `claude` not spawnable at all → degrade
        return;
      }
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        done(null);
      }, CLAUDE_TIMEOUT_MS);

      let out = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
        if (out.length > 1_000_000) {
          try {
            child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }
      });
      child.on('error', () => {
        clearTimeout(timer);
        done(null); // ENOENT (claude absent) lands here
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          done(null);
          return;
        }
        try {
          const parsed = JSON.parse(out) as unknown;
          const o = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
          const result = typeof o.result === 'string' ? o.result : null;
          done(result);
        } catch {
          done(null);
        }
      });
      try {
        child.stdin?.write(prompt);
        child.stdin?.end();
      } catch {
        // If we can't write the prompt, let the timeout / close handler settle it.
      }
    });
}
