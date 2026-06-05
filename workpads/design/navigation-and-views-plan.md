# Navigation + Canvas Views — Converged Design + Phased Plan

> Status: **DESIGN-ONLY** — a plan to be approved, not code to write now.
> Scope: the sidebar (Rail) navigation model and the main-canvas view-types, and how they interact.
> Grounded in shipped code: `apps/web/src/App.tsx`, `apps/web/src/shell/Rail.tsx`, `apps/web/src/shell/format.ts`, `apps/web/src/layout/elk.ts`, `apps/web/src/overlay.ts` / `overlay-paint.ts`, `apps/web/src/nodes/`, `packages/contract/src/index.ts`.

---

## 1. Decision summary

argus has **three orthogonal axes** that the design works only by keeping separate: *which run?* (sidebar **selection**), *how do I organize runs to find one?* (sidebar **group-by lens**), and *what is true about the selected run?* (canvas **view**). We ship a single new finding aid — a `Workflow | Time | Status` group-by toggle in the Rail, with **Workflow = today's tree verbatim (zero regression)** and a pinned **NOW band** constant across all groupings — and we add a thin always-present **NOW status strip** to the canvas chrome. We add **zero new canvas view modes**: the shipped `Plan / Progress / Execution` triad stays, and **Progress already _is_ the live "Activity" view** (running runs already route to `overlay` at `App.tsx:376`, painted with live state via `paintOverlay(..., run.incomplete)` at `:278`). The sidebar lens never touches the canvas view — they interact through exactly one wire: the selected `RunRef`. Timeline, a sortable Table panel, and `groupBy` persistence are deferred behind an evidence gate; a separate "Activity" canvas mode, contextual auto-pick state machines, Gantt, swimlane-as-view, and story-digest-as-mode are cut permanently.

---

## 2. The converged design

### 2a. Sidebar (the finding aid)

A single 3-way **segmented control** at the top of the explorer panel — `Workflow · Time · Status` — that re-buckets **the same run rows** into different `TreeNode[]`. It is a lightweight view over one list, not three lists, which is what keeps it low-state.

- **Workflow** (default) = today's `tree` memo, **byte-for-byte** (`Rail.tsx:82-111`). Runs nested under their declared workflow like files in a folder. Zero regression — this is the literal current code path.
- **Time** = the same finished runs re-bucketed into collapsible `Today / Yesterday / This week / Older` (reuse `formatRelativeTime` from `shell/format.ts`). Because the workflow is no longer implied by the parent, run rows show the workflow name again — add an optional `showWorkflowName` prop to `RunRow`.
- **Status** = the same finished runs bucketed into `Failed / Completed`. (Running runs are **not** in the tree — they live in the pinned NOW band; see below.) `RunStatus = 'completed' | 'failed' | 'killed' | 'running'` (`contract:5`), so the buckets are `Failed = failed | killed`, `Completed = completed`, with the existing `partialFailure: boolean` flag (`contract:128`) rendered as a sub-marker on the row (it already is, via `statusGlyph`).

All three groupings produce the same `TreeNode[]` shape, so `WorkflowTreeNode` / `RunRow` render unchanged. This is the gallery's "hierarchy vs time are orthogonal" finding made literal: each lens is just a different reducer over the same rows.

**Pinned NOW band, constant across all three lenses.** Promote the existing `LiveGroup` (`Rail.tsx:240-287`) — already shipped, already does the calm "one pulse on the group header, static children" budget. It renders before the tree regardless of grouping today; the only change is that it stays pinned when the lens changes. If nothing is running it collapses to nothing (it already conditionally renders on `anyLive`). Running runs **never** enter a tree bucket — this is what protects the frozen-sort guarantee (see §4 risk 1).

### 2b. Canvas (reading the selected run)

**No new view modes.** The shipped `ViewMode = 'execution' | 'plan' | 'overlay'` (`App.tsx:66`), labeled **Plan / Progress / Execution**, stays exactly as-is.

- **Plan** = the run-free design template (parsed AST, elk-laid-out).
- **Progress** (`overlay`) = the canonical shared layout painted per-step with run status — done · running · upcoming. **This is the DAG, and it is the live view.** For a running run it paints `incomplete` state (`paintOverlay(..., run.incomplete)`, `App.tsx:278`), so it already answers "what's running, what failed, what's still upcoming." The Execution model only contains agents that already *started*, so Progress is strictly the better live read — and it is already where running runs land.
- **Execution** = every agent instance that ran, one card each, grouped by phase-lane (elk-partitioned). The instance-level detail.

