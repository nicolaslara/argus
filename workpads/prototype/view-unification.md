All four reviewer claims are confirmed against the code:

1. **Lane boxes tightly wrap members at differing y-origins** (`plan-model-mapping.ts:306-311`: `y = minY - headerTotal`, `h = maxY - minY + headerTotal + LANE_PAD_BOTTOM`); the very first expand re-origins every lane if a global top-align fires. Edges (`:423-428`) carry NO baked elk waypoints — only `e.from`/`e.to` + an optional `sourceHandle` — so the load-bearing fact is live edge re-routing.
2. **`computeTotal` returns `'N'` only when `boundCount === 0`** (`overlay.ts:211-217`) — mid-run unbounded fans report `total === boundCount`, never `'N'`.
3. **`onNodeClick` is global** (`App.tsx:427-430`), keyed only on `n.id`, and can't distinguish sub-targets (the caret).
4. **`fitSignature` keys on `graph.nodes.map(id).join`** (`App.tsx:338-340`) — a spawning instance / vanishing ghost changes the id set → the refit at `:342` fires on live count changes, and `:350` `isWideShort` covers `'plan'|'overlay'`.

One refinement the code forces on the prior revision: claim 1's reviewer is right that a global top-align fired *whenever any lane is expanded* re-origins every lane on the first click — a jump in both directions. The honest fix is to make top-align a **one-time normalization at initial overlay layout** (before any expand), so the baseline never moves on expand. The revised design below adopts that.

---

# Unify Progress + Execution: click a step to expand its instances (rev. 3)

## What changed in this revision

Three corrections, each tied to a verified code fact — building on rev. 2's already-corrected caret/refit/edge model:

- **(Med) The expand is now genuinely spatially local in Y.** Rev. 2's "top-align all lane containers whenever ANY lane is expanded" silently re-origined every lane on the *first* expand, because lanes tightly wrap their members at different y-origins (`plan-model-mapping.ts:306-311`) and elk `NETWORK_SIMPLEX` vertically centers them. SETUP and SYNTH would visibly jump to a new baseline on the first click — the opposite of the "expand in place; nothing else moves" feel the unification is sold on, and it would revert (jump back) on full-collapse. **Fix: top-align becomes a ONE-TIME normalization baked into the initial overlay layout** (a pure pass run once, before any expand). The de-centering cost is paid up front; expanding thereafter only grows the host lane and pushes its *own* same-lane siblings down — SETUP/SYNTH keep their exact X **and** Y across every expand/collapse. The mockup's "SETUP/SYNTH keep their X" annotation is now true for Y too.
- **(Med) Parent-before-child ordering for the new nested group is owned explicitly.** React Flow requires a parent before its children, and `plan-model-mapping.ts:420-421` enforces this with `rank = phaseLane:0 / planLoop:1 / else:2`. A drawer (`instanceGroup`) and its `agentCard` instances would *both* land in `else:2`, so a stable sort does **not** guarantee drawer-before-cards, nor drawer-before-other-rank-2-lane-members. Since `expandInstances` runs *after* `paintOverlay` on the already-sorted array, it must re-establish the invariant itself. **Fix: `expandInstances` appends in explicit dependency order (lane present → `instanceGroup` drawer → its `agentCard` children) and extends the rank to `phaseLane:0 / planLoop:1 / instanceGroup:2 / agentCard:3 / else:2`, with a dev-time assertion that every child's `parentId` appears at a lower index.**
- **(Med) The doubly-nested `extent:'parent'` clip risk is removed.** Lane members are emitted with `extent:'parent'` (`plan-model-mapping.ts:397`), which *clamps* a child inside the parent box. Cards parented to a drawer that is itself parented to a lane = a double clamp; any `drawerH`-vs-grid arithmetic error would **silently clip** a real instance instead of overflowing visibly — exactly the dropouts the widened caret gate works to surface. **Fix: the `instanceGroup` gets an explicit `style:{ width, height }` sized to header + `ceil(N/cols)` grid rows + the ghost/`+ more` row (group nodes read size from `style`, per `mapping.ts` / `plan-model-mapping.ts:334`); the host-lane growth equals exactly that `drawerH + DRAWER_GAP`; and the instance cards do NOT use `extent:'parent'`** (or, equivalently, the drawer is sized conservatively larger), so a miscalculation overflows visibly rather than clipping. A layout test on the 14-agent fan asserts no card rect exceeds its drawer rect.

