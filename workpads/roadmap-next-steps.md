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

## Active UI bugs (opened 2026-06-06, user-reported from screenshots)

- [x] **UIBUG-1 — Expand-drawer overlaps neighbouring lanes. FIXED 2026-06-06.** Horizontal
  re-flow added to `expandInstances` (grow host lane WIDTH + shift every top-level node to its
  right by the delta; children ride their lane). Verified on `modal-rust-plan-research` with
  research ×7 + review ×4 BOTH expanded: DOM rects show research drawer [371–618] ⊆ Research
  lane [336–624], review drawer [816–983] ⊆ Review lane [781–989], 0 lane overlaps, 0 drawers
  crossing lanes. +9 unit tests. Below is the original spec.

  When a fan-out expands
  (e.g. research ×7), the instance drawer (`expandInstances`, `overlay-expand.ts`) is
  laid out wider than its host phase lane (N=7 → 3 cols → ~812px ≫ ~300px lane) and
  overflows RIGHT into the adjacent Design/Review lanes. `expandInstances` grows the host
  lane in HEIGHT + shifts same-lane siblings down in Y, but never accounts for the drawer
  being WIDER than the lane (the §2 "X is safe — disjoint ELK bands" assumption). **Fix:**
  horizontal re-flow — grow the host lane's WIDTH to fit the drawer and shift every
  top-level node (lanes + stray markers) to its right by the width delta (analogous to the
  existing vertical grow+shift). Lanes are top-level; their children ride them; spine edges
  are waypoint-free (re-dock free). **Accept:** expanding the ×7 fan shows 0 overlap with
  the next lane (Playwright on `argus-impl-live-card-fill` / modal-rust-plan-research) +
  a unit test (drawer wider than lane → lane width grows, right lanes shift, cards ⊆ drawer
  ⊆ grown lane, drawer.right ≤ nextLane.left).

- [x] **UIBUG-2 — A live/ad-hoc run can't see its own plan (Plan shows a DIFFERENT
  workflow). FIXED 2026-06-06.** New pure `pickPlanSource` discriminator (`plan-correspondence.ts`):
  when the focused run's workflow is not declared, the Plan view renders the per-run PlanModel
  (`runPlan`) instead of `defaultWorkflow`. Verified: selecting the ad-hoc `argus-impl-live-card-fill`
  run → toggle Plan → header names `argus-impl-live-card-fill` (not a default workflow), lanes =
  Fetch hook · Merge · Tests · Gate · Review (same as Run), `6 nodes · AST` from the persisted
  script. +6 unit tests. Below is the original spec.

  Toggling to Plan while watching a run whose workflow has no declared
  `.claude/workflows/*.js` (an inline `script` workflow, e.g. `argus-impl-live-card-fill`)
  falls back to `defaultWorkflow(workflows)` (`App.tsx:490-491`) → a mismatched blueprint.
  The Run view already fetches the correct per-run plan (`runPlanQ`/`fetchRunPlan` — the
  server returns the EXACT persisted per-run script). **Fix:** when the focused run's
  workflowName is not in the declared `workflows` list, the Plan view renders `runPlan`
  (the per-run PlanModel) as the blueprint instead of the mismatched default; enable
  `runPlanQ` in Plan view too; fix `currentWorkflowName`/`hasContent`/captions to follow
  the per-run plan. **Accept:** select the finalized `argus-impl-live-card-fill` run →
  toggle Plan → the SAME 4 phases (Fetch hook · Merge · Tests · Gate) render as a clean
  blueprint, header names the run's own workflow (Playwright) + a regression test.