**The DAG (Progress) is the canvas's signature** and the place polish lives. It already encodes phases (swimlane bands), parallelism (fan-out), and state (node color/paint) in one read.

### 2c. Default per run-state, and how the user switches

- **Default route (shipped, unchanged):** `handleSelectRun` sets `view = r.status === 'running' ? 'overlay' (Progress) : 'execution'` (`App.tsx:376`). A live run opens on Progress (the painted live DAG); a finished run opens on Execution (instance detail). **Do not change this route.** In particular, do **not** add a `running → 'activity'` reroute — Progress already is the live view, and a separate Activity mode would split the live story (see §3 NEVER).
- **Switching:** the always-visible `view-toggle` segmented control (`App.tsx:464-492`) with its per-view `view-caption` one-liner (`:494-500`) that disambiguates Progress (per-step) from Execution (per-agent) — written precisely because users conflated the two. Keep it.
- **NOW status strip (the one new piece of canvas chrome):** a thin, always-present header line above whatever view is active — `N running · M failed · elapsed`. It is **chrome, not a mode**, so it adds zero combinatorial canvas state and answers "is it alive / did anything fail?" without a view switch. This is what people are actually reaching for when they say "Activity." ~30 lines, no layout engine. It collapses to nothing when there is no live/failed signal (calm by default).
- **The orthogonality contract (locked):** the sidebar lens emits **only** the selected `RunRef`. It never sets the canvas `view`. State this as a tested invariant. No "Time grouping switches the canvas to Timeline" coupling — ever.

### 2d. Staleness / retention (the data-scale problem)

