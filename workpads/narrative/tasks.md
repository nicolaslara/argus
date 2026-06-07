# narrative — tasks

**Workpad objective.** A third top-level **"Story"** view: **project → sessions-on-a-timeline →
per-session topic blocks** you can **watch** (one-line summary + badges) or **click into** (full
turns) — with workflow runs, git commits, and file changes in context.

**Status.** Plan synthesized 2026-06-07; design options compared (`narrative-design-options` /
`wf_66e1d338-f2b`); refined by user direction. NO code yet. Canonical decisions + the recommended
build stack + the redaction/segmentation specs are in `knowledge.md`.
**Recommended stack: segmentation=B · render=A(DOM) · data=A(+C escape hatch) · redact=A(noop) · summaries=a.**

---

## Roadmap (smallest-provable-first; STOP at the M0–M1 proof for user judgment)

- [x] **M0 — Engine: transcript parse + real-prompt segmentation + the `redact()` seam. DONE 2026-06-07**
  (`build-narrative-m0` / `wf_f8969b40-ba1`, gate-verified in the main loop; commit `92b1997`).
  Real-data smoke on the actual 65.8 MB / 13,430-record session: **126 blocks** (≈ ~120 real prompts),
  parse+segment **1.8 s**, heap 241 MB. +31 tests (625 total); typecheck + lint clean; no-`node:fs`
  invariant holds. (Incremental cursor/sidecar-cache resume is deferred to when M1's server needs it;
  M0 proves the single-pass segmentation + the seam + the image-drop/synthetic-filter correctness.)
  *Proves:* we can parse the real ~67 MB transcript defensively, segment it incrementally (O(n),
  cursor-cached) into real-prompt blocks, and list a project's sessions with time spans — facts only,
  zero LLM, zero off-machine.
  *Build:* pure `packages/adapter/src/transcript.ts` (FileSystemPort) — single-pass cursor scan,
  real-prompt anchors (filter synthetic `isMeta`/`<command`/`Caveat`/tool_result carriers), **long
  responses bounded to head+tail**, sidecar index `.argus/narrative/<sessionId>/index.json`
  (`{startLine,endLine,contentHash,timeRange,recordCount}` + `lastProcessedLine`); 256 KB per-line cap
  before `JSON.parse`; `tool_result.content` allowlisted to text (images dropped). Plus
  `discoverSessions(slug)` → `SessionSummary[]` (start/end span + counts, cheap head/tail read). Plus
  `packages/adapter/src/redact.ts` — `redact(text)` **noop identity** + `RedactionStrategy` iface;
  every preview/turn path routes through it. Contract: `SessionNarrative`, `NarrativeBlock`,
  `SessionSummary`/`ProjectSessions` in `packages/contract/src/narrative.ts`.
  *Acceptance (on `d2cfe0e6`):* emits the session list (spans) + a `SessionNarrative` via unit tests;
  block count ≈ ~120 real prompts; no synthetic text / no image bytes in any preview; an append re-scans
  only from the cursor (test: appending N records re-segments only the tail); parse time + peak memory
  recorded as gates; every preview is `redact()`-routed.

- [ ] **M1 — Story view: project session-timeline + per-session watch/click-in (the core experience).**
  *Proves:* a real project renders as sessions on a timeline; click a session → watch its block
  narrative; click a block → read its full turns — end-to-end, server-cached, zero spend.
  *Build:* `GET /api/projects/:slug/sessions` (the spans) + `GET /api/.../narrative` (Stage-1
  `SessionNarrative`, server pre-computes + disk-caches like `explain.ts`; token+host+path guarded) +
  lazy `GET /api/.../turns?block=`. **Story is a SEPARATE top-level PAGE** (`apps/web/src/session/`,
  its own route + a Workflows↔Story top switch) — NOT a third `ViewMode` toggle on the run canvas;
  it has a wholly different layout. It shows a **session-timeline** (sessions as start→end spans +
  stats) and, on select, a **DOM vertical spine** of block cards (reuse `.agent-shell` CSS); a card
  click lazily loads that block's turns into a text view. Block badges: **clickable commits**
  (→ diff/GitHub) + a **compact, expandable tool-activity** count. Deep-link `?session=<id>&block=<id>`.
  *Acceptance:* the project's sessions render as spans on real data; selecting one shows its ~120 blocks;
  click-in shows real turns; an un-tokened/foreign-Origin call 401s before any FS read.

  **▲ GATE: stop here for user judgment on the proof before M2+.**