Carried forward from rev. 2 (still correct against the code): the win is *no second elk pass* via waypoint-free edge re-routing (not a "free bloom"); the caret gate is widened so a 1-survivor fan stays expandable; the live unbounded "+ more" tile keys on `unbounded && live && partial` (since `total` is never `'N'` mid-run); the caret uses `e.stopPropagation()` + an `ExpandContext` (not a fn on `node.data`); and the two refits are decoupled (structural fit frozen to the PLAN node set, expand fit a one-shot on membership entry).

The scoring, the winner (lane-drawer), the grafts, and the Execution-tab fate are unchanged.

## Scoring (1-5; higher is better)

| Design | Intuitive (kills "what's the diff?") | Fits plan-shaped graph | Layout feasibility (elk/RF) | Live-run support | Impl. risk (5 = low risk) | Total |
|---|---|---|---|---|---|---|
| **inline-expand** (fan-out → compound container, instances as children, one elk pass keyed on `expandedNodeIds`) | 5 | 5 | 4 | 4 | 3 | **21** |
| **lane-drawer** (instances grid-wrapped in the lane *below* the template; deterministic grid, no 2nd elk pass; spine edges re-route via handle-following) | 5 | 5 | 5 | 4 | 4 | **23** |
| **semantic-zoom** (same as inline-expand but framed as LOD/focus; per-container grid vs column spike for large N) | 4 | 5 | 4 | 4 | 3 | **20** |
| **expand-into-panel** (click → right DetailPanel shows instance list → drill one agent; graph never reflows) | 3 | 4 | 5 | 5 | 5 | **22** |

### Why these scores (unchanged rationale)

- **Intuitiveness.** The user's literal goal is "CLICK a step to EXPAND it into its instances… start at the plan, expand into execution." The three in-graph designs deliver that morph *spatially* — instances appear *where the step is*. expand-into-panel inspects but moves the instances off the spine (3). lane-drawer's intuitiveness now actually holds in Y: with the one-time baseline normalization, only the clicked lane changes shape (see the rev.-3 §feasibility).
- **Fits the plan-shaped graph.** All keep phases-as-lanes + merge/decision/loop edges; the in-graph ones keep instances inside their phase band (5). Panel pulls instances out of the graph (4).
- **Layout feasibility.** lane-drawer is highest because it needs **no second elk solve** — a deterministic grid appended below the template with arithmetic lane growth — so zero crossing-jitter and zero async flash. This works because (a) elk partitions phases into disjoint horizontal bands (`elk.direction:'RIGHT'` + partitioning), so X is genuinely safe, AND (b) the emitted spine/merge edges carry no waypoints (`plan-model-mapping.ts:423-428`), so they re-dock at moved handles automatically. inline-expand/semantic-zoom re-solve the whole DAG (one-frame flash). Panel: no layout change (5).
- **Live-run.** All inherit `paintOverlay(..., live)` + SSE. Panel is cleanest (5). The in-graph ones must obey "count change → re-grid + re-flow; state flip → paint-only" and handle upcoming-ghosts honestly (4).
- **Impl. risk.** Panel lowest (5). lane-drawer (4): one new group node + a pure grid transform + the arithmetic re-flow + a one-time baseline pass, no elk change. inline-expand/semantic-zoom (3): threading `expandedNodeIds` into the elk effect + reparent math + the flash.

## Winner: **lane-drawer**, grafted with the best of the others

lane-drawer wins (23): it delivers the spatial "expand in place" vision (intuitiveness 5, fit 5) at the lowest layout risk of the in-graph options (feasibility 5, risk 4), because it refuses the second elk pass and uses a deterministic grid grown downward — leaning on elk's partitioned left→right bands (X-safe) and on the *waypoint-free edges* (spine re-routes live). It invents no engine and changes no contract.

**Grafts onto the winner (unchanged):**