Over months a project accrues hundreds of runs; a flat tree of *all history* conflates "what my agents are doing" with "an archive" and is the messy thing to avoid. argus is an **activity tool, not a database browser**, so the principle is **recency-by-default, archive-on-demand** — never destructive (these are on-disk journals we don't own; we only *fold*, never delete).

- **A recency window is the default surface.** Each lens shows recent and folds the long tail: Time gets this for free (the `Older` bucket stays collapsed); Workflow caps each folder to its N most-recent runs with a `+ K older…` expander; Status shows recent-within-bucket. A project-level `Show archived` toggle (or "last 30 days ▾" selector) reveals everything. Default window is generous but finite (e.g. 30 days / 25 runs per folder).
- **Decay, don't delete.** Finished runs **dim** (lower contrast) as they age — recency is legible without hiding anything. A workflow with no runs in the window dims, collapses, and sinks to the bottom (the existing `orderKey = max(startTime)` recency sort already does the sinking; staleness adds the dim + auto-collapse).
- **A filter box is the real escape hatch at scale.** A one-line filter over name / status / age, present in all lenses, turns the archive from "scrolled" into "searched." Cheap, lens-independent.
- **Retention is a setting, not a default delete.** Optionally hide runs older than X and pin important ones; pinned runs ignore the window. Strictly a view-filter over disk, reversible.

This is purely a **Rail concern** — same orthogonality rule (it changes which rows the reducer emits, never the canvas). It composes with the group-by lens: windowing/dimming/filtering apply *before* `groupRuns`, so all three lenses inherit it. It is **Phase 1.5 / LATER** (see Ship/Later/Never #15–#16): the recency sort + `Older` collapse already blunt the problem today, so a generous default window + dimming is the small next step, with the filter box and explicit retention setting gated on a project actually getting large.

---

## 3. Ship / Later / Never

| # | Item | Verdict | Why |
|---|------|---------|-----|
| 1 | Sidebar group-by `Workflow \| Time \| Status` (`groupRuns` reducer + segmented control) | **SHIP** | The genuine MVP. Orthogonal finding aid; adds no canvas state. Workflow branch = current memo verbatim → zero regression. |
| 2 | Pinned NOW band across all groupings (promote `LiveGroup`) | **SHIP** | Already shipped; only change is it stays pinned when lens changes. Calm one-pulse budget already met. |
| 3 | DAG (Progress) stays canvas default for every run; keep `running → overlay` route | **SHIP** | Structure is the always-asked question; Progress already paints live state. Zero new `ViewMode`. |
| 4 | NOW status strip in canvas chrome (`N running · M failed · elapsed`) | **SHIP** | Answers "is it alive?" without a view switch. Chrome, not a mode → no combinatorial cost. |
| 5 | Orthogonality contract: lens emits only `RunRef`, never sets `view` (tested invariant) | **SHIP** | Single-wire coupling is what keeps the whole IA low-state and independently testable. |
| 6 | **Timeline** view (wall-clock x-axis, phase bands, stacked fan-out bars, critical-path emphasis, edge overlay) | **LATER** | Real value for the one question the DAG can't answer (duration/critical-path), but it's a second layout engine. Gate on: (a) evidence someone asks the duration question, (b) it's a second renderer over the *same* `RunModel`/overlay/`STATE_COLOR`/`DetailPanel` (a switch, not a fork). Non-default while live (jitter trap). |
| 7 | **Table** as a collapsible bottom data-grid panel (sort/filter agents by tokens/duration/status) | **LATER** | A panel job, not a canvas. Sidebar Status/Time lenses already cover cross-run scanning; the table is the natural home for fan-out roll-ups. Cheap, but not MVP. |
| 8 | Persist `groupBy` (URL / localStorage) | **LATER** | A personal finding habit, fine to persist eventually. Local `useState` for now (like every other selection). |
| 9 | A separate **"Activity" canvas view** / 4th `ViewMode` member | **NEVER** | Progress already is it (`App.tsx:376`, `:278`). A new mode splits the live story across two views and re-creates the Progress/Execution confusion the `view-caption` was written to fix. Killed by Ship #3 + #4. |
| 10 | Contextual auto-pick + ephemeral per-run override + "view as graph" finish-affordance | **NEVER** | Solves a problem that only exists if you create the Activity/DAG split. The shipped one-line status route is sufficient and calmer. |
| 11 | **Gantt** as a peer view | **NEVER** | It's Timeline + dependency-arrow overlay. Fold the arrows into Timeline-Later as an off-by-default toggle. |
| 12 | **Phase swimlanes** as a view | **NEVER** | It's the *row-grouping axis* of the DAG (already shipped as `phaseLane`) and of a future Timeline. Never its own canvas. |
| 13 | **Story digest** as a canvas mode | **NEVER** | It's PX/explanation output. If wanted: a header summary line or right-rail in the existing `RunOverviewPanel`. Never a layout. |
| 14 | Coupling sidebar lens → canvas view | **NEVER** | The clever idea all proposals correctly reject. Keep rejecting it (Ship #5). |
| 15 | Recency window + age-dimming (default surface = recent; `+K older…` / `Older` fold; stale workflows dim+sink) | **LATER (1.5)** | The recency sort + collapsed `Older` already blunt staleness; a generous default window + dimming is the small next step once a project gets large. Pure Rail, applies before `groupRuns` so all lenses inherit it. |
| 16 | Filter/search box + explicit retention setting (hide-older-than-X, pin) | **LATER** | The real escape hatch at hundreds of runs. View-filter over disk only — never deletes journals. Gate on a project actually getting large. |

**Net shape:** 3 sidebar lenses · 3 shipped canvas views (unchanged) · 1 NOW chrome strip · 1 selection wire · recency-windowed rows · **0 new canvas axes.**

---

## 4. Phased plan

### Phase 1 — Sidebar group-by lens (smallest correct change, zero regression)

The MVP. Adds an orthogonal finding aid and touches **only the Rail**; the canvas is untouched.

**Touched files / components:**
- `apps/web/src/shell/Rail.tsx`
  - **NEW** `groupRuns(runs, workflows, groupBy): TreeNode[]` reducer. The `groupBy === 'workflow'` branch is the **existing `tree` memo moved verbatim** (`Rail.tsx:82-111`) — zero behavior change. `'time'` and `'status'` are new branches producing the same `TreeNode[]` shape.
  - **NEW** `groupBy` state (`useState<'workflow' | 'time' | 'status'>('workflow')`) + a segmented control rendered above the existing `LiveGroup` in the explorer panel (reuse `view-toggle` CSS patterns).
  - **NEW** optional `showWorkflowName?: boolean` prop on `RunRow` (`Rail.tsx:345`) — adds the workflow name back when the parent bucket no longer implies it (Time/Status lenses). Default `false` → Workflow lens unchanged.
  - **REUSE** `WorkflowTreeNode`, `RunRow`, `LiveGroup`, `formatRelativeTime` / `formatDuration` / `statusGlyph` (`shell/format.ts`), the open/auto-open machinery.
- `apps/web/src/App.tsx` — **no change** (Rail owns `groupBy` locally; `App` still passes the same props).

**Hard constraints (the frozen-sort guarantee):**
- Bucket **finished runs only**. Running runs stay in the pinned `LiveGroup`, never in a tree bucket — so a `running → completed` transition can never move a row between buckets mid-poll.
- Freeze bucket membership and ordering on **immutable** fields (`startTime` + terminal `status`), never on a still-mutating field. The Workflow lens already does this via `orderKey = max(startTime)` (`Rail.tsx:91`); Time/Status branches must follow the same rule.

**Acceptance criteria:**
- A1. Default `groupBy === 'workflow'` renders a tree **identical** to today (snapshot/visual parity; the moved memo is byte-equivalent).
- A2. Toggling to Time re-buckets the same finished runs into `Today / Yesterday / This week / Older`; rows show the workflow name; collapse/expand works.
- A3. Toggling to Status re-buckets into `Failed / Completed`; partial-failure runs show the partial sub-marker; rows show the workflow name.
- A4. The NOW band is present and pinned in all three lenses; with a live run it shows exactly one pulse; with none it is absent.
- A5. During a live poll (a `running → completed` transition), **no finished row jumps buckets or reorders** in any lens.
- A6. The canvas `view` does not change when the lens changes (orthogonality invariant; assert in a test).

**UI smoke:** open the app on the modal-rust project, expand the rail, cycle `Workflow → Time → Status → Workflow`, confirm the same runs appear re-bucketed with no canvas change and no console errors; with a dogfood live run active, confirm the NOW band pulses once and stays pinned across all three lenses.

### Phase 2 — NOW status strip on the canvas chrome

A thin always-present header reflecting live/failed state, present in every view without a view switch.

**Touched files / components:**
- `apps/web/src/App.tsx` — **NEW** small presentational strip rendered alongside the `view-toggle` / `view-caption` (`:464-500`). It reads the already-available `runs` (for `N running`) and the selected `run.partialFailure` / `run.status` (for `M failed` and elapsed). No new fetch, no new endpoint — binds to the same `runsQ` / `runQ` already in `App`.
- `apps/web/src/index.css` — **NEW** styles for the strip (calm, low-chrome, collapses when no signal).
- **REUSE** `formatDuration` for elapsed; the existing live model (`isLiveRun`, the 4s safety poll + SSE) drives freshness for free.

**Acceptance criteria:**
- B1. With ≥1 running run, the strip shows `N running` and a live-updating elapsed for the selected run.
- B2. With a failed/partial run selected, the strip shows the failed/partial count/marker.
- B3. With nothing running and a clean finished run, the strip collapses to nothing (no empty box).
- B4. The strip is present and consistent across Plan / Progress / Execution (it is chrome, not a mode) and adds no new `ViewMode` or reachable canvas state.

**UI smoke:** with a dogfood live run, open it (lands on Progress per the shipped route), confirm the strip reads `1 running · …` with a ticking elapsed; switch to Execution and Plan and confirm the strip persists unchanged; select a finished clean run and confirm the strip disappears.

### Phase 3 (LATER, evidence-gated) — Timeline view

Only when (a) there is evidence the duration/critical-path question is being asked, and (b) it can be a **second renderer over the same `RunModel` / overlay / `STATE_COLOR` / `DetailPanel`** — a switch, not a fork. If that sharing can't be cheap, it stays Later indefinitely.

**Touched files / components (sketch):**
- **NEW** `apps/web/src/views/Timeline.tsx` (plain SVG/flexbox, **not** React Flow / elk) reading the existing `RunModel` (`run.phases`, `run.agents` with `.startedAt` / `.durationMs` / `.state`).
- `apps/web/src/App.tsx` — **NEW** a single prominent canvas toggle to Timeline (kept demoted relative to Plan/Progress/Execution); critical-path / edge-overlay are in-view controls, not new top-level modes.
- **REUSE** `STATE_COLOR`, `DetailPanel` (rows open the same panel by node id via `onNodeClick`'s contract), `formatDuration` (`tabular-nums`), the phase-lane grouping as the row axis.

**Acceptance criteria (sketch):**
- C1. For the sample fan-out+partial-failure run, the Timeline shows the 5 RESEARCH bars sharing a start-x, the REVIEW concurrency, and the short red `✕`-capped `feasibility` stub ending before its siblings.
- C2. Identical-replica fan-outs collapse to one summary bar with a `×N` chip; named/distinct fan-outs stay as rows; collapse-to-phase ↔ expand-to-agent works.
- C3. Non-default while live; running bars are open-ended (no fabricated end-time); the x-domain does not rescale every tick.
- C4. Critical-path emphasis dims all but the longest blocking chain.

**UI smoke:** open the sample run, toggle to Timeline, confirm durations/overlap/the partial-failure are legible and the DetailPanel opens from a bar; confirm a live run is calm (no jitter) when manually shown as Timeline.

### Phase 1.5 (LATER) — Recency window + age-dimming

Applied in the Rail **before** `groupRuns`, so all three lenses inherit it (orthogonal — never touches the canvas).
- **NEW** a `windowRuns(runs, window)` filter (default last ~30 days / cap ~25 per workflow) feeding `groupRuns`; a `+ K older…` expander per Workflow folder and a project-level `Show archived` toggle reveal the long tail.
- **NEW** age-based dimming class on `RunRow` (contrast decays with age); a workflow with no in-window runs dims + auto-collapses + sinks (reuse the `orderKey = max(startTime)` recency sort).
- **REUSE** `formatRelativeTime`, the existing open/collapse machinery. Acceptance: stale runs fold but are one toggle away; nothing is deleted; the recent surface stays small regardless of total run count.

### Phase 4 (LATER) — Table panel · filter/search · retention · `groupBy` persistence

- Collapsible bottom data-grid (sort/filter agents) as a **panel**, fed by `RunModel`; reuse `AgentCardShell` data shapes / `DetailPanel`.
- A lens-independent **filter/search box** (name / status / age) over the run list.
- A non-destructive **retention setting** (hide-older-than-X, pin runs) — a view-filter over disk, never a delete.
- Persist `groupBy` to URL/localStorage once it's proven a sticky habit. Local `useState` until then.

---

## 5. Non-goals / what NOT to build

- **No 4th canvas `ViewMode` ("Activity").** Progress already is the live view. (Never #9/#10.)
- **No coupling of the sidebar lens to the canvas view.** One wire only: the selected `RunRef`. (Never #14.)
- **No Gantt, swimlane-as-view, or story-digest-as-mode.** Gantt folds into Timeline-Later; swimlane is the DAG/Timeline row axis; digest is PX output in `RunOverviewPanel`. (Never #11/#12/#13.)
- **No bucketing of running runs into Time/Status tree groups** — protects the frozen-sort guarantee.
- **No new fetch path or server endpoint** for any Phase-1/2 work — everything binds to the shipped `runsQ` / `runQ` / live model + SSE.
- **No per-append animation beyond the existing single-pulse calm budget.**
- **No global "preferred canvas view" preference** (hidden state; fights the calm/predictable goal).

---

## 6. Open questions for the user

1. **The one decision to ratify:** Do you accept *"Progress is the Activity view; we are not building a 4th canvas mode"*? Everything hinges on this. (It's grounded in shipped code — `App.tsx:376`, `:278` — not preference.) If you reject it, the fallback is to **rename/retune Progress** for liveness, never to add a parallel mode.
2. **Status buckets:** Confirm `Failed = failed | killed` and `Completed = completed` (with `partialFailure` as a sub-marker on the row), given the contract's `RunStatus = 'completed' | 'failed' | 'killed' | 'running'`. Should `killed` get its own bucket, or stay folded into Failed?
3. **Time buckets granularity:** Is `Today / Yesterday / This week / Older` the right set, or do you want month/quarter buckets for older runs as the dataset grows?
4. **NOW strip scope:** Should `M failed` count failures **across all runs** in the project, or only reflect the **selected** run's state? (Plan assumes selected-run elapsed + a project-wide running count; confirm.)
5. **Timeline evidence gate:** What counts as "evidence someone is asking the duration/critical-path question" — is dogfooding on argus's own multi-fan-out journals enough to greenlight Phase 3, or do you want to wait for a concrete ask?
6. **`groupBy` persistence timing:** Ship Phase 1 with ephemeral `useState` (recommended), or persist the lens choice from day one?
7. **Staleness window (§2d):** What's the right default recency window — last 30 days, last N runs per workflow, or both? And should age-dimming ship *with* Phase 1 (it's cheap and the recency sort is already there), or wait until a project is demonstrably large?