- [ ] **M2 — Git-commit linkage by timestamp (+ message).** *(deferred-additive)*
  *Build:* correlate the repo's REAL `git log` (author time + subject) to blocks/sessions by
  time-window + message match (more reliable than `git commit -q` stdout, which carries no SHA);
  GitHub URL only from a fixed `github.com` host + `/commit/<validated-sha>`; subsystem chips by path
  prefix. *Acceptance:* commits map to the right blocks by time; a poisoned-remote fixture yields no
  foreign-host link.

- [ ] **M3 — Workflow-spawn → run correlation (time-window, zero false positives).** *(deferred-additive)*
  *Build:* `Workflow` tool_use `{scriptPath,args}` → `recoverProjectPath` on the TRANSCRIPT scriptPath →
  correlate to `wf_*.json` by cached-script basename + `startTime` window; null on ambiguity.
  *Acceptance:* ≥1 block deep-links into its spawned Run view; zero mis-links.

- [ ] **M4 — Local-LLM summaries (flat per-block, NarrativeEngine).** *(deferred-additive; ON by default; small model)*
  *Build:* mirror `ExplanationEngine` but a **small/fast model**; one call per block on **head+tail**
  input only (the prompt + top/bottom of a long answer — minimize what's sent); cache key =
  `sha256(boundary projection + SEGMENT_PROMPT_VERSION)`; eager background warming, **on by default**
  (privacy is not a gate). *Acceptance:* reload = cache hit; input is bounded head+tail (verified);
  `claude`-absent degrades to the Stage-1 baseline.

- [x] ~~M5 — architectural diffs~~ **CUT** (needs its own opt-in + cache; out of scope).
- [x] ~~M0.5 privacy redactor HARD GATE~~ **REFRAMED** — privacy is not a gate (full-access local tool);
  the `redact()` **noop seam** folds into M0 (placement now, pluggable later).

## Follow-ups discovered
- The `narrative-design-options` synth agent returned a placeholder StructuredOutput (a non-null junk
  payload that `withRetry` doesn't catch) — add a sanity check / re-prompt on suspiciously-empty
  synth output, and fold `withRetry` into the saved `.claude/workflows/*.js`.
- argus visualizing the session that built argus is the strongest dogfood.

## Notes — open questions (status)

1. **Segmentation grain** — *leaning resolved:* fine-grained (~120, one per real prompt) for the proof;
   iterate to coarser topic-merging with the LLM layer (M4) later. (User: "we can do this iteratively.")
2. **What is "a session"** — ✅ RESOLVED: one `<sessionId>.jsonl`, **grouped under a project** and shown
   on a **session-timeline** (start→end spans); not stitched into one mega-session.
3. **Summaries (M4)** — ✅ RESOLVED: additive (not first); when added, **on by default**, a **small
   model**, cached, input = **head+tail only** (the prompt + top/bottom of a long answer).
4. **Git linkage** — ✅ RESOLVED: match commits to the repo's real `git log` by **timestamp (+ message)**;
   commit badges are **clickable → see the commit/diff**.
5. **Badges** — ✅ RESOLVED: **clickable commits are the priority**; **tool-activity** kept **compact +
   expandable**. (Workflow-spawn link → opens the run in the Workflows page.)

**All 5 resolved.** IA also locked: the **Story view is a separate top-level page**, not a `ViewMode`
toggle on the run canvas. The plan is fully pinned; M0 is buildable on the maintainer's go-ahead.