- [x] **UIBUG-3 — Plan-view loop edges route straight THROUGH the body nodes. FIXED 2026-06-06.**
  Two-part fix in `plan-model-mapping.ts` (+ a `loop-bottom` target handle on `LoopContainer`):
  (A) drop the redundant loop-container→first-body-child `flow` edge (parentId containment
  already signals entry; the post-loop continuation is kept — filter is precise); (B) dock the
  dashed loop-back at the loop's new bottom handle with a bowed `pathOptions.offset` (24, or 34 +
  source `false` vertex when the body ends in a decision — mirrors the run-overlay re-route).
  Verified live: on `argus-view-unification` the solid cross-body line is GONE (`e-flow-8`
  absent, 0 crossers, loop-back bows below the loop) and on `argus-refine-plan` (decision-ending
  body) 0 crossers + loop-back below. +4 unit tests (first to drive the real `planModelToGraph`).
  Found by a 4-phase workflow (diagnose×3 → synthesize → implement → verify). Below is the spec.

  ORIGINAL: On a
  `while`-loop-with-`break` (e.g. `argus-view-unification` Refine phase), the loop renders
  critique → `condition?` → (true→exit loop)/(false→revise), but TWO edges cut straight
  across the body: the SOLID `flow` edge `loop→firstChild` (`e-flow-8`, the loop-entry, from
  `plan.ts walkLoop` doing `flowTo(loopId)` then the first body node's `flowTo`) and the
  DASHED `loop-back` edge `lastBody→loop`. ROOT CAUSE: elk only computes node PLACEMENTS
  (`plan-model-mapping.ts:259` "elk needs only the topology"); React Flow draws each edge
  from the source's default (east/right) handle to the target's (west/left) handle — so an
  edge from the wrapping loop CONTAINER to its left-most child sweeps right→left across the
  whole body. **Fix direction:** suppress/retarget the container→first-child entry edge
  (containment already shows entry) and dock the loop-back through a gutter (bottom/left
  handles) so it bows around the body (cf. the run-overlay `overlay-loop-expand.ts`
  LOOP_GUTTER re-route). Must not regress refine-plan's loop, decisions outside loops, or the
  run-overlay loop drawer. Surfaced by the UIBUG-2 fix (ad-hoc runs now show their own plan).

- [x] **UIBUG-4 — "Round axis vs Lane drawer" toggle reads as a no-op. CLARIFIED + FIXED
  2026-06-06.** Not broken: the loop-drill mode only has a visible effect when the active RUN
  has a loop that ran **>1 round** (→ a round axis to ⊞ unroll + a round pill to click).
  Verified live on the 3-round `argus-view-unification` loop: round-axis → the round's
  instances open in the DetailPanel; lane-drawer → they expand as cards INSIDE the loop (and
  switching to round-axis collapses that drawer). On single-round-loop runs (e.g. the
  `dashboard-design-iteration` run = `wf_d219195d-30d`, loop ran once → `audit:r1` only) there's
  nothing to drill, so it was silently inert. **Fix:** the Settings control now flags itself
  `· inert here` (dimmed + "no multi-round loop to drill in this run…") whenever the active run
  has no drillable loop, so it no longer reads as broken. Manual-validation workflows (loop ran
  >1 round): `argus-view-unification`, `argus-sidebar-redesign`, `capo-workpad-execute`.

- [x] **UIBUG-5/6/7 — three UI issues fixed via a workflow 2026-06-06.**
  (5) **Run-selector dropdown rendered behind the objective band + failure banner** — `.run-selector-drawer`
  (z-6) was trapped in `.run-header`'s z-4 stacking context, beaten by later-in-DOM `.run-chrome` (z-4).
  Fix: `.run-header:has(.run-selector-chip.is-open){z-index:8}` lifts it only while open (still < rail's 10).
  Verified: all hit-test samples down the open drawer land on drawer content.
  (6) **Workflow rail tab hid ad-hoc workflows in an opaque "(other runs)" bucket** while Time/Status named
  every run. Fix: `groupRuns` Workflow lens now emits one named folder per distinct workflowName (declared
  first, then ad-hoc by recency); the catch-all is gone; ad-hoc folders toggle. Verified: every workflow
  (argus-view-unification, argus-sidebar-redesign, …) is now a named, findable group; no "(other runs)".
  (7) **Loop-drill toggle gave no feedback when flipped** — it only governed a round-pill click, so flipping
  the mode stranded an open round. Fix: a pure `migrateLoopDrill` helper carries the open round across the
  switch (round-axis DetailPanel ⟷ lane-drawer in-loop drawer), wired into the mode setter. Verified live on
  the 3-round argus-view-unification loop: flipping round-axis→lane-drawer auto-opened r2's cards in the loop
  with no re-click. +12 tests (280 total). Found + fixed by a 3-phase workflow (diagnose×3 → implement → verify).

## Next steps by theme

### Navigation & scale
- **Group-by lens — Workflow / Time / Status toggle in the Rail** · M · the highest-leverage
  unbuilt nav item (the whole `navigation-and-views-plan.md` is built around it); `Rail.tsx`
  has only the Workflow tree today. Reducers over the same rows; Workflow branch = current
  tree verbatim (zero regression).
- **Staleness / retention** — DONE 2026-06-06. `isStale(start, refNow)` (injected ref time,
  mirrors the timeBucket 7d cutoff) drives age-dimming (`.is-stale` → reduced opacity) on every
  RunRow, and `partitionByRecency` + `RECENT_CAP=5` folds a deep folder's tail under a calm
  "+N older" toggle (validated: argus-implement's 13 runs show 5 + "+8 older"). Pure + tested.
- **Filter / search box** — DONE 2026-06-06. A calm rail filter input (ephemeral, not persisted)
  with pure `filterRuns`/`filterTree` (substring over workflow name + status) that runs AFTER
  grouping so it composes with all three lenses; live runs are never filtered. Validated: "failed"
  narrows ~33 folders → the 3 with failed runs. Age token deferred (name+status covers the need).
- **Pinned / favorite workflows** · S · keep active work on top regardless of recency.

### Live & inspection
- **Eager live-card fill for RUNNING agents** (dur/tok/tools/label from the transcript, on the
  graph cards — not only lazily in DetailPanel) · M · running instances still show em-dashes
  (`AgentCard.tsx`). *Caveat:* gated by transcript persistence (inspect I2 — `agent-<id>.jsonl`
  not always on disk); must degrade to the journal.
- **Harden the SSE client** — DONE 2026-06-06. `App.tsx`'s EventSource now tracks a
  connection state (`connecting`/`open`/`reconnecting`/`lost`) via `onopen`/`onerror`; a calm
  amber/red chip ("reconnecting" / "live paused") in the run-header surfaces a dropped stream
  (the 4s poll backstops it; reverts silent when healthy). **`Last-Event-ID` resume DEFERRED**
  on purpose: it only pays off WITH incremental `RunDelta` events — today a `changed` triggers
  a full model refetch, so EventSource auto-reconnect (server `retry: 3000`) + refetch already
  recovers fully. Build it together with `RunDelta` (below) when scale demands.
- **SSE / `handleStream` test coverage** — DONE 2026-06-06. The token gate (`tokenOk`) +
  DNS-rebinding gate (`hostAllowed`) were extracted to a pure `apps/server/src/auth.ts`
  (index.ts ran `server.listen` on import → untestable); `auth.test.ts` (+11) covers the
  `/stream` 401 cases incl. the EventSource `?token=` query-param path. `handleStream` already
  had open/changed/teardown-on-close tests in `routes.live.test.ts`.
- **No-jump finalize swap** — DONE 2026-06-06. The run query key is now suffix-free (dropped
  the `live`/`final` segment) so a live→finalized transition updates the SAME cache slot in
  place; the structural fit signature (extracted to a pure, unit-tested `fit-signature.ts`,
  +7) excludes instance/drawer ids and keys on view+runId+plan-node-ids — all stable across the
  swap — so finalize no longer re-fits/yanks the viewport. *Live-validation caveat:* unit-tested
  + code-reviewed; the live SSE-chip + finalize-no-jump weren't yet caught on a real
  live→final transition (timing/network-sensitive to script) — validate opportunistically.
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
- **Surface `coverageRatio` / `warnings[]`** in the UI — DONE 2026-06-06. A pure
  `degradation-signal.ts` (warning count/code summary with `×N` dedup, clamped coverage %,
  `isDegraded`) feeds: a calm amber `⚠ N warnings` chip in the run-header (codes in its
  tooltip; full list in the RunOverviewPanel warnings section) and a `⚠ {pct}% parsed` /
  `partial` badge in the plan-header when an AST plan came back degraded. Silent when clean.
  +18 tests (316 total).
- **Decide `clientVersion`** — DONE (resolved 2026-06-06): deleted the dead plumbing. No route
  ever set it and no web source read it, so the "untested format" badge (boundaries §9) could
  never appear. Removed the optional `RunModel.clientVersion` field, the `AdapterContext` /
  `LiveModelOptions` `clientVersion` options + their `!== undefined` guards, and rewrote
  boundaries §9 to state format compatibility is managed by the adapter's defensive parsing +
  the `ADAPTER_FORMAT` pin (reported on `/health`), not by client-version signaling. The `format`
  pin is the real, end-to-end guarantee; the drift badge would have been an absent one.
- **Widen the `node:fs`-free contract test** — ALREADY DONE (verified 2026-06-06). The test
  (`adapter.test.ts:512-524`, arch-review #4) `readdirSync`s EVERY non-test adapter `*.ts` and
  asserts none import `node:fs` — so live.ts/plan.ts/discovery.ts are already guarded.
- **Code-split the elk chunk** — ALREADY DONE (verified 2026-06-06). `loadElkLayout`
  (`layout/index.ts:37`) is an `await import('./elk.ts')` → elk is its own lazy chunk (the
  1.44 MB `elk-*.js`), never in the main bundle. The build warning is advisory only.

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
