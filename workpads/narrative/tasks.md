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

- [x] **M2 — Git-commit linkage by timestamp. DONE 2026-06-08** (`a11be1a`).
  Built via workflow `wf_4071c870-538` (the workflow hit the StructuredOutput-finalization gotcha after
  the impl agent finished — recovered in the main loop: work landed on disk, gate-verified, then a
  FOCUSED adversarial review agent run by hand since the workflow's review phase never fired).
  `apps/server/src/git-commits.ts` — git is a SERVER concern (process spawn mirroring llm/runner.ts;
  injected GitLogReader/GitRemoteReader, never-throw/degrade, bounded log). `correlateCommits` is pure +
  deterministic (author-time ∈ block.timeRange; outside-all dropped; per-block/total caps). SECURITY:
  shortSha `/^[0-9a-f]{7,40}$/`; githubUrl ONLY from a host EXACTLY github.com (URL API + anchored scp
  regex; conservative owner/repo charset) → poisoned/foreign remote → null. Correlated on the way OUT of
  handleSessionNarrative (optional dep; LIVE, never baked into the stat-keyed cache); ARGUS_GIT=0 disables.
  Adapter untouched, cache version not bumped, web unchanged (CommitChip already rendered gitCommits).
  Tests +37 (incl. the poisoned-remote set); 740 green. LIVE on real d2cfe0e6: 46/72 blocks, 138 commits,
  all `https://github.com/nicolaslara/argus/commit/<sha>`. Adversarial review (25 vectors + 200k fuzz): SOUND.

- [ ] **M3 — Workflow-spawn → run correlation (time-window, zero false positives).** *(deferred-additive)*
  *Build:* `Workflow` tool_use `{scriptPath,args}` → `recoverProjectPath` on the TRANSCRIPT scriptPath →
  correlate to `wf_*.json` by cached-script basename + `startTime` window; null on ambiguity.
  *Acceptance:* ≥1 block deep-links into its spawned Run view; zero mis-links.

- [~] **M4-prep — the `llm/` module (DONE 2026-06-08).** All model-facing code consolidated into
  `apps/server/src/llm/`: `runner.ts` (the ONE place to swap model/flags/timeout — `LLM_MODEL`),
  `prompts/caption.ts` (node captions) + `prompts/panel.ts` (sub-UI/describe) — each its own file with
  its version + parser. `explain.ts`/`subui.ts` are now thin ENGINES that consume `llm/` (re-exporting
  for back-compat; all gates green). M4's summary prompt = a new `llm/prompts/summary.ts` + a small engine.
  *Follow-up:* dedupe the content-addressed disk cache (explain + subui copies) into `llm/cache.ts`.

- [x] **M4 — Local-LLM per-block summaries. DONE 2026-06-08** (`52a779c`; smoke-test-timeout fix `d33e5f0`).
  Built via workflow `wf_757e2c8f-d48`; gate-verified in the main loop (703 tests), both adversarial-review
  findings addressed (key/prompt topicLabel normalization; word-boundary pattern cap). LIVE on real
  `d2cfe0e6` (72 blocks): cold ~18.9s → an accurate caption/body/intent/pattern, warm 0.02s cache hit.
  `llm/prompts/summary.ts` (sum-v1, HEAD+TAIL-only input) + `NarrativeSummaryEngine` (mirrors SubUiEngine;
  `.argus/cache/narrative-summaries/`) + `GET .../blocks/:blockId/summary` (reuses the stat-keyed narrative
  cache; optional dep → null when absent) + StoryPage IntersectionObserver-gated lazy fetch. UI renders
  caption + body (intent/pattern in the contract for later badging).
  **Architecture (locked 2026-06-08, per user):**
  - **LLM never blocks segmentation.** The narrative returns blocks as today (fast + disk-cached);
    summaries are a SEPARATE async layer (mirror the `ExplanationEngine` poll pattern) fetched/polled
    after the blocks render. Parse and LLM are decoupled.
  - **Trigger = LAZY / on-demand (FE-driven), NOT eager-all.** Generate a block's summary when the FE
    asks (block in view, or a "✨ summarize" affordance), cached so it's one-time. A session has ~60+
    blocks; eagerly summarizing all (most never read) is the slow/costly path to avoid. (Supersedes the
    earlier "on by default / eager warming" framing.)
  - *Related (separate):* the LIVE session re-segments the whole file on each append — the deferred M0
    cursor-resume (incremental parse) — so a growing session isn't re-parsed wholesale. Not a blocker for M4.
  *Build:* `llm/prompts/summary.ts` (head+tail input only — the prompt + top/bottom of a long answer);
  a small summary engine (lazy, cached, content-addressed); a poll/per-block endpoint. *Acceptance:*
  blocks render instantly (no LLM wait); a requested summary caches (reload = hit); input is bounded
  head+tail (verified); `claude`-absent degrades to the Stage-1 baseline.

- [x] ~~M5 — architectural diffs~~ **CUT** (needs its own opt-in + cache; out of scope).
- [x] ~~M0.5 privacy redactor HARD GATE~~ **REFRAMED** — privacy is not a gate (full-access local tool);
  the `redact()` **noop seam** folds into M0 (placement now, pluggable later).

## Follow-ups discovered
- **LLM runner latency (measured 2026-06-08).** `claude -p` for the summaries is ~16s on haiku, and
  haiku is SLOWER than sonnet (~14s vs ~3.7s api) because it over-generates inside the full CC agent
  harness (~1400-2035 out-tok vs ~110). Breakdown: ~3.3s fixed spawn/CLI overhead + a ~17-26K-token
  harness system prompt on every call (MCP-off doesn't help) + output-token-dominated generation. FIX:
  add an API/SDK-based `ClaudeRunner` (tools off, one-line system prompt, `max_tokens≈150`) → ~1-2s,
  env-gated behind the existing seam with the CLI runner as the zero-config/subscription fallback.
  Tradeoff = auth (subscription vs `ANTHROPIC_API_KEY`, ~$0.001/summary). AWAITING user go-ahead.
  (ACP/persistent-agent amortizes only the ~3.3s, not the harness/output cost.)
- The `narrative-design-options` synth agent returned a placeholder StructuredOutput (a non-null junk
  payload that `withRetry` doesn't catch) — add a sanity check / re-prompt on suspiciously-empty
  synth output, and fold `withRetry` into the saved `.claude/workflows/*.js`.
- argus visualizing the session that built argus is the strongest dogfood.

### Story-view UI polish (DONE 2026-06-08, user-requested)
- [x] **Surface `AskUserQuestion` in the narrative.** `TurnToolCall.ask` (adapter `extractAskQuestions`,
  bounded + redact()-routed) → `StoryPage` `AskBlock` renders the question + header + options inline;
  the chosen answer shows naturally in the following user turn. Verified on the real rail-design
  question (`f1f1136`).
- [x] **Clickable workflow spawns → open the run.** `matchSpawnToRun` (web, `spawn-match.ts`) resolves a
  spawn → run by the **timestamp window + uniqueness** (run `startTime` === the spawning tool_use ts,
  observed Δ=0 ms; zero false positives). The `WorkflowSpawnChip` becomes a clickable link (↗) when
  resolvable → App selects the run + switches to the Workflows page. **15/16 spawns clickable** on the
  real argus session; navigation verified (lands on the right run).
  *Note:* this is the **M3** correlation, done CLIENT-SIDE (the web already has the runs with
  `startTime` + the spawns with `timestamp`) — name-matching is impossible (one template script,
  differently-named runs), so timestamp is the only reliable join. No adapter/server/cache change.

- [x] ~~**M3 — Workflow-spawn → run correlation**~~ **DONE (client-side)** — see above; supersedes the
  adapter-side `wf_*.json` basename plan (basenames don't match meta.names; timestamp is exact).

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
