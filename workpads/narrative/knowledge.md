# narrative — knowledge

Canonical decisions for the **Session Narrative** feature: a third top-level "Story"
view that follows one Claude Code session as a vertical timeline of **topic blocks**
you can **watch** (one-line summary + badges) or **click into** (full turns).

Grounded by the `explore-session-narrative` workflow (run `wf_4e4d6d47-f83`,
2026-06-07): 5 parallel research agents → 1 design → 3 adversarial reviews → synthesis.
The reviewers inspected the **real** 64–67 MB transcript and overturned two of the
design's "verified" premises — those corrections are baked into the locked decisions
below. Confidence: **high** on the data facts (probed on real records); **medium** on
segmentation *quality* (the one genuine product risk — validate in M0, judge after M1).

---

## Verified data facts (probed on the real transcript)

Transcript: `~/.claude/projects/-Users-nicolas-devel-argus/<sessionId>.jsonl` (a SIBLING
file to the `<sessionId>/` dir, not inside it). For this session: ~64–67 MB, 12,865
JSONL records, 9,720 timestamped.

- **Record `type` values**: assistant 5560, user 2721, attachment 801, ai-title 665,
  last-prompt 666, mode 666, permission-mode 666, system 360, queue-operation 278,
  bridge-session 303, file-history-snapshot 179. (11 types — the parser MUST enumerate
  all with a default drop-with-warning branch.)
- **Turn shape**: user/assistant records carry `timestamp` (ISO), `promptId` (UUID),
  `message:{role, content:[…]}`. Assistant `content[]` holds `text`/`thinking`/`tool_use`
  blocks; tool results come back on the FOLLOWING user record as `tool_result` blocks.
- **`tool_result.content` is a LIST 880/2600 times** (not a string) — 140 carry Playwright
  **screenshots** (base64 images), 722 text, 38 `tool_reference`. ⇒ parse `content` as
  `string | block[]`, allowlist ONLY `{type:'text'}.text`, DROP image/tool_reference with
  a counted warning. **No image bytes may ever reach a NarrativeRecord, the wire, or an LLM prompt.**
- **Only ~120 REAL user prompts** hide among the 2,721 user records — the rest are
  `tool_result` carriers (2,600) + ~13 synthetic (`isMeta`, text starting with
  `<command`/`<local-command`/`Caveat`). Filtering synthetic user records is **the single
  most load-bearing parse rule.**
- **`tool_use` names**: Bash 751, Read 424, Edit 413, Workflow 70 (the launches!),
  Write 86, Playwright `browser_*` (many).
- **Workflow launch shape**: `{type:tool_use, name:'Workflow', input:{scriptPath, args}}`.
  `scriptPath` is under `.claude/workflows/` ⇒ `recoverProjectPath()` works on it.
- **`/Users/` appears on 9,660 lines**; a 2 MB max line exists; 45 lines exceed 256 KB.
- **Git commits**: 120 in-session, ALL use `git commit -q` (zero stdout SHA); SHAs surface
  only via ~53 separate `git log` dumps ⇒ commit linkage is inherently **best-effort**.

## What argus already has (reuse these seams)

- **Adapter behind `FileSystemPort`** (`packages/adapter`): `loadRun`/`parseFinalizedRun`
  (pure, no `node:fs`), `recoverProjectPath(scriptPath)`, the defensive-parse + format-pin
  posture (`ADAPTER_FORMAT`). New transcript parsing lives here, the same way.
- **`explain.ts` cached-LLM pattern** (`apps/server`): content-addressed
  `sha256(stable projection)+PROMPT_VERSION → .argus/cache/<hash>.json`, graceful degrade
  when `claude` is absent. The narrative summarizer mirrors this exactly.
- **Server security envelope**: `tokenOk` + `hostAllowed` + `resolve()`-inside-`claudeHome`
  path guards + per-launch bearer token. All new routes inherit it explicitly.
- **Web shell**: `ViewMode = 'plan' | 'run'` toggle (App.tsx); the rail; the dark palette /
  4px grid / mono-id / 3px-left-border card language. The Story view reuses all of it.

---

## Locked decisions

1. **New on-disk surface stays behind the adapter.** A new pure `packages/adapter/src/transcript.ts`
   (no `node:fs`, `FileSystemPort`-injected like `loadRun`). New types in
   `packages/contract/src/narrative.ts` (re-exported). Web imports ONLY `@argus/contract`.
   New `NARRATIVE_FORMAT = 'cc-transcript/observed-2026-06-07'` pin, reported on `/health`.
2. **`tool_result.content` parsed as a defensive `string | block[]` union.** Project only
   `{type:'text'}.text`; drop image/`tool_reference` with a counted `AdapterWarning`. Verified
   by a parser test that asserts zero image bytes reach any `NarrativeRecord`.
3. **Cut points anchor on the REAL-USER-PROMPT boundary** — NOT Workflow-launch / time-gap /
   file-set (those over-segment: 72 spawns vs 66 runs). A block = `[one real user prompt] →
   [all assistant work + tool calls + spawned workflows + commits until the next real prompt]`.
   The adapter FILTERS synthetic user records (isMeta / `<command` / `<local-command` / `Caveat`
   / tool_result carriers). Time-gap/file-set become optional *sub*-splitters later.