1. **From expand-into-panel — the per-instance drill IS the panel.** Clicking an *instance card* opens the existing `DetailPanel` (it already lazily `fetchAgentResult(runRef, agentId)` and renders the full per-agent body + the ✨ sub-UI). Graph expand answers "which 7 / which failed"; panel answers "everything about that one." Reuses `AgentCardNode` verbatim as the instance card.
2. **From inline-expand — the collapsed summary moves into the drawer header.** The drawer header keeps the template identity + `aggregateChipText` (`research:${r.key} ×7 · 6/7 done · 1 failed`), so collapsed↔expanded never disagree (one function, two placements). The merge marker `●`/`◌` and downstream edge stay attached to the *template node's stable id*.
3. **From semantic-zoom — large-N wraps to a grid; "Expand all" is the demoted Execution.** Grid `cols = clamp(ceil(sqrt(N)), 2, 5)`. An "Expand all" run-header control expands every fan-out at once = the old Execution view, anchored to the plan spine.

## The corrected feasibility model (no second elk pass; spatially local in Y)

`expandInstances(graph, overlay, run, expandedNodeIds, live)` runs **after** `paintOverlay` and performs an explicit, ELK-free **arithmetic lane re-flow**:

0. **One-time baseline normalization (NOT an expand side-effect).** At the moment the overlay graph is first built (right after `paintOverlay`, before any expand), a pure pass top-aligns all lane containers to a common baseline: set every lane's `y` to `min(lane.y)` and absorb the per-lane delta into that lane's members' relative `y` (which is safe — members are positioned relative to their parent lane). This de-centers elk's `NETWORK_SIMPLEX` vertical centering *once*, up front, so the inter-lane spine edges start ~horizontal **and never move again on expand/collapse**. Because it runs before the first expand and is independent of `expandedNodeIds`, no lane ever "jumps to a new baseline on the first click," and full-collapse never reverts a baseline. (This replaces rev. 2's "applied whenever any lane is expanded," which would have re-origined every lane on the first expand — confirmed against `plan-model-mapping.ts:306-311`, where each lane wraps its members at a *different* y-origin/height.)
1. **Grow the host lane.** For the expanded template's lane container, `style.height += drawerH`. The drawer (`instanceGroup`) is parented to the lane, positioned `{ x: templateRelX, y: templateRelY + PLAN_AGENT_H + DRAWER_GAP }`, and given an **explicit `style:{ width, height }`** = grid width × `cols` and `headerBand + ceil(N/cols) * (cardH + rowGap) + ghostRow`. `drawerH` is read from that same `style.height` (+ `DRAWER_GAP`) — one source of truth, so lane-growth and drawer-size cannot drift.
2. **Push down lane-relative siblings.** For every node in the *same lane* with lane-relative `y > templateY`, add `drawerH` to its `y`. (Verified-necessary: any lane with a second stacked node — two sequential agents, or two fan-outs in one phase — would otherwise overlap the drawer. The "down-only bloom" is real re-flow, not free.)
3. **Do NOT touch other lanes' X, Y, or internal layout.** X is safe because elk partitions phases into disjoint bands; Y is safe because the baseline was normalized once in step 0 and only the *host* lane's height/members move. SETUP and SYNTH keep their exact rect across every expand/collapse.
4. **Cards overflow visibly, never clip.** The instance `agentCard` children are emitted **without `extent:'parent'`** (unlike normal lane members at `plan-model-mapping.ts:397`), so a grid-height miscalculation overflows the drawer *visibly* rather than silently clamping a real instance. The drawer's explicit `style` is sized to fully contain `ceil(N/cols)` rows plus the ghost/"+ more" row. A layout test on the 14-agent fan asserts every instance-card rect ⊆ its drawer rect.
5. **Parent-before-child order is re-established here.** `expandInstances` appends in dependency order: the lane (already present) → the `instanceGroup` drawer → its `agentCard` children. The rank function is extended to `phaseLane:0 / planLoop:1 / instanceGroup:2 / agentCard:3 / (else):2`, and a dev-only assertion verifies every child's `parentId` index < the child's index after the final sort. (React Flow drops or mis-parents children that precede their parent; the existing `else:2` bucket gave no such guarantee for the two new types.)
6. **Edges follow for free — the genuine load-bearing fact.** `planModelToGraph` emits flow/merge/spine edges as `type:'default'/'smoothstep'` with NO elk waypoints (`plan-model-mapping.ts:423-428` only sets `source`/`target`/`sourceHandle`), so React Flow re-routes them to the moved handles with no edge surgery. This — not "left→right layout" — is why the no-elk approach holds.

`paintOverlay`'s purity is preserved: it never relayouts; `expandInstances` (and the one-time baseline pass) are the explicit topology-adding steps layered on top.

## Caret affordance + click routing (unchanged from rev. 2, still verified)

- **Gate (widened):** the `[▾]` caret shows when `data.bindAgentIds.length > 1` **OR** (`bindStatus !== 'not-run'` AND the multiplicity is fanned, i.e. `multiplicity.kind` is `fixed`/`unbounded` with floor > 1). This keeps a fanned step that bound only **1 surviving instance** expandable (`.filter(Boolean)` dropouts otherwise hide the instance that DID run behind a step reading as a shortfall). A genuine `×1` step gets no caret.
- **Click routing:** React Flow's `onNodeClick` (`App.tsx:427-430`) fires for the whole node and **cannot distinguish sub-targets**. So the caret carries its own `onClick={(e) => { e.stopPropagation(); toggle(nodeId); }}` *inside* `PlanAgentNode`. The toggle reaches `setExpandedNodeIds` via an **`ExpandContext`** provider wrapped around `<ReactFlow>` in `App` — **not** a function on `node.data` (functions on data defeat memo and trigger re-mount warnings). The global `onNodeClick` stays as body→panel.
- **Instance cards** are emitted with `type:'agentCard'` + a populated `agentId` (via the shared `agentToCardData`, which already sets `agentId` from `agent.agentId`), so `DetailPanel`'s `isAgent` gate at `DetailPanel.tsx:174-175` fires unchanged.

## Live-run rules (unchanged from rev. 2, still verified)

- **State flip** (`running→done`): a `paintOverlay` data patch — **no relayout, no re-grid**.
- **New instance spawns** (count change): **re-grid the drawer + re-flow the lane** (cards slide into the next slot; the drawer's `style.height` and the lane growth both recompute from the new `N`).
- **Upcoming-ghost honesty:**
  - **Fixed `×7`, partially spawned:** ghost "upcoming" slots = `total − bound` (a *known* count). Render real ghosts.
  - **Unbounded `×N`, partially spawned (live):** mid-run `computeTotal` returns `total === boundCount` (never `'N'` — that only holds when nothing has bound, per `overlay.ts:211-217`). So we **cannot** key the "+ more" rule on `total === 'N'`. Instead: render **one `+ more upcoming` tile** when `multiplicity.kind === 'unbounded' && live && bindStatus === 'partial'`. Precedence: known fixed count → real ghosts; unbounded live partial → single `+ more` tile; settled/finished → no ghosts.
- **Decoupled refits:**
  1. **Structural refit** (`App.tsx:342`) is frozen to the **PLAN node set only** — `fitSignature` (`App.tsx:338-340`) excludes `instanceGroup`/`agentCard` child ids before `.map(id).join`. This stops live instance/ghost churn from re-triggering the fit and yanking the viewport on every transition. (`isWideShort` at `:350` updates from `'plan'|'overlay'` to `'plan'|'run'`.)
  2. **Expand fitBounds** is a **separate one-shot effect** keyed on a node id *entering* `expandedNodeIds` (a membership transition), firing `fitBounds(union(viewport, drawerRect))` exactly once per expand — never on subsequent paints.
- `expandedNodeIds` is reset on run/workflow change (like `selectedNodeId`), survives a fold↔unrolled toggle and live re-paints because `expandInstances` re-runs after every `paintOverlay` tick off the same Set.

## Execution tab's fate: **demoted to the expand; `runModelToGraph` kept as a fallback engine** (unchanged)

- `ViewMode` collapses `'execution' | 'plan' | 'overlay'` → **`'plan' | 'run'`** (rename `overlay`→`run`; three buttons → two: **Plan / Run**). `handleSelectRun` (`App.tsx:370-377`) lands *both* running and finished runs on `run` (today `:376` sends finished → `execution`).
- **Do not delete** `runModelToGraph` / `mapping.ts` / `AgentCardNode`. Reused as: (a) the expand renders instance cards via a shared `agentToCardData(agent)` extracted from `mapping.ts` (one source of truth); (b) `runModelToGraph` is the **graceful-degrade fallback** when `overlayError` / `!runPlan` and the engine behind "Expand all."
- `unplannedAgentIds` get a synthetic **"unplanned" lane** at the end of the run graph (same card construction), closing the honesty gap that removing the tab would open.

---

## BEFORE / AFTER mockups (updated for rev. 3)

**BEFORE — Run view, `research ×7` collapsed (today's Progress + a `▾` caret):**

```
┌─ ① SETUP ───────┐   ┌─ ② RESEARCH ──────────────────────────┐   ┌─ ③ SYNTH ───────┐
│ build the plan  │   │  parallel research: client avail, …    │   │                 │
│ ┌────────────┐  │   │   ┌───────────────────────────────┐    │   │  ┌───────────┐  │
│ │ scope      │──┼─●▶│   │ research:${r.key}   ×7    [▾]  │──◌─┼──▶│  │ synthesize│  │
│ │  1/1 done  │  │fan│   │ 6/7 done · 1 failed  (amber)  │ mrg│   │  │ 7/7 done  │  │
│ └────────────┘  │   │   └───────────────────────────────┘    │   │  └───────────┘  │
└─────────────────┘   │      ↑ stacked silhouette = ×7 fanned   │   └─────────────────┘
   ● fan-out  ◌ merge └────────────────────────────────────────┘
   [▾] shows when bindAgentIds.length > 1 OR (status≠not-run AND multiplicity is fanned)
       → a ×7 that bound only 1 surviving instance is STILL expandable (shows that 1).
   Lane boxes are ALREADY top-aligned to a common baseline (one-time normalization at
   overlay build, NOT on expand) so the spine is ~horizontal before anything is clicked.
```

**AFTER — clicked `▾`: ONLY the RESEARCH lane changes shape; SETUP/SYNTH keep their exact X *and* Y (baseline was normalized once, up front — no first-click jump):**

```
┌─ ① SETUP ──────┐  ┌─ ② RESEARCH ─────────────────────────────────────────────┐  ┌─ ③ SYNTH ──┐
│ ┌───────────┐  │  │  ┌─────────────────────────────┐                          │  │ ┌────────┐ │
│ │ scope     │──┼●▶│  │ research:${r.key}  ×7   [▴]  │──◌──────────────────────┼──┼▶│ synth  │ │
│ │  1/1 done │  │  │  │ 6/7 done · 1 failed (amber)  │ merge → template id     │  │ │7/7 done│ │
│ └───────────┘  │  │  └─────────────────────────────┘  (edge has NO waypoints, │  │ └────────┘ │
│  ↑ UNCHANGED   │  │  ╭┄┄ instances (7) ┄┄┄┄┄┄┄┄┄┄┄┄┄┄  so it re-docks live)   │  │ ↑ UNCHANGED│
│   (X and Y)    │  │  ┊ ┌────────────┐┌────────────┐┌────────────┐┌──────────┐ ┊ │  │  (X and Y) │
└────────────────┘  │  ┊ │research:    ││research:    ││research:    ││research: │ ┊ │  └────────────┘
                    │  ┊ │ availability││ contract    ││ graph-viz   ││ ts-stack │ ┊ │
                    │  ┊ │●done 8.3k 12t│●done 9.1k 14t│●done 6.0k 9t │●done 5.5k │ ┊ │
                    │  ┊ └────────────┘└────────────┘└────────────┘└──────────┘ ┊ │
                    │  ┊ ┌────────────┐┌────────────┐┌────────────┐             ┊ │
                    │  ┊ │research:    ││research:    ││research:    │  ← red     ┊ │
                    │  ┊ │ ui-direction││ connection  ││ stack  ✗ERR │   border   ┊ │
                    │  ┊ │●done 6.8k 10t│●done 4.4k 8t │error · — · 2t│   POPs     ┊ │
                    │  ┊ └────────────┘└────────────┘└────────────┘             ┊ │
                    │  ╰┄┄┄┄┄┄┄┄┄ instanceGroup: explicit style{w,h} ┄┄┄┄┄┄┄┄┄┄╯ │
                    │      sized to header + ceil(7/4)=2 rows; cards have NO       │
                    │      extent:'parent' → a sizing error OVERFLOWS, never clips │
                    └──────────────────────────────────────────────────────────────┘
  The RESEARCH lane's style.height grows by drawerH (== drawer style.height + DRAWER_GAP,
  one source of truth). Same-lane siblings with y > templateY shift DOWN by drawerH
  (arithmetic re-flow, NOT a free bloom — a 2nd stacked node WOULD overlap).
  SETUP/SYNTH keep X (elk partitions phases into disjoint bands) AND Y (baseline already
  normalized once at overlay build — expand does NOT re-origin any other lane).
  Node order on append: lane → instanceGroup (rank 2) → agentCards (rank 3), so parent
  precedes children; a dev assertion checks every child index > its parent index.
  NO 2nd elk pass; spine/merge edges re-route automatically (type:'default', no waypoints).
  Click any instance card → DetailPanel (state/model/tokens/tools/result + ✨) via type:'agentCard'+agentId.
  Caret click calls e.stopPropagation() + ExpandContext.toggle(id); body click → DetailPanel.
```

**LIVE run, partially-spawned `×7` — honest upcoming, with the unbounded case fixed:**

```
  FIXED ×7 (known cardinality): ghosts = total − bound
  ╭┄┄ instances · ×7 planned · 2/7 done · 4 running ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╮
  ┊ ┌────────────┐┌────────────┐┌────────────┐┌────────────┐┌────────────┐ ┊
  ┊ │● done      ││● done      ││◐ running…  ││◐ running…  ││◐ running…  │ ┊   real run.agents
  ┊ └────────────┘└────────────┘└────────────┘└────────────┘└────────────┘ ┊
  ┊ ┌┄┄┄┄┄┄┄┄┄┄┄┄┐                                                          ┊
  ┊ ┊  upcoming  ┊  ← 1 ghost slot (7 planned − 6 present); carries NO per- ┊
  ┊ └┄┄┄┄┄┄┄┄┄┄┄┄┘    instance data. Only when total is a KNOWN count.       ┊
  ╰┄┄┄┄ drawer style.height counts this ghost row too (no clip) ┄┄┄┄┄┄┄┄┄┄┄╯

  UNBOUNDED ×N, live & partial: computeTotal returns boundCount (== 2), NEVER 'N' mid-run
  (overlay.ts:211-217 → 'N' only when boundCount===0), so we CANNOT key off total==='N'.
  One "+ more" tile, gated on multiplicity.kind==='unbounded' && live && bindStatus==='partial':
  ╭┄┄ instances · ×N (unbounded) · 2 spawned · 2 running ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╮
  ┊ ┌────────────┐┌────────────┐┌┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┐                     ┊
  ┊ │◐ running…  ││◐ running…  ││  + more upcoming   ┊  ← single tile,     ┊
  ┊ └────────────┘└────────────┘└┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┘    never a fake N.   ┊
  ╰┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╯
```

Live rules summary: **state flip = paint-only (no relayout)**; **count change = re-grid + lane re-flow (drawer style.height + lane growth both recompute)**; **a live tick NEVER re-fits** — `fitSignature` is frozen to the PLAN node set (instance/ghost ids excluded), and the expand `fitBounds(union(viewport, drawerRect))` is a separate one-shot keyed on a node ENTERING `expandedNodeIds`. **Baseline is normalized once at overlay build — expand/collapse never re-origins a neighbor lane.**

---

## Files to touch (absolute paths)

- `/Users/nicolas/devel/argus/apps/web/src/App.tsx` — `ViewMode`→`'plan'|'run'`; two-button toggle; `const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(new Set())` (reset on run/workflow change like `selectedNodeId`); wrap `<ReactFlow>` in an **`ExpandContext.Provider`** exposing `toggle(id)`; keep global `onNodeClick` (`:427`) for body→`DetailPanel`; **freeze `fitSignature` (`:338-340`) to the PLAN node id set** (exclude `instanceGroup`/`agentCard` children before `.map(id).join`); update `isWideShort` (`:350`) to `'plan'|'run'`; add a **separate one-shot expand `fitBounds`** effect keyed on `expandedNodeIds` membership; "Expand all"; fallback to `runModelToGraph` when `!runPlan`/`overlayError`; `handleSelectRun` (`:370-377`) lands both running+finished on `run`; remove the Execution button + its caption/header/loading arms (`:390-396`).
- `/Users/nicolas/devel/argus/apps/web/src/overlay-expand.ts` — **new**: a pure **one-time `normalizeLaneBaseline(graph)`** pass (top-align lanes once at overlay build) + pure `expandInstances(graph, overlay, run, expandedNodeIds, live)` run *after* `paintOverlay`. Per expanded node: read `bindAgentIds` → resolve `run.agents` → build cards via shared `agentToCardData` → emit `instanceGroup` (with explicit `style:{width,height}`) + grid-positioned `agentCard` children (**no `extent:'parent'`**); **grow the host lane height by exactly `drawerH = instanceGroup.style.height + DRAWER_GAP`**; **shift same-lane siblings with `y > templateY` down by `drawerH`**; append in lane→drawer→cards order and extend the rank so `instanceGroup`<`agentCard`; emit fixed-count ghosts vs the single unbounded-live "+ more" tile per the precedence above; dev assertion that every child index > its parent index and no card rect exceeds its drawer rect. Keeps `paintOverlay` pure.
- `/Users/nicolas/devel/argus/apps/web/src/nodes/InstanceGroup.tsx` — **new**: the dashed "instances (N)" drawer (mirrors `LoopContainer`'s shell; header = label + `aggregateChipText` + `[▴]`); reads its size from `style` (per `mapping.ts` / `plan-model-mapping.ts:334`).
- `/Users/nicolas/devel/argus/apps/web/src/nodes/PlanNodes.tsx` — add the `[▾]/[▴]` caret + `is-expanded` to `PlanAgentNode`, gated on `bindAgentIds.length > 1` **OR** (`status≠not-run` AND fanned multiplicity); the caret's `onClick` calls `e.stopPropagation()` + `useContext(ExpandContext).toggle(id)`; register `instanceGroup` in `nodeTypes`. `aggregateChipText` reused verbatim.
- `/Users/nicolas/devel/argus/apps/web/src/expand-context.ts` — **new (small)**: `ExpandContext = createContext<{ toggle(id): void; expanded: Set<string> }>` so the caret reaches the toggle without putting a function on `node.data`.
- `/Users/nicolas/devel/argus/apps/web/src/mapping.ts` — extract `agentToCardData(agent)` (shared by the kept execution-fallback path + the new expand). No behavior change.
- `/Users/nicolas/devel/argus/apps/web/src/nodes/AgentCardShell.tsx` (+ `index.css`) — a ghosted "upcoming" card variant + a "+ more upcoming" tile variant for the live count-gap.
- **No change** (data already expand-ready; Stance 4 preserved): `overlay.ts`, `overlay-paint.ts` (already paints `bindAgentIds`), `plan-model-mapping.ts`, `layout/elk.ts`, `packages/contract/src/index.ts` — no on-disk/wire field, no invented edge.

**Bottom line:** lane-drawer remains the winner — the only option that delivers the spatial "expand the step in place" vision *and* avoids a second elk solve. Rev. 3 closes the three axis-(a)/axis-(b) gaps with verified facts: the expand is now spatially local in Y (top-align is a **one-time** baseline normalization at overlay build, not an expand side-effect, so neighbor lanes never jump on the first click — `plan-model-mapping.ts:306-311`); parent-before-child order is re-established by `expandInstances` itself with an extended rank (`instanceGroup` < `agentCard`) and a dev assertion (`:420-421`); and the doubly-nested clip risk is removed by giving the drawer an explicit `style:{w,h}` (one source of truth with the lane growth) and dropping `extent:'parent'` on the cards (`:397`) so sizing errors overflow visibly rather than clipping a real instance. The rev.-2 corrections still hold: no-2nd-ELK-pass via waypoint-free edge re-routing (`:423-428`), a widened caret gate (1-survivor fans stay expandable), the unbounded "+ more" tile keyed on `unbounded && live && partial` (since `total` is never `'N'` mid-run, `overlay.ts:211-217`), and decoupled refits. Execution is removed as a tab but survives as the expand content, "Expand all," and a plan-less/unplanned-agent fallback engine.