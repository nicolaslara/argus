# narrative — tasks

**Workpad objective.** A third top-level **"Story"** view: follow one Claude Code session
as a vertical timeline of topic blocks you can **watch** (one-line summary + badges) or
**click into** (full turns) — with workflow runs, git commits, and file changes in context.

**Status.** Plan synthesized 2026-06-07 (`explore-session-narrative` / `wf_4e4d6d47-f83`).
NO code yet — this is a design+roadmap workpad. **Gate before building:** the user confirms
the open questions below (esp. segmentation grain + opt-in summarization consent).

Canonical decisions live in `knowledge.md`. Load base set + this + `knowledge.md` + `references.md`.

---

## Roadmap (smallest-provable-first; STOP at the M0–M1 proof for user judgment)

- [ ] **M0 — Adapter transcript parser + real-prompt segmentation (facts-only, zero LLM).**
  *Proves:* we can parse the real ~67 MB transcript defensively and segment it into
  human-meaningful blocks anchored on real user prompts.
  *Acceptance (quantitative, on `d2cfe0e6`):* new pure `packages/adapter/src/transcript.ts`
  (`FileSystemPort`-injected) emits a `SessionNarrative` via a unit test, with gates:
  (a) 256 KB per-line byte cap applied BEFORE `JSON.parse`, coded warnings;
  (b) all 11 record types enumerated + a default drop-with-warning branch;
  (c) `tool_result.content` parsed as `string|block[]`, images/`tool_reference` dropped — a test
  with an embedded image asserts **zero image bytes** reach any `NarrativeRecord`;
  (d) synthetic user records filtered (isMeta / `<command` / `<local-command` / `Caveat` /
  tool_result carriers); block count ≈ ~120 real prompts; no synthetic text leaks into a preview;
  (e) parse time + peak memory recorded as gates; zero LLM, zero off-machine, zero writes.

- [ ] **M0.5 — Secret + home-path redactor and content allowlist (HARD GATE before M1).**
  *Proves:* no secret or absolute home path crosses the wire, a turn payload, logs, or an LLM prompt.
  *Acceptance:* a new redactor (beyond `redactInternalPaths`) strips `/Users/<home> → ~` and
  pattern-redacts `sk-`/`ghp_`/`AKIA`/`bearer`/`token=`/`password=`/`.env`-style assignments, applied
  to `promptPreview`, `responsePreview`, click-in turn text, and any `claude -p` input. A planted
  fake secret (in a prompt, a `tool_result` text block, AND an `attachment`) is absent from the
  `SessionNarrative`, the `/turns` response, server logs, and any prompt string. `grep` of logs for
  `/Users/` and `/$bunfs/` asserts absence.

- [ ] **M1 — Story view: third toggle + watch list + click-in (the core experience).**
  *Proves:* a real session renders as a clickable narrative you can watch or read, end-to-end.
  *Acceptance:* `GET /api/.../narrative` returns the Stage-1 `SessionNarrative` (token-gated,
  host-checked, `sessionId` path-guarded; an un-tokened / foreign-Origin call 401s before any FS
  read). `ViewMode` gains `'session'`; a third **"Story"** toggle swaps the React Flow canvas for
  `apps/web/src/session/NarrativePanel.tsx`. Blocks render with timestamp + `promptPreview` +
  tool/file badges; clicking a card lazily fetches that block's turns into a `<pre>` (text-only,
  never `dangerouslySetInnerHTML`). Deep-link `?view=session&block=<id>` works.

  **▲ GATE: stop here. Get user judgment on the proof before M2+.**

- [ ] **M2 — Best-effort git-commit + GitHub linkage (deterministic; cannot silently lie).** *(deferred-additive)*
  *Acceptance:* count a SHA only adjacent to a commit-success line (not from `git log` history);
  validate `/^[0-9a-f]{7,40}$/`; URL only from fixed `github.com` + `/commit/<sha>`; subject as a text
  node. A poisoned-subject + bogus-remote fixture produces no foreign-host link. (Before run-correlation
  because it is deterministic + in-transcript.)

- [ ] **M3 — Workflow-spawn → run correlation (time-window, zero false positives).** *(deferred-additive)*
  *Acceptance:* `Workflow` tool_use `{scriptPath,args}` → `recoverProjectPath` on the TRANSCRIPT
  scriptPath → correlate to `wf_*.json` by cached-script basename + `startTime` window; ZERO mis-links
  (null on ambiguity); ≥1 block deep-links into its spawned Run view via `selectedRunId`.

- [ ] **M4 — Opt-in local-LLM summaries (NarrativeEngine, content-addressed cache).** *(deferred-additive, default OFF)*
  *Acceptance:* a consent toggle (default OFF) gates haiku enqueue (no auto-warm). `NarrativeEngine`
  mirrors `ExplanationEngine`; cache key = `sha256(boundary projection + SEGMENT_PROMPT_VERSION)`.
  Reload = zero re-spawn (cache hit); `claude`-absent degrades to the Stage-1 baseline; the planted-secret
  fixture is absent from the prompt handed to the runner.

- [x] ~~M5 — architectural diffs from commits/backups~~ **CUT** (needs its own opt-in + redaction + path
  guard + cache; never read `trackedFileBackups` contents in M0–M4).

## Follow-ups discovered

- Fold the `withRetry` self-heal pattern (used to recover this very plan's run after a socket drop)
  into the saved `.claude/workflows/*.js` so future runs survive transient StructuredOutput failures.
- The narrative feature is itself the strongest dogfood: argus visualizing the session that built argus.

## Notes — OPEN QUESTIONS (user must answer; these gate the grain + M2+)

1. **Segmentation grain:** is real-prompt-boundary (~120 fine-grained blocks, one per thing you asked
   for) the right grain, or do you want coarser topic blocks that merge consecutive same-topic prompts?
   (Merging-by-topic needs the LLM layer = M4.) Confirm ~120 blocks is a useful proof for M0–M1.
2. **"A session" definition:** exactly one `<sessionId>.jsonl` (what M0–M1 deliver) or the stitched whole
   working session across the 15 sibling resume transcripts? Only `d2cfe0e6` owns the 66 `wf_*.json` runs,
   so stitching is real but separable — confirm we defer.
3. **Summarization consent:** is default-OFF explicit opt-in the right bar for conversation content (vs
   `explain.ts` code captions being on by default)?
4. **Git-badge visibility:** acceptable as "commits we could detect" (best-effort, since all commits here
   are `-q` with no stdout SHA), or wait for more reliable detection (correlate to the repo's real `git log`)?
5. **Watch-view badge priority:** which matter most at a glance — spawned-workflow links / commit links /
   files-touched / tool-activity counts? (Drives the card layout + what M0 must compute.)
