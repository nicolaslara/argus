# narrative — knowledge

Canonical decisions for the **Session Narrative** feature: a third top-level "Story"
view that follows one Claude Code session as a vertical timeline of **topic blocks**
you can **watch** (one-line summary + badges) or **click into** (full turns).

> ## ⟐ Refinements (user direction, 2026-06-07) — SUPERSEDE the earlier framing below
> These override the corresponding earlier sections; a full rewrite folds them in once the
> `narrative-design-options` workflow (`wf_66e1d338-f2b`) lands its build comparisons.
>
> 1. **Privacy is NOT a gate.** argus is a full-access LOCAL tool. The old "M0.5 hard privacy
>    gate" is replaced by a **reusable `redact()` utility SEAM**: every emitted text path
>    (previews, click-in turns, future LLM input) flows through ONE `redact(text)` — a **noop
>    (identity) today**, **pluggable later** (a simple pw/API-key regex redactor, or a diff/
>    entropy scanner). The value now is the SEAM PLACEMENT so adding a real redactor later is a
>    one-line swap. Nothing is blocked on it.
> 2. **Segmentation is INCREMENTAL · CACHED · HEURISTIC (never LLM-on-bulk).** A single-pass
>    **O(n)** scan with a **cursor at the last-processed record** — only NEW tail records get
>    processed as a session grows; already-segmented ranges are **cached by record-index range**
>    (a sidecar index file now; a DB is a future option). Split heuristic is deterministic
>    (anchor on real-user-prompt boundaries; **bound long responses to head+tail** so we never
>    hold/emit a whole giant response). An LLM **never** sees the 60 MB — only bounded per-block
>    input, opt-in (a future milestone). Escape hatch if the single pass is slow: a faster
>    language (Rust) or a simpler heuristic — not loading less-correctly.
> 3. **A session = ONE `<sessionId>.jsonl`** (confirmed) — but sessions are **grouped under a
>    PROJECT** and the Story view gets a **project-level session-timeline**: each session as a
>    **start→end span** (first/last record timestamp) + stats (records · workflows spawned ·
>    commits). Click a span → that session's per-session block narrative. New top level:
>    **project → sessions-on-a-timeline → per-session blocks.** (NOT stitched into one
>    mega-session — shown together with their real time spans. Resolves open-question "what is a
>    session".) Needs a cheap `discoverSessions(slug)` (head/tail timestamp per file) + a
>    `SessionSummary`/`ProjectSessions` contract type.
> 4. **Git commits matched by TIMESTAMP (+ optionally message).** Correlate the repo's REAL
>    `git log` (author time + subject) to blocks/sessions by time-window + message match — more
>    reliable than transcript-stdout SHAs (all commits here are `git commit -q`). Commit badges are
>    **clickable → open the commit/diff**. Refines M2.
> 5. **The Story view is a SEPARATE top-level PAGE**, not a third `ViewMode` toggle on the run canvas.
>    Its own route + a Workflows↔Story top switch; a wholly different layout (project session-timeline
>    + block spine, not a graph). A spawned-workflow badge deep-links BACK into the Workflows page's
>    Run view. (Supersedes the earlier "ViewMode gains 'session' toggle" framing.)
> 6. **Summaries (M4) are ON by default** (privacy is not a gate) — but a **small/fast model**, **cached**
>    (boundary-keyed), and fed **minimal input**: only the block's head+tail (the prompt + top/bottom of a
>    long answer). (Supersedes the earlier "default OFF / explicit opt-in" framing.)
> 7. **Badge priority:** **clickable commits first** (the headline ask), then a **compact + expandable
>    tool-activity** count; the workflow-spawn link opens the run. Drives the M0 segmenter's computed fields.

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

---

## Design options & recommended build stack (2026-06-07)

From the `narrative-design-options` workflow (`wf_66e1d338-f2b`): 5 build dimensions, each with
2–4 comparable options (pros/cons/effort/risk). (Its synth agent returned a placeholder payload —
a known StructuredOutput failure mode — so the stack below was synthesized in the main loop from
the real per-dimension option sets.) **Picks:**

| Dimension | Options compared | **Pick** | Why |
|---|---|---|---|
| **Segmentation engine** | A real-prompt-only · **B real-prompt + head/tail-bounding** · C +secondary sub-splitters · D SQLite cache | **B** [S/low] | Incremental O(n) cursor scan + sidecar index; head/tail bounding means we never hold/emit the 2 MB response; A's simplicity, future-safe. (C's strategy flag and D's DB are deferred.) |
| **Story-view rendering** | **A DOM vertical spine** · B React Flow time-lane · C hybrid | **A** [S/low] | A timeline is a linear vertical read; reuse the `.agent-shell` dark cards; no ELK/canvas overhead; fastest to the proof. |
| **Data flow / locus** | **A server pre-compute + disk cache** · B client parses 67 MB · C incremental-since-cursor | **A**, with **C** as the escape hatch [M/low] | Simplest endpoint, mirrors the `explain.ts` cache seam; B (67 MB to the browser) is a non-starter. Because segmentation (B above) is already cursor-incremental, the cache refresh on append re-scans only the tail — C's benefit without C's upfront cost. |
| **Redaction seam** | **A dedicated `adapter/redact.ts` + RedactionStrategy** · B extend `redactInternalPaths` w/ drivers · C thread via AdapterContext | **A** [M/low] | One text→text chokepoint, mirrors `error-redaction.ts`'s `scrubError`; **noop today**, a regex/diff redactor is a one-line strategy swap later; keeps `makePreview` pure (no param threading like B/C). |
| **Summaries** (future, opt-in) | **a flat per-block** · b hierarchical · c on-demand-only | **a** [M/med] | Identical to `explain.ts` (lowest risk); bounded head+tail input; cache key = boundary projection so reload/append re-summarizes only changed blocks; eager background warming. |

**Recommended stack = B · A · A(+C) · A · a**, plus the two structural additions from user
direction (see the Refinements blockquote at the top): a **project session-timeline** top level,
and **git-commit matching by timestamp (+ message)** against the repo's real `git log`.

### The `redact()` seam (the spec)
`packages/adapter/src/redact.ts` exports `redact(text: string): string` (+ a `RedactionStrategy`
interface). **Today it is the identity function (noop)** — nothing is gated. EVERY emitted text
path routes through it: `promptPreview`, `responsePreview`, click-in turn text, and (future) the
bounded input to `claude -p`. Later, swap the strategy for a regex redactor (`sk-`/`ghp_`/`AKIA`/
`bearer`/`token=`/`.env` patterns + `/Users/<home> → ~`) or a diff/entropy scanner — a one-line
change at the seam, no re-threading. Mirrors the existing single-chokepoint `error-redaction.ts`.

### The incremental segmentation (the spec)
Single-pass **O(n)** scan of the JSONL via `FileSystemPort`; a **cursor** (`lastProcessedLine`) in a
**sidecar index** (`.argus/narrative/<sessionId>/index.json`) keyed by record-line ranges
`{startLine,endLine,contentHash,timeRange,recordCount}`. Cut points = **real-user-prompt boundaries**
(filter synthetic `isMeta`/`<command`/`Caveat`/tool_result carriers). Long assistant responses are
**bounded to head+tail** (e.g. 8 KB each) in the preview — never held in full. On append: re-scan
from the cursor to EOF, invalidate only the final (now-longer) block, emit only new blocks. 256 KB
per-line cap before `JSON.parse`; `tool_result.content` allowlisted to text (images dropped). DB
(SQLite) is a deferred option only if the sidecar gets slow on huge/very-many sessions.
