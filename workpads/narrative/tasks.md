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

- [x] **M1 — Story view: project session-timeline + per-session watch/click-in (the core experience). DONE 2026-06-08**
  Server (`9976b42`/`2266f95`): `GET /api/projects/:slug/sessions` + `GET /api/.../narrative`
  (disk-cached like `explain.ts`, token+host+path guarded) + lazy `GET /api/.../turns?block=`.
  Web (M1b, this change): **Story is a SEPARATE top-level PAGE** (`apps/web/src/session/StoryPage.tsx`)
  behind a **Workflows↔Story top switch** wired into `App.tsx` (`topView` state gates the whole canvas
  chrome) — NOT a `ViewMode`. Three levels: a **session-timeline** column (start→end spans + stats),
  a **DOM block spine** (cards: clamped prompt/response previews + tool badges + workflow-spawn chips +
  commit chips), and a **lazy turns drawer** (click-in). `redact()`-routed, text-node only.
  *Verified LIVE on the real argus session `d2cfe0e6`* (proxy `:5173` → server `:4317`, token-injected):
  the 15 argus sessions render as spans; selecting → **64 real-prompt blocks**; clicking block 1 →
  **133 turns** render with **zero console errors**; switching back to Workflows restores the canvas
  with no regression. An un-tokened direct `:4317` call 401s (proxy injects the bearer). Screenshots in
  `.argus/shots/` (gitignored). Tests: 672 green (+3 adapter cases); typecheck + lint + build clean.

  **▲ GATE: stop here for user judgment on the proof before M2+.**

  **M1b refinements (found + fixed while verifying on real data — all kept):**
  - **Synthetic filter widened.** `<task-notification>` (×58 on `d2cfe0e6`), `[Request interrupted…]`
    (×2), and the compaction handoff summary (×5) leaked past the original `isRealUserPrompt` filter
    and falsely anchored blocks → added to `SYNTHETIC_PREFIXES`. They're now also dropped from block
    ACCUMULATION (no preview pollution, no turn-count inflation), and an all-preamble **empty
    session-start shell is suppressed** → **130 → 64 noise-free blocks**, block 1 = the real first prompt.
    Cache busted via `NARRATIVE_CACHE_VERSION` `narr-v1`→`narr-v2`.
  - **Default + sort by ACTIVITY, not start.** A 94 h still-active session that *started* earliest was
    buried at the list bottom and a trivial 8-record throwaway was the default pick. Now ordered +
    default-selected by `end ?? start` desc (`sessionActivityMs`) → lands on the meaningful session.
  - **Turns drawer key bug.** `key={t.promptId}` collided (promptId is the *originating prompt's* id,
    shared across a block's records) → 131 React "duplicate key" errors, risking omitted rows. Keyed on
    the positional index → 0 errors, all 133 turns render.
  - **Watch-view legibility.** The card response preview dumped the full ~16 KB head+tail → CSS
    line-clamp (prompt 4 / response 3 lines); the full text stays one click away in the turns drawer.

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

### Story-view UI polish (queued 2026-06-08, user-requested)
- **Surface `AskUserQuestion` in the narrative.** A turn that is an `AskUserQuestion` tool call (and
  ideally the user's chosen answer) should render the QUESTION + OPTIONS inline in the Story turns,
  not a bare/collapsed tool row — these are the decision points of a session. Special-case the
  tool-call renderer in `StoryPage` (read `input.questions[].{question,header,options[].{label,
  description}}` from the tool_use; pair with the following user/tool_result answer when resolvable).
- **Clickable workflow spawns → open the run.** The `WorkflowSpawnChip` (⧉ `<script>.js`) should be a
  link/button that navigates straight into that run in the Workflows page (select the run + switch
  `topView` to 'workflows'). Needs the **M3 spawn→run correlation** (Workflow tool_use `{scriptPath,
  args}` → `wf_*.json` by cached-script basename + startTime window) to resolve the `runId`; until
  M3 lands, the chip stays inert. This is the concrete payoff that motivates M3.

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
