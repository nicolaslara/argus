I now have everything verified. The reviewer's finding is correct and confirmed against the real code:

- discovery.ts:387-416 loops over EVERY session dir and EVERY `wf_*` dir, pushing one running `RunSummary` per live journal, each with `workflowName: ''`.
- The merge in routes.ts means the Rail receives N>=1 such entries.
- Two concurrent dogfood runs (an `implement.js` while `refine-plan.js` runs) = two `status: 'running'` entries = two LIVE nodes = two pulsing `◌`, which breaks the "exactly ONE animated token per visible region" budget.

The previous design used `runs.find((r) => r.status === 'running')` (singular) which silently dropped the second live run, and the LIVE node was a single node. The fix is to make LIVE a **region (group)** holding N>=1 running runs, with the pulse capped to the group header.

Below is the revised design, regrafted to fold the medium-severity multi-live-run finding into graft A. This is the verbatim output.

---

All claims are now verified against the real code:

- **discovery.ts:387-416** — the live-discovery loop iterates EVERY session dir and EVERY `wf_*` run dir, and for each journal classified `running` it **pushes a separate `RunSummary`** with `workflowName: ''`, `agentCount: 0`, `durationMs: null`, `startTime: st.mtimeMs`. There is **no dedup and no cap** — N concurrent live journals ⇒ N running entries. Confirmed: the singular "the one live run" assumption was wrong.
- **routes.ts** merges all discovered running entries into the single `runs` list the Rail receives (App.tsx:451 `runs={runs}`).
- **status-completed (index.css:900)** is `#3fb950` green; **status-running (index.css:911)** is `var(--argus-accent)`. The green/blue color-semantic collision in graft B is real.
- **App.tsx:123** polls at 2500ms while ANY run is `running`; **format.ts:31** reads `Date.now()` at render. Stable-`startTime` keying is the correct fix.
- **handleSelectRun (App.tsx:370-377)** routes a running run to `'overlay'` (Progress), finished to `'execution'`. The view-routing table is correct; no App.tsx change needed.
- **Data reality flag (unchanged):** live `RunSummary` has `agentCount: 0`, `durationMs: null`, `startTime = mtimeMs` (not true start). Elapsed must be derived client-side; agent count is unavailable until finalize.

The one change in this revision is the **(medium) multi-live-run finding**: the previous design assumed exactly ONE live run (`runs.find(r => r.status === 'running')`, a single `<LiveNode>`, the whole pulse budget on one `◌`). But two concurrent dogfood runs produce **two** `status:'running'` entries with `workflowName:''`. The fix: **LIVE is a region (a group), not a node** — a pinned-top "Live" section that holds N>=1 running runs, and the pulse budget is redefined as **one pulse per region**, so the live group pulses exactly once (on its header) regardless of child count.

---

# argus sidebar — revised design (tree, regrafted for the live-run data contract + multi-live)

The winner is unchanged — the **VS Code-style tree** wins the axis the brief is graded on (hierarchy must be OBVIOUS and calm), ties best on canvas-first fit, is the most familiar pattern, and needs **no `App.tsx` logic change**. What changed is the *graft set*, driven by four verified reviews:

1. **(high) The live run has no resolvable workflow while running, so it cannot nest under a workflow node.** Verified: `discovery.ts:408` hard-codes `workflowName: ''`. The join key is `workflowName ↔ WorkflowMeta.name`, so `''` matches no workflow. **Fix: live runs are a first-class, NOT-name-joined case — pinned at the top, labeled from data that exists (ref/session + client-derived elapsed), never `LIVE → <blank>`.**
2. **(medium) There can be MORE THAN ONE live run.** Verified: the discovery loop emits one running `RunSummary` per live journal across all sessions/`wf_*` dirs with **no cap** (discovery.ts:387-416); the dogfood scenario (an `implement.js` run while a `refine-plan.js` run is going) yields **two** running entries. A single `LIVE` *node* + a single pulsing `◌` either drops the second run or mounts two pulses, violating the one-moving-token budget. **Fix: the LIVE region is a GROUP (a pinned-top "Live" section) holding N>=1 running runs; the pulse is capped to the group header glyph — one pulse per region, children static — see GRAFT A + the pulse budget.**
3. **(medium) The finalize transition is the one real reshuffle, and "frozen order" hid it.** Verified: on finalize, `runsQ` re-polls (2500ms), `workflowName` flips `'' → <real name>`, and the run migrates out of the LIVE region into its workflow node. **Fix: name it explicitly and make it calm — flash-settle it into its workflow node, rather than claiming "never reorders."**
4. **(medium) The rollup glyph `●` is green (`= done`), colliding with its intended "live inside" meaning.** Verified: `●` is `.status-completed` `#3fb950` (index.css:900), but the running token is `var(--argus-accent)` `#5b9dff` (index.css:911). **Fix: the rollup is the running ACCENT color + running shape (a static accent `◌`), never green `●`.**

(The original calmness review still holds and is kept: at most ONE animated token per visible region — now stated precisely as *the LIVE region is one region regardless of how many runs it holds*.)

```
EXPANDED — project · 3 workflows · ~12 runs · TWO RUNNING        width 264px
┌────┬───────────────────────────────────────────────┐
│ «  │  PROJECT                                        │  ← collapse chevron
│    │   ▾ argus                                  ⌄    │  ← switcher (caret only if >1)
│ ▤• │ ───────────────────────────────────────────────│
│    │                                                 │
│    │  ◌ LIVE                              2 running  │  ← REVISED GRAFT A: a LIVE *region*
│    │ ┆   wf_a1c2 · ≈2m14s                  ⤴         │     (group), pinned top. The GROUP
│    │ ┆   wf_b7e9 · ≈0m48s                  ⤴         │     HEADER ◌ is the ONE pulse; the
│    │ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │     N child rows are STATIC. NOT name-
│    │                                                 │     joined: labeled from ref (wf_<id>)
│    │  ▾ ◇ refine-plan        4 runs                  │     + CLIENT elapsed (≈, mtime-based);
│    │  ┆   ✕  2 ag · 22s   · 2d ago                   │     NO agent count (unpopulated live).
│    │  ┆   ◼  3 ag · 40s   · 5d ago                   │     ⤴ on a child → that run's Progress.
│    │  ┆   ●  5 ag · 58s   · 4h ago                   │
│    │  ┆   ●  4 ag · 1m12s · 1d ago                   │  ← while live, those runs are NOT here
│    │                                                 │     yet (workflowName='' ⇒ unjoinable);
│    │  ▾ ◇ plan-research              4 runs          │     each GRAFTS IN on its own finalize
│    │  ┆   ● 14 ag · 6m02s · 5m ago                   │     (graft C). Group order FROZEN to the
│    │  ┆   ◐ 14 ag · 5m48s · 1h ago                   │     first runs payload (graft D), keyed
│    │  ┆   ✕  4 ag · 22s   · 3h ago                   │     on STABLE startTime ⇒ the 2.5s live
│    │  ┆   ● 11 ag · 4m11s · 1d ago                   │     poll never reshuffles it.
│    │                                                 │
│    │  ▸ ◇ implement          5 runs            ◌     │  ← COLLAPSED workflow with a POST-FINALIZE
│    │                                                 │     running run rolled up: a STATIC ACCENT
│    │  ▾ ◷ (other runs)       1                       │     ◌ (#5b9dff), NEVER green ● (graft B).
│    │  ┆   ● fix-flaky · 14s · 1 ag · 6d ago          │
│    │                                                 │
│ ⚙  │ ───────────────────────────────────────────────│
└────┴───────────────────────────────────────────────┘
   ◇ = workflow definition   ◷ = orphan bucket   ┆ = guide rail
   ● completed  ◐ partial  ✕ failed  ◼ killed  ◌ running
   PULSE BUDGET (calm): exactly ONE animated token per VISIBLE REGION, where the
   LIVE region counts as ONE region no matter how many runs it holds —
     • the LIVE group HEADER ◌ pulses (the single live affordance); its N child
       rows are STATIC accent ◌ (one pulse for the whole region, N≥1)
     • once a run finalizes, its now-completed in-tree glyph is ● green, STATIC
     • a collapsed workflow's live rollup uses the ACCENT ◌ (#5b9dff), STATIC,
       and shows ONLY when that workflow is collapsed AND contains a (post-finalize)
       running run — NEVER the green ● (that means 'done')
     • the collapsed-strip corner dot pulses ONLY when the panel is collapsed
       (the panel isn't visible then, so it's never concurrent with the LIVE region)

THE ONE REAL TRANSITION — running → finalized (graft C, made explicit & calm)
  poll N    :  LIVE region holds wf_a1c2 (≈2m14s) and wf_b7e9 (≈0m48s)   ← both workflowName=''
  poll N+1  :  wf_a1c2's workflowName flips '' → 'refine-plan' (finalized json now exists)
              that ONE run MIGRATES: it leaves the LIVE region (which still holds wf_b7e9,
              so the region — and its single header pulse — persists) and appears inside
              the 'refine-plan' node as a STATIC ● that briefly FLASHES (settle).
  → designed, not hidden: one move per finalize, animated as "this run finished and
    settled into its workflow." The LIVE region survives as long as ≥1 run is still live.

COLLAPSED — icon strip (52px, unchanged width)
┌────┐
│ »  │  expand
│ ▤  │  EXPLORER (active)
│  • │  ← ONE pulsing accent ● on the icon corner IFF any run in this project is live
│    │     (one dot for N live runs — it signals "something is live", not a count)
│ ⚙  │  settings (pinned bottom)
└────┘
```