4. **A genuine redactor is built and gated BEFORE anything renders (M0.5).** The shipped
   `redactInternalPaths` only strips `/$bunfs/` — NOT `/Users/` (9,660 lines). The new redactor
   strips `/Users/<home> → ~` and pattern-redacts `sk-`/`ghp_`/`AKIA`/`bearer`/`token=`/
   `password=`/`.env`-style assignments. Applied to `promptPreview`, `responsePreview`, click-in
   turn text, AND any text sent to `claude -p`. A planted secret must be absent from the wire,
   `/turns`, logs, and any prompt string.
5. **Whole-file read is accepted (with a measured gate).** `FileSystemPort` has only `readFile()`
   (no range/tail read) — the design's "tail-buffered parse" is NOT achievable. M0 does the 67 MB
   string read + line-split, applies a 256 KB per-line byte cap BEFORE `JSON.parse` (coded warning),
   and **measures parse time + peak memory as an explicit acceptance gate**. No disk segment-cache
   until a measured reload is too slow.
6. **Run linkage recovers the project from the TRANSCRIPT scriptPath**, not the persisted
   `wf_*.json` header (whose cached scriptPath is under `…/workflows/scripts/`, where
   `recoverProjectPath` does NOT work). Correlate transcript-spawn → `wf_*.json` by cached-script
   basename + `startTime` window; **return null on ambiguity, never guess** (zero false positives).
7. **Git-commit linkage is best-effort and off the critical path.** Count a SHA only when adjacent
   to a recognizable commit-success line; validate `shortSha` against `/^[0-9a-f]{7,40}$/`; build the
   URL only from a fixed `github.com` host + `/commit/<validatedSha>` (no free-form remote parsing —
   prevents link-injection from untrusted stdout); render the subject as a TEXT node, never link text.
8. **LLM summarization is GATED behind explicit per-session opt-in (default OFF).** M0–M3 deliver a
   real narrative with ZERO model spend. When enabled it reuses the `explain.ts` engine pattern;
   cache key = `sha256(boundary projection: recordStart/end + start/end time + SEGMENT_PROMPT_VERSION)`
   — hashing the BOUNDARY, not content, so appending re-summarizes only boundary-changed blocks.
   This is the ONE place the privacy stance diverges from `explain.ts`'s default-on code captions.
9. **M5 (architectural diffs) is CUT** from this design. `file-history-snapshot.trackedFileBackups`
   (full paths + backup files holding file CONTENTS) is NEVER read in M0–M4; `filesTouched` is
   basenames-only and the file-set signal needs only a changed-count.
10. **Scope is a PROOF first**: M0 + M0.5 + M1 is the shippable proof (parse + real-prompt segment +
    redactor + Story toggle/watch/click-in on the real session). **Stop there for user judgment**
    before building the LLM engine, run correlation, or git linkage. "A session" = ONE
    `<sessionId>.jsonl`, honestly labeled; multi-resume stitching across the 15 sibling sessions is deferred.

---

## Data model (contract — `packages/contract/src/narrative.ts`)

- `SessionNarrative = { sessionId, projectPath, timeRange:{start,end}, totalRecords, blocks:
  NarrativeBlock[], format, incomplete:boolean, warnings: AdapterWarning[] }`
- `NarrativeBlock = { id (hash of recordRange+timestamps), recordRange:{start,end},
  timeRange:{start,end}, topicLabel:string|null, cutReason:'prompt'|'session-start',
  turnCount, toolCounts: Record<string,number>, workflowSpawns: WorkflowSpawn[],
  gitCommits: GitCommitRef[], filesTouched: string[] (basenames), promptPreview: Preview,
  responsePreview: Preview, summary: NarrativeSummary|null }`
- `WorkflowSpawn = { runId, scriptBasename, timestamp, argsDigest }`
- `GitCommitRef = { shortSha, subject, timestamp, githubUrl:string|null, subsystems:string[]|null }`
- `NarrativeSummary = { caption, body, intent, pattern:string|null, promptVersion }` (mirrors
  `NodeExplanation`; null when baseline)
- `Turn` (click-in only, fetched lazily, never in the block list) `= { promptId, timestamp, role,
  textPreview: Preview, toolCalls:[{name, briefArgs}] }`. All previews reuse the existing
  truncated `Preview {text, truncated}` so the wire never carries full bodies in the watch view.

## Rejected / corrected options

- ❌ "tool_result.content is always a string" (design premise) — FALSE: list 880×. Corrected to union.
- ❌ Three coequal deterministic cut rules (Workflow-launch / time-gap / file-set) — over-segments;
   replaced by the single real-prompt anchor.
- ❌ "Stream/tail-buffered parse" — impossible through `FileSystemPort`; replaced by measured full read.
- ❌ `recoverProjectPath` on the persisted `wf_*.json` scriptPath — wrong layout; use the transcript scriptPath.
- ❌ Default-on summarization (like `explain.ts`) — conversation content is more sensitive; opt-in instead.
- ❌ M5 architectural-diffs in-scope — cut; needs its own opt-in + redaction + path-guard pass.

## Open questions (for the user — see tasks.md)

Carried verbatim into `tasks.md` Notes; they gate M2+ and the segmentation grain.
