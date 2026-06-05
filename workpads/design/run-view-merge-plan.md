# argus run-view merge: converged design + phased DESIGN-ONLY plan

Status: DESIGN-ONLY — a plan to approve, not code to write yet.
Builds on: `workpads/prototype/view-unification.md` (lane-drawer rev. 3 spec).
Supersedes: the earlier triad plan that kept `Plan / Progress / Execution` as three
sibling tabs. **Progress + Execution now MERGE into one Run view; Plan stays separate.**

---

## 1. Decision summary

### THE verdict: ONE run view, TWO top-level views total (`Plan` / `Run`)

Progress (the plan DAG painted per planned-step with this run's status) and Execution
(every agent instance, one card each, grouped by phase-lane) are **not two things**.
They are the *same run* sampled at two zoom levels — aggregate-per-plan-step vs
per-instance. Keeping them as sibling tabs forces the user to mentally re-register
"this RESEARCH box" as "those 7 cards" by tab-switching, the single worst operation for
a visualization: it destroys spatial constancy and offloads the aggregate↔instance join
onto human memory. **Merge them** so the join becomes a click — direct manipulation, not
recall. The dashed-ghost-vs-solid-card grammar then carries the plan-vs-run contrast
*inside one frame*.

**Plan stays separate** because it is genuinely distinct, not just a different zoom:

- Different data source — `Plan` reads the run-free `workflow` model (no `runRef`, no
  bindings); `Run` reads `run` + `overlay`.
- Different cardinality — one reusable template vs one execution bound to it.
- Different empty state — `App.tsx:396` literally branches `hasContent` on `!!workflow`
  vs `!!run && !!runPlan`. Collapsing Plan into Run would force a fake/empty-run state
  onto a template.

So: `ViewMode 'plan' | 'overlay' | 'execution'` → **`'plan' | 'run'`** (rename
`overlay`→`run`, delete `execution`). Three buttons → two. `handleSelectRun`
(`App.tsx:370-377`) lands **both** running and finished runs on `run` — today line 376
splits them (`running → 'overlay'`, finished → `'execution'`); that split *is* the bug
the merge removes.

### Chosen design: **lane-drawer** with **status-driven default expansion**

- Mechanism: **lane-drawer** (rev. 3). A planned step is the painted template node on a
  phase spine; clicking its `[▾]` caret grows a dashed drawer *downward inside the same
  phase lane*, grid-wrapping the real agent instances bound to it. No second ELK pass.
- Default state: **status-driven** (the interaction graft). RUNNING run →
  auto-expand the currently-active fan(s); FINISHED run → all collapsed. Seeded ONCE
  from the `live` flag on run-change; user-owned thereafter.
- Per-instance drill: clicking an instance card opens the existing `DetailPanel`.

### Why lane-drawer over the alternatives

| Candidate | Verdict | Reason |
|---|---|---|
| **lane-drawer** | **SHIP** | Only in-graph option needing no 2nd ELK solve (waypoint-free edges re-dock for free, `plan-model-mapping.ts:423-433`). Instances appear where the step is. |
| lane-expand / accordion / semantic-zoom (inline compound reparent) | Reject | Correct vision, but re-solve the whole DAG on every expand → one-frame layout flash + crossing churn on a live graph. |
| badge-peek (hover popover) | Reject as primary | Cheap, but a transient popover can't host 50 cards or a click-through to per-instance detail. An add-on, not the merge. |
| split-detail (click → side panel list) | Demote to leaf | Lowest risk, but pulls instances *off the spine* — loses the "instances live where the step is" morph that is the whole point. Survives as the per-instance drill only. |
| two-kept (keep both, add a density slider) | **Never** | The status quo the brief kills, dressed up. A global slider re-creates the tab-switch and can't express per-node zoom. |

---

## 2. The merged Run view

### Layout

One horizontal LEFT→RIGHT spine. Phases are ELK-partitioned into disjoint horizontal
lanes (`elk.direction:'RIGHT'` + `partition: n.phaseRef`, `elk.ts` / `plan-model-mapping.ts:243-244`).
A single-input fans out to parallel branches and fans back in — the cover-diagram grammar.

### How a planned step expands to its instances

`expandInstances(graph, overlay, run, expandedNodeIds, live)` runs **after**
`paintOverlay` as a pure, ELK-free arithmetic re-flow:

1. **Resolve** the expanded template's `bindAgentIds` → `run.agents`, build `agentCard`s
   via a shared `agentToCardData`.
2. **Emit** an `instanceGroup` drawer parented to the host lane, with an explicit
   `style:{ width, height }` = `cols`×cardW by `header + ceil(N/cols) rows + ghost row`,
   where `cols = clamp(ceil(sqrt(N)), 2, 5)`.
3. **Grow** the host lane's `style.height` by exactly `drawerH = instanceGroup.style.height + DRAWER_GAP`
   (one source of truth — lane growth and drawer size cannot drift).
4. **Shift** same-lane siblings with lane-relative `y > templateY` down by `drawerH`
   (real re-flow; a second stacked node in the phase *would* otherwise overlap).
5. **Touch no other lane** — X is safe (disjoint ELK bands), Y is safe (a one-time
   baseline normalization at overlay build, *not* an expand side-effect, so neighbor
   lanes never jump on the first click).
6. **Edges follow for free** — spine/merge edges carry no baked waypoints
   (`plan-model-mapping.ts:423-433`), so React Flow re-docks them to the moved handles
   with no edge surgery. *This* — not "left-to-right layout" — is why no 2nd ELK pass is
   needed. (The loop-back edge is the one routed exception; see §3 and Risk 2.)

Instance cards are emitted **without** `extent:'parent'` (unlike normal lane members at
`:397`) so a sizing error *overflows visibly* rather than silently clipping a real agent.
Parent-before-child order is re-established by appending lane → drawer → cards and
extending the rank to `phaseLane:0 / planLoop:1 / instanceGroup:2 / agentCard:3 / else:2`.

### Visual grammar (dark-theme translation of the cover diagram)

The grammar already exists in `index.css` / `PlanNodes.tsx`; the merge makes the
contrast legible in one frame instead of split across tabs.

- **Dashed rounded-rect ghost (`--line-2` border, no fill)** = pending / not-yet-run /
  placeholder. Reuse `.plan-bind-ghost` (neutral `#3a414c`) for a `not-run` template
  node; upcoming instance slots render as dashed ghost cards. *This is the plan-vs-run
  distinction rendered in one view: unrealized steps drawn as the blueprint.*
- **Solid filled card + corner status dot** = active / realized. A bound instance is a
  solid `agentCard` (faint bg, a couple of content lines — tokens/tools, status dot in
  the `BIND_STATUS_COLOR` palette: green `#3fb950`, amber, red). Aggregate chip in the
  collapsed header via `aggregateChipText` verbatim (`research ×7 · 6/7 done · 1 failed`).
- **Accent diamond** = decision / verify gate. Already shipped: `.plan-decision` is a
  real SVG `<polygon>` with amber `#d29922` accent stroke. Accent stays reserved for the
  gate + status dots; it must NOT leak into card chrome.
- **Dashed accent loop-back** = continuation. Already shipped as the `loop-back`
  `smoothstep` edge leaving and returning to the diamond; the loop container is a dashed
  amber compound with an unrolled round-axis.
- **Dimension brackets** = restrained light annotations only — a fan-out's `×N`, a
  drawer-header `×7 · 6/7 done`, or a loop's `×3 rounds`. The spec-sheet metaphor, not
  chartjunk.

### Default behavior: running vs finished

| | RUNNING | FINISHED |
|---|---|---|
| Lands on | `run` (both — remove the `App.tsx:376` split) | `run` |
| Rest state | active fan(s) auto-expanded; rest collapsed | all collapsed (aggregate chips) |
| Reading goal | "what is executing right now" | "did the shape hold; where did it fail" |
| State flip (`running→done`) | paint-only, no relayout | n/a (settled) |
| Instance spawn (count change) | re-grid drawer + re-flow lane | n/a |
| Refit on a live tick | NEVER — `fitSignature` frozen to PLAN ids | n/a |
| Expand seed | `expandedNodeIds = activeFanIds` (once, on run-change) | `new Set()` |

Auto-expand is seeded ONCE on run-change off the `live` flag (already threaded through
`paintOverlay(..., live)`), then is user-owned — it is never re-derived on a per-SSE-tick
basis, or the drawer would fight a user who manually collapsed it (Risk 1).

---

## 3. How it renders the 6 orchestration patterns

| Pattern | Rendering | Notes / difficulty |
|---|---|---|
| **classify-and-act** (router → one branch) | Accent diamond router; unchosen branches stay dashed ghosts, the taken branch is a solid card. | The ghost-vs-card grammar shows "router picked this one" with zero extra UI. |
| **fan-out-and-synthesize** (the sample run) | The canonical lane-drawer expand: one template fans to N instance cards in the drawer, fan-in to a solid synthesizer card. | The drawer *is* the fan-out. Native, lowest-risk. |
| **adversarial-verification** (judge / verify gate) | Accent diamond gate between generate and accept; the generate step's drawer holds the candidates; the diamond shows the verdict (pass/fail edges solid vs ghost) and carries its own status dot. | HARD — the gate must carry run state, and the *loop-until-the-judge-passes* form is a fan-out **inside a loop** (see §5 GAP). |
| **generate-and-filter** | Fan-out drawer where filtered-out instances render as muted / struck cards (not deleted — honest about what ran and was discarded); survivors solid. | Honesty: discarded instances stay visible. |
| **tournament** (bracket elimination) | Multiple narrowing rounds via the existing unrolled `plan-loop-round-axis` (`PlanNodes.tsx`); each round a set of solid survivors with eliminated cards dimmed. | HARD — most likely to strain the single-drawer model; rounds live *inside* the loop container, not a lane (§5). Phase-2 work. |
| **loop-until-done** (back-edge) | The dashed-accent `loop-back` edge closes the loop; the `planLoop` container + `observedRounds` annotates "×3 rounds" as a dimension bracket; per-round instances carried by the round-axis. | HARD — the back-edge is the ONE routed edge (`smoothstep`, `plan-model-mapping.ts:259`), so it is the regression canary for any re-route after a drawer pushes its source handle down. Phase-2 work. |

---

## 4. Ship / Later / Never

| Decision | What | Why |
|---|---|---|
| **SHIP** | 3 tabs → 2 (`Plan` / `Run`); `handleSelectRun` lands both run states on `run`; delete the Execution *mode*. | Removes the fake distinction + the tab-switch join. |
| **SHIP** | `expandInstances` for **lane-member fan-outs only** (the dominant flat case): grow host lane, shift same-lane siblings, explicit drawer `style:{w,h}`, cards without `extent:'parent'`. | The 90% case; the only topology the sample run exercises. |
| **SHIP** | Status-driven default: seed `expandedNodeIds` from `live` once on run-change, user-owned thereafter. | RUNNING runs need the active fan visible; this replaces what Execution was *for*. |
| **SHIP** | Freeze `fitSignature` to PLAN node ids; separate one-shot expand `fitBounds`. | Live instance/ghost churn must not yank the viewport (Risk 3). |
| **SHIP** | Extended rank (`instanceGroup:2 / agentCard:3`) + dev assertion (child index > parent index; every card rect ⊆ drawer rect). | React Flow drops/mis-parents children that precede their parent (Risk, frontend). |
| **SHIP** | Density degrade: above ~24 instances, cards collapse to chips (dot + 2 numbers) + a "+N more" tail tile; clamp expand fit to a readability floor. | A 50-fan must stay bounded in one phase band and not zoom-out into illegibility. |
| **SHIP** | Quiet "Expand all" run-header toggle (= the old Execution, anchored to the spine). | Escape hatch only — not the default affordance. |
| **LATER** | The loop / tournament **containment** design (fan-out-inside-loop). Recommendation: do NOT lane-drawer a loop-body fan; drill through the round-axis → `DetailPanel`. | The round-axis is column markers, not a drawer host; loop bodies are parented to the loop container (§5). Needs its own layout tests first. |
| **LATER** | The one-time `normalizeLaneBaseline` pass. | Subtlest piece (revised twice); a non-horizontal resting spine is cosmetic, a baseline jump is not. Land after the core is proven on real journals. |
| **LATER** | The unbounded-live `+ more` tile (gated `unbounded && live && partial`). | Edge-casey; `computeTotal` never returns `'N'` mid-run (`overlay.ts:211-217`). |
| **NEVER** | The two-kept density slider. | A global mode toggle re-creates the tab-switch; can't express per-node zoom. |
| **NEVER** | A prominent / default "Expand all". | Re-creates the all-instances-at-once view being retired. |
| **NEVER** | Deleting `runModelToGraph` / `mapping.ts` / `AgentCardNode`. | They are the instance-card renderer, the plan-less fallback engine, AND the synthetic "unplanned" lane for `unplannedAgentIds` — deleting them reopens an honesty gap (agents that ran but weren't planned would vanish). |

---

## 5. The one explicit gap to gate Phase 2 on (adversarial core)

**Loops and tournaments do not live in lanes; they live INSIDE the `planLoop`
container — the lane-drawer mechanism does not reach them.**

- Confirmed: loop bodies are parented to the loop container (`loopOf`,
  `plan-model-mapping.ts:234-238, 253`), and the loop container is parented to its lane
  (`:347-348`). The unrolled multi-round view is a horizontal round-COLUMN axis rendered
  *inside* `LoopContainer` (`PlanNodes.tsx` round-axis), not lane members.
- The contract allows a node to carry **both** `multiplicity` (fan-out) AND `loopRef`
  (loop body) — independent fields (`packages/contract/src/index.ts`). So a **fan-out
  inside a loop is a legal, expected topology** (it is literally adversarial-verification:
  loop-until-the-judge-passes, each round fanning out N candidates).
- For such a node, "grow the host lane and shift same-lane siblings" is the wrong
  arithmetic — the host is the loop container, with its own header, round-axis, and
  `extent:'parent'` children. This is a *containment* problem, not an edge-routing one.

**Phase-2 recommendation:** for loop-body fan-outs, do NOT lane-drawer; route the drill
through the existing round-axis as a round selector → `DetailPanel`. This sidesteps
recursive containment entirely and is honest. Add layout tests for a loop back-edge and a
2-round tournament *before* this ships.

---

## 6. Phased plan

Each phase lists concrete files (reuse vs new), acceptance criteria, and a UI-smoke note.

### Phase 1 — Merge the two views with zero loss (flat fans only)

The smallest correct change that collapses Progress + Execution into one Run view,
reusing `overlay.ts` / `overlay-paint.ts` / `elk` / `DetailPanel` and the
`view-unification.md` spec.

**Reuse (no behavior change):**
- `apps/web/src/overlay.ts` — `computeTotal` (`:211-217`) drives ghost counts; untouched.
- `apps/web/src/overlay-paint.ts` — already paints `bindAgentIds` / `bindStatus` /
  `aggregateChipText`; the `live` flag is the seed source.
- `apps/web/src/layout/elk.ts` — RIGHT-partitioned lanes; untouched (no 2nd pass).
- `apps/web/src/plan-model-mapping.ts` — waypoint-free edges (`:423-433`); untouched
  except the extended rank tier.
- `apps/web/src/nodes/DetailPanel.tsx` — per-instance drill via the `isAgent` gate
  (`:174`); untouched.
- `apps/web/src/nodes/AgentCardShell.tsx` / `AgentCardNode` — the instance-card renderer.
- `runModelToGraph` / `mapping.ts` — the plan-less / `overlayError` fallback engine +
  the synthetic "unplanned" lane.

**New / edited:**
- `apps/web/src/App.tsx` (edit) — `ViewMode` → `'plan' | 'run'`; two-button toggle;
  `expandedNodeIds` state reset on run/workflow change; wrap `<ReactFlow>` in
  `ExpandContext.Provider`; keep global `onNodeClick` (`:427`) for body→panel; freeze
  `fitSignature` (`:338-340`) to PLAN ids; update `isWideShort` (`:350`); add a one-shot
  expand `fitBounds` effect; `handleSelectRun` (`:370-377`) lands both states on `run`;
  remove the Execution button + its loading/`hasContent` arms (`:390-396`).
- `apps/web/src/overlay-expand.ts` (new) — pure `expandInstances(...)`: resolve
  `bindAgentIds` → cards via shared `agentToCardData`, emit `instanceGroup` (explicit
  `style:{w,h}`) + grid `agentCard` children (no `extent:'parent'`), grow host lane,
  shift same-lane siblings, append in lane→drawer→cards order, dev assertions.
- `apps/web/src/nodes/InstanceGroup.tsx` (new) — dashed drawer shell (mirrors
  `LoopContainer`); header = label + `aggregateChipText` + `[▴]`; reads size from `style`.
- `apps/web/src/expand-context.ts` (new, small) — `ExpandContext` so the caret reaches
  `toggle(id)` without a function on `node.data`.
- `apps/web/src/nodes/PlanNodes.tsx` (edit) — add `[▾]/[▴]` caret + `is-expanded` to
  `PlanAgentNode`, gated `bindAgentIds.length > 1` OR (`status≠not-run` AND fanned
  multiplicity); caret `onClick` calls `e.stopPropagation()` + `ExpandContext.toggle(id)`;
  register `instanceGroup` in `nodeTypes`.
- `apps/web/src/mapping.ts` (edit) — extract `agentToCardData(agent)` (shared by the
  fallback path + the expand). No behavior change.
- `apps/web/src/plan-model-mapping.ts` (edit, minimal) — extend rank to
  `instanceGroup:2 / agentCard:3` (the only mapping change).

**Acceptance criteria:**
- Run view shows exactly two top-level mode buttons (`Plan` / `Run`); the Execution
  button is gone.
- Selecting a finished run lands on `Run`, all fans collapsed, aggregate chips visible.
- Selecting a running run lands on `Run` with the active fan auto-expanded.
- Clicking a fanned step's `[▾]` grows the drawer; SETUP/SYNTH keep their exact X and Y;
  spine/merge edges re-dock with no flash and no 2nd ELK solve.
- Clicking an instance card opens `DetailPanel` for that agent.
- Layout test on the 14-agent fan: every instance-card rect ⊆ its drawer rect; every
  child node index > its parent index.
- A live tick (state flip) repaints in place and does NOT re-fit the viewport.
- No on-disk / wire contract change; `overlay.ts`, `overlay-paint.ts`, `elk.ts` logic
  unchanged.

**UI-smoke note:** load a real fan-out journal fixture from
`~/.claude/projects/-Users-nicolas-devel-argus/<session>/workflows/`; in `Run`, confirm
collapsed→expanded morph on click, instance-card→DetailPanel, and that switching to
`Plan` and back preserves selection. Screenshot collapsed and expanded states.

### Phase 2 — The topologies the sample doesn't exercise

**Reuse:** `PlanNodes.tsx` round-axis (`LoopContainer`), `overlay-paint.ts`
`observedRounds`, `DetailPanel`.

**New / edited:**
- `apps/web/src/overlay-expand.ts` (edit) — branch loop-body fan-outs to the round-axis →
  `DetailPanel` drill (NOT a lane-drawer); add the one-time `normalizeLaneBaseline(graph)`
  pass; add the unbounded-live `+ more` tile (gated `unbounded && live && partial`).
- `apps/web/src/nodes/AgentCardShell.tsx` / `index.css` (edit) — ghost "upcoming" card +
  "+ more upcoming" tile + the >24 chip-degrade variant.

**Acceptance criteria:**
- Layout tests for a loop back-edge and a 2-round tournament: the back-edge re-docks
  after a drawer expand/collapse and does not route through a sibling lane.
- A fan-out-inside-a-loop opens its instances via the round-axis → DetailPanel, not a
  clipped/escaped lane drawer.
- `normalizeLaneBaseline` runs once at overlay build; no neighbor lane jumps on first
  expand or reverts on full collapse.
- A 50-agent fan degrades to chips + "+N more"; the expand fit never zooms below the
  readability floor.

**UI-smoke note:** use a loop / adversarial-verification journal fixture; confirm the
round-axis drill and that the back-edge stays docked across expand/collapse. Screenshot a
50-agent fan (chip-degrade) and a loop with the round-axis.

---

## 7. Non-goals

- No on-disk data-contract or wire-format change (Stance 4 preserved). No invented edge,
  no new persisted field.
- No second ELK pass; no change to `elk.ts` layout logic.
- Not deleting `runModelToGraph` / `mapping.ts` / `AgentCardNode` — demoted, not removed.
- Not merging Plan into Run (different data source / cardinality / empty state).
- No prominent "Expand all" and no density slider.
- Phase 1 does not solve loop/tournament containment — explicitly gated to Phase 2.

---

## 7b. Plan = blueprint + run history (the distinct PURPOSE for keeping Plan)

The blueprint render (Option A, shipped) makes Plan *look* different from a painted Run;
this gives it a different *job*, resolving "they're almost the same" properly.

A plan has a **1:N** relationship to runs (`run-view-merge-plan.md §1` cardinality). So the
Plan view should be the **workflow overview**: the dashed blueprint **+ a run-history strip**
of *this workflow's* runs — each as a status glyph + when + agents·duration, newest-first
(the data is already in hand: `runsQ` filtered to the workflow). Then:

- **Plan** answers *"what is this workflow, and how has it gone over time?"* — the design plus
  every run at a glance (when · status · failures). It's where the TIME/STATUS lens lives at
  the workflow scope (ties back to the sidebar-gallery finding).
- **Run** answers *"what did this one execution do?"* — the merged, expandable painted run.
- **Switching now MEANS something**: Plan = all-runs overview; clicking a run in the strip →
  Run view of it. Plan is no longer a faded Run; it's the run-free design + its history.

This also gives a natural home for the failure signal across runs (e.g. "5 of 13 failed")
and recency/staleness (§2d of the sidebar plan). Proposed next build (after the current
merge + inspector): a compact **run-history strip** in the Plan-view chrome (or a band under
the blueprint), reusing the run-summary rows + `statusGlyph` / `formatRelativeTime`, with
click→select-run→Run. Small, additive, no layout-engine work.

## 8. Open questions

1. **Loop-body fan containment (the gate on Phase 2).** Confirm the round-axis →
   DetailPanel drill is acceptable for fan-out-inside-loop, vs the heavier recursive
   lane-growth (4th rank tier inside the loop container). Recommendation: round-axis drill.
2. **Auto-expand selection for multiple concurrent fans.** If two fans are running at
   once, auto-expand both, or only the most-recently-started? (Default proposed: all
   currently-running fans.)
3. **Chip-degrade threshold.** Is ~24 the right cutoff for full-card → chip, or should it
   key on available lane width rather than a fixed count?
4. **Generate-and-filter discarded cards.** Muted vs struck-through — which reads as
   "ran but discarded" without looking like an error state (red)?
5. **`normalizeLaneBaseline` timing.** Confirm it is acceptable to pay the de-centering
   cost up front at overlay build (slightly non-centered resting spine) in exchange for
   zero baseline movement on expand.
