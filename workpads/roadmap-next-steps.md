# argus — roadmap / potential next steps

Synthesized from three surveys (product phases · deferred design items · architecture),
cross-checked against shipped code. Items the surveys flagged that are **already done** are
noted so we don't re-do them.

## Where we are

All six workpad gates are met. Shipped: the merged **Run view** (plan painted with a run,
fan-outs expand in place, card result previews), the **blueprint Plan** + a **run-history**
band (Plan-as-overview) + a **run-selector**, the **failure + live inspector** (why/how/
when/where + a transcript-fed activity drill + transcript-reader), **chip-degrade** for big
fans, and **loop/tournament drilling** with two modes (round-axis · lane-drawer) behind a
**settings toggle**. README refreshed.

**Already done since the architecture review** (don't re-list): bearer-token print is gated
behind `ARGUS_PRINT_TOKEN` (`index.ts:324`); `elk.layout()` has an 8s `Promise.race` timeout
(`elk.ts:62,157`); the NOW `nowRunning` chip is rendered (`App.tsx:1053`); the run/plan merge,
expand-instances, ghost upcoming row, `+N more`, run-selector, failure ring, loop drill, and
the transcript-reader (the design-plan "LATER" stack) all shipped.

## Next steps by theme

### Navigation & scale
- **Group-by lens — Workflow / Time / Status toggle in the Rail** · M · the highest-leverage
  unbuilt nav item (the whole `navigation-and-views-plan.md` is built around it); `Rail.tsx`
  has only the Workflow tree today. Reducers over the same rows; Workflow branch = current
  tree verbatim (zero regression).
- **Staleness / retention** (recency-windowed default + age-dimming + `+K older` fold) · M ·
  the "old runs make the tree messy" problem (sidebar §2d) — argus is an activity tool, not a
  database browser. Pure Rail; applies before grouping.
- **Filter / search box** (name · status · age) · M · the real escape hatch at hundreds of runs.
- **Pinned / favorite workflows** · S · keep active work on top regardless of recency.

### Live & inspection
- **Eager live-card fill for RUNNING agents** (dur/tok/tools/label from the transcript, on the
  graph cards — not only lazily in DetailPanel) · M · running instances still show em-dashes
  (`AgentCard.tsx`). *Caveat:* gated by transcript persistence (inspect I2 — `agent-<id>.jsonl`
  not always on disk); must degrade to the journal.
- **Harden the SSE client** (`onerror`, client backoff, `Last-Event-ID` resume, a "connection
  lost" surface) · M · `App.tsx` EventSource has none today.
- **SSE / `handleStream` test coverage** · M · the live stream (watch teardown, debounce,
  token-gating) has zero tests; cheapest slice = a `/stream` 401 test.
- **No-jump finalize swap** · M · the `/live`→finalized `/run` flip should swap nodes in place
  without a layout jump (live workpad L5).
- **Agent transcript view** (full session timeline) · M · *blocked* by I2 data reality;
  candidate: capture transcripts live during a run to unblock.
- **Incremental SSE deltas (`RunDelta`)** · L · today the client refetches the whole model on
  each `changed`. Correct for ≤14 agents — keep the contract seam, implement only at scale.

### Canvas views (deferred, evidence-gated)
- **Timeline / Gantt view** · L · the one question the DAG can't answer (duration / critical
  path); a 2nd renderer over the same `RunModel`. Gate on someone actually asking it.
- **Table panel** (sortable/filterable agent grid) · M · best at-scale scanning; a bottom panel.
- **`normalizeLaneBaseline`** one-time pass · S · the subtle "no baseline jump on first expand"
  polish (run-view-merge-plan LATER).

### Architecture & honesty
- **Surface `coverageRatio` / `warnings[]`** in the UI · M · the adapter computes them but
  nothing in `apps/web` reads them, so a half-resolved / dropped-phase run shows no degradation
  signal (silent degradation).
- **Decide `clientVersion`: wire the drift badge or delete the dead plumbing** · M · no route
  sets it, so the "untested format" badge (boundaries §9) never appears — stop shipping an
  absent guarantee.
- **Widen the `node:fs`-free contract test** to `live.ts`/`plan.ts`/`discovery.ts` · S · today
  it guards only `index.ts`+`raw.ts`, so a future `node:fs` import elsewhere passes silently.
- **Code-split the elk chunk** (1.44 MB > Vite's 500 kB warning) · S · lazy-load the layout
  engine.

### Product model (design-only, needs a call)
- **Option B — drop the Plan/Run toggle, let selection drive it** (workflow → blueprint, run →
  painted) · M · the cleaner navigation model we parked after shipping Plan-as-blueprint.
- **Packaging / distribution** (desktop or hosted web app) · L · how argus ships beyond
  `npm run dev`.

## Top 5 if I had to pick
1. **Group-by lens** (M) — the biggest unbuilt nav win; everything else in nav hangs off it.
2. **`coverageRatio` / `warnings` surfacing** (M) — honesty; today degradation is invisible.
3. **Eager live-card fill for running agents** (M) — makes a *running* run legible (a repeated
   ask), degrading to the journal.
4. **Harden + test the SSE live path** (M) — the live story is brittle + untested.
5. **Staleness/retention + filter** (M) — keeps the tree usable as run counts grow.

Cheap quick-wins to fold in alongside: widen the fs-free test (S), `clientVersion` decision
(M), elk code-split (S), `normalizeLaneBaseline` (S).