### Why this is NOT weird (the tree's core thesis, kept)
The current panel renders Workflows and Runs as **two flat sibling lists**, asserting they're peers — but a run is an *instance of* a workflow. The reader re-joins the lists by reading the workflow name repeated on every run row; that re-join is the "weird." The tree makes containment **literal**: a finished run is drawn inside its workflow like a file inside a folder. There's nothing to re-join because the join *is* the indentation, and the run row drops the now-redundant workflow name (the dominant source of clutter). Saturated color is rationed to status only (`status-*`); twisties, `◇` diamonds, counts, and guide rails are one neutral gray ramp.

### Live runs are a first-class REGION, NOT name-joined, and there can be N of them (addresses reviews #1 + #2)
This is the load-bearing correction. While a run is `running`:
- its `workflowName` is `''` (discovery.ts:408) — it is **structurally unjoinable** to any `WorkflowMeta`, so it CANNOT render under a workflow node;
- and there can be **more than one** (the discovery loop emits one running `RunSummary` per live journal with no cap — discovery.ts:387-416), so a single node is wrong;
- therefore all running runs render inside a **dedicated pinned-top `LIVE` group** (a labeled region, like the orphan bucket but pinned to the top and styled live). Each child row is labeled from data that *actually exists*: the run ref (`wf_<id>` from `ref.runId`) and a **client-derived elapsed** (`≈`, see data note). It is **never** `LIVE → <workflow>`;
- the **group header carries the one pulsing `◌`**; the N child rows are **static** accent `◌`. The pulse budget is *one pulse per region*, and the LIVE region is one region regardless of child count — so two concurrent dogfood runs still mount exactly one moving token in the expanded panel;
- clicking a child row (or its `⤴`) calls `handleSelectRun(thatRun)` → `view='overlay'` (Progress), exactly as App.tsx:376 already routes a running run. No App.tsx change. (Selecting the group *header* is a no-op / expand toggle; a region isn't a run.)

> **Data note (verified, important):** a live `RunSummary` has `agentCount: 0` and `durationMs: null` (discovery.ts:410-411), and `startTime` is `st.mtimeMs` ("last active"), not the true start. So LIVE child rows must NOT print `N ag` or rely on `durationMs`. Elapsed is computed client-side from `startTime` (caveat: mtime-based, prefixed `≈`), and agent count is omitted until finalize. The mockup's per-run `N ag` meta applies only to **finalized** rows.

### The finalize migration, named and made calm (addresses review #3)
The data contract guarantees **exactly one reorder per finalize**, and the design owns it:
- on the poll where a run's `workflowName` flips `'' → <real>` and `status` flips `running → completed/...`, that **one** run leaves the LIVE region and grafts into its workflow node as a STATIC finished glyph;
- this single move is **flash-settled** (a brief highlight on the destination row) — "this run finished and settled into its workflow," intentional and calm;
- the receiving workflow is force-expanded for that transition (graft D) so the settle is visible;
- crucially, with N live runs the **LIVE region persists** across one child's finalize as long as ≥1 running run remains — its single header pulse just keeps going. The region collapses (unmounts) only when its last live run finalizes.

### The calmness contract (addresses the original calmness review, now multi-live-safe)
At most one animated token is mounted per visible region, and the LIVE region is **one region**.

| token | when shown | motion |
|---|---|---|
| LIVE group **header** `◌` (graft A) | ≥1 project run is `running` | **pulses** (the one live affordance for the whole region) |
| LIVE group **child** rows `◌` | one per running run (N≥1) | **static** accent `◌` (no per-child pulse) |
| finalized run's in-tree glyph | always, on finished rows | **static** (`● ◐ ✕ ◼`, color = status) |
| workflow live-rollup (graft B) | only when that workflow is **collapsed** AND contains a (post-finalize) running run | **static**, ACCENT `◌` `#5b9dff` — never green `●` |
| collapsed-strip corner `•` (graft E) | only when the **panel is collapsed** AND ≥1 run is live | pulses (one dot for N live; panel not visible ⇒ never concurrent with the LIVE region) |

In the common case (any number of live runs, expanded) the only moving thing in the expanded panel is the single LIVE group header. Because running runs live in the LIVE region (not under a workflow), the live-rollup is structurally a **post-finalize collapsed-workflow** signal — it never competes with the LIVE region for the same run.

### Stable ordering + no first-paint reshuffle (addresses the stable-keying review)
Keyed entirely on data that does **not** change between polls:

1. **Group (workflow) order is computed once from the first non-empty runs payload, then frozen.** Order key = `max(startTime)` of the group's finished runs — an immutable scalar. Memoized: an identical `runs` array yields the *same* order by reference. Because `runsQ` polls every 2500ms (App.tsx:123) but `startTime` is immutable per finalized run, a poll that only refreshes displayed durations/relative-times produces an identical key and therefore **no reorder**. (`formatRelativeTime` reads `Date.now()` at render — format.ts:31 — which is why the sort must NOT key on the displayed string.)
2. **LIVE region child order** uses the existing `runsNewestFirst` (Rail.tsx:45) on stable `startTime` (mtime-based, but stable between polls absent a fresh append) — newest live run on top.
3. **Run order within a workflow group** uses `runsNewestFirst` on stable `startTime` — already poll-stable.
4. **Resolved-default vs explicit selection stays visible-but-quiet.** Rail still receives `selectedRunId={summary?.ref.runId}` (App.tsx:452) — *unchanged*. The tree highlights it but does **not** auto-expand a group merely because it holds the resolved-default run. Only (a) the actively-selected workflow and (b) on a finalize transition, the workflow that just received a live run are force-expanded.

### Selection → view (unchanged App.tsx — verified lines 362–385)
| Click | Handler | View |
|---|---|---|
| Workflow **body** `◇ name` | `handleSelectWorkflow(w)` | **Plan** (+ syncs newest run) |
| Workflow **twisty** `▸/▾` | local expand toggle | *(no nav — VS Code folder semantics)* |
| Run row, finished `● ◐ ✕ ◼` | `handleSelectRun(r)` | **Execution** (`r.status !== 'running'` → App.tsx:376) |
| **LIVE child row** `◌` / its `⤴` | `handleSelectRun(thatRun)` | **Progress** (`overlay`, App.tsx:376) |
| **LIVE group header** | local expand toggle | *(no nav — a region isn't a run)* |
| collapsed-strip corner dot | *(expands the panel to the LIVE region)* | — |
| Project switcher | `handleSelectProject(p)` | re-scopes, keeps view |

---

## The grafts (revised)

**GRAFT A — first-class LIVE REGION holding N≥1 running runs (was: a single name-joined LIVE node).** Running runs are unjoinable (`workflowName=''`, discovery.ts:408) and there can be more than one (no cap in the discovery loop, discovery.ts:387-416). They render in a dedicated pinned-top `LIVE` **group** — like the orphan bucket, but pinned top and styled live. The **group header** carries the ONE pulsing `◌` (`2 running` count beside it); each child row is a **static** accent `◌`, labeled from `ref.runId` + client elapsed (`≈`), with `agentCount`/`durationMs` omitted (both unpopulated live). Click a child → its Progress view. Solves both the "live run buried in a collapsed/scrolled group" weakness AND the multi-live dogfood case with an O(1) fixed top slot, *without* depending on data that doesn't exist yet, and **without** exceeding the one-pulse-per-region budget.

**GRAFT B — workflow live-rollup, accent-colored and context-exclusive (review #4 color + calmness).** Shown **only on a collapsed workflow that contains a running run**, STATIC, rendered as the ACCENT `◌` (`#5b9dff`, `--argus-accent`) — never the green `●` (which means "done"). Because running runs live in the LIVE region, this is effectively a *post-finalize* collapsed-state signal, so it never double-signals a run that's still in the LIVE region. The instant the workflow is expanded, the in-tree glyph takes over and the rollup is dropped.

**GRAFT C — explicit finalize migration, region-survives (review #3 + multi-live).** The `'' → <name>` flip on a finalize poll moves the **one** finalized run from the LIVE region into its workflow node, flash-settled, force-expanded for that transition. The LIVE region persists (single header pulse intact) while ≥1 running run remains; it unmounts only when the last live run finalizes. Not hidden behind "never reorders"; it is "exactly one calm reorder per finalize."

**GRAFT D — recency order, frozen + stable-keyed.** Group order key = `max(startTime)` on immutable scalars; memoized; computed once from the first runs payload and stable thereafter. The 2.5s poll never reshuffles. Force-expand only the actively-selected workflow and (on finalize) the receiving workflow. Declared-but-unrun workflows still render their header (`0 runs`, clickable → Plan).

**GRAFT E — collapsed-strip live pulse (calm by construction, one dot for N live).** A single pulsing accent `●` on the `▤` icon corner, mounted only when `runs.some(r => r.status === 'running')` AND the panel is collapsed. It signals "something is live," not a count — one dot regardless of how many live runs exist. Since the expanded panel (with the LIVE region) isn't on screen when collapsed, this pulse is never concurrent. Reuses `argus-pulse` (index.css:162) + `--argus-accent`.

**Deliberately REJECTED grafts (unchanged):**
- run-first's **filter-chip strip** — replaces hierarchy with a facet, reintroduces per-row workflow name. No.
- two-pane's **runs-hidden-until-click** — costs a click + an App.tsx prop change for no hierarchy gain. No.
- calm-grouped's **`position: sticky` blurred headers** — most CSS-fragile piece inside the one `overflow-y:auto` container (index.css:755). No.

---

## Implementation notes (verified against the real tree)
- **No `App.tsx` logic change.** Handlers + view routing already match (lines 362–385; running→`overlay` at 376). `RailSection` stays. Derive the live set in `Rail` from the existing `runs` prop via **`runs.filter(r => r.status === 'running')`** (plural — the multi-live fix; the old singular `.find` is replaced). `selectedRunId={summary?.ref.runId}` (App.tsx:452) stays as the resolved default; graft D does not force-expand on it.
- **Rail.tsx**: replace the two `.rail-group` blocks (lines 146–222) with: `buildTree()` (join finalized runs by `workflowName ↔ WorkflowMeta.name`; **running runs are pulled OUT into the LIVE region via `.filter`, NOT joined, NOT collapsed to one**; group-order key `max(startTime)`, memoized + frozen per graft D); a `<LiveGroup>` (graft A — rendered only when `liveRuns.length > 0`; a header with the count + the single pulsing `◌`, and `liveRuns.map(...)` static child rows labeled from `ref.runId` + client elapsed, no `agentCount`/`durationMs`); `WorkflowTreeNode` (local `open` state, force-open iff actively-selected or just-received-a-finalized-live-run per graft C); `RunRow` (drops `workflowName`); `OtherRunsBucket` (orphans = finished runs whose `workflowName` matches no `WorkflowMeta`). Keep `ProjectSwitcher`, `runsNewestFirst` (line 45, reused to order LIVE children too), the strip, settings.
- **index.css** (rail block 685–949): add `.rail-tree-*` (twisty, `◇` kind glyph, count); `.rail-live-group` (pinned-top region: a header with a **pulsing** `◌` + count, `┆` guide rail to its children, `.rail-live-child` rows with a **static** accent `◌` + `⤴`, dashed `.rail-divider` under the group); `.rail-rollup` = a **static `--argus-accent` `◌`** on collapsed headers (NOT `.status-completed`); a flash-settle keyframe for the finalize migration; the collapsed-strip corner dot (pulsing, mounted only when collapsed + live). Reuse `argus-pulse` (162), `--argus-accent` (5), `status-*` (899–913 — `.status-completed` `#3fb950` reserved for done only), `.rail-indent` (836). **Net: exactly TWO elements ever carry `argus-pulse` — the LIVE *group header* `◌` (one, even with N live children) and the collapsed-strip corner — and they are never on screen simultaneously.**
- **format.ts** — unchanged (`statusGlyph` → `◌/◐/●/✕/◼`, `formatDuration`, `formatRelativeTime` reused). LIVE-region elapsed is computed in `Rail` from `startTime` (mtime-based, prefixed `≈`), since `durationMs` is `null` while live.
- **Contract**: `RunSummary.workflowName` ↔ `WorkflowMeta.name`; live runs carry `workflowName: ''`, `agentCount: 0`, `durationMs: null`, `startTime = mtimeMs` (discovery.ts:405-415), and there may be **N≥1** of them (no cap in the loop) — the LIVE-region treatment is built directly on these facts. `RunSummary.partialFailure` is a plain boolean (correct for every `r.partialFailure` use in the rail).
- **Fixture verification (recommended):** confirm the LIVE-region path against real running runs under `~/.claude/projects/-Users-nicolas-devel-argus/<session>/workflows/` (`wf_*` dirs with a fresh `journal.jsonl` and no finalized `wf_*.json`). To exercise the **multi-live** case specifically, have two workflow runs in flight at once (e.g. `implement.js` + `refine-plan.js`) — the dogfood scenario the project itself produces.

**Files:** `/Users/nicolas/devel/argus/apps/web/src/shell/Rail.tsx`, `/Users/nicolas/devel/argus/apps/web/src/index.css` (rail block lines 685–949), `/Users/nicolas/devel/argus/apps/web/src/shell/format.ts` (unchanged), `/Users/nicolas/devel/argus/apps/web/src/App.tsx` (unchanged), `/Users/nicolas/devel/argus/packages/adapter/src/discovery.ts` (live-run emission at lines 405–415: `workflowName:''`, `agentCount:0`, `durationMs:null`, `startTime:mtimeMs`; **emitted once per live journal with no cap — N≥1**, lines 387–416), `/Users/nicolas/devel/argus/packages/contract/src/index.ts` (`RunSummary.workflowName` ↔ `WorkflowMeta.name`; `RunSummary.partialFailure` plain boolean).