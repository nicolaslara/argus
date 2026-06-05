# argus visualization best practices

A single, actionable design spec for the argus redesign. It consolidates six research
angles (layout/routing, workflow-tool conventions, trace observability, decisions/loops,
aesthetics, multiplicity) into concrete changes for the React Flow + elkjs + node-component
layer.

Anchored to the current code:
- ELK options live in `apps/web/src/layout/elk.ts` (`planLayout`).
- The state palette is `STATE_COLOR` in `apps/web/src/nodes/AgentCard.tsx`.
- Tokens / node CSS live in `apps/web/src/index.css`.
- The shared card is `apps/web/src/nodes/AgentCardShell.tsx`.

Today's code already does several right things (a stacked-card `.plan-agent.is-fanned`
silhouette, `×N` chip, dashed loop container, `considerModelOrder=NODES_AND_EDGES`,
hidden handles, Primer-aligned state hexes). The changes below are mostly additive.

---

## 1. Recommendations for argus — issue → fix (priority order)

| # | Issue | Concrete fix (where) | Priority |
|---|-------|----------------------|----------|
| **5** | Nodes/edges OVERLAP; layout quality | In `elk.ts`: add `elk.spacing.edgeNode:'24'` + `elk.spacing.edgeEdge:'14'`, set `elk.edgeRouting:'ORTHOGONAL'`, raise `nodeNodeBetweenLayers` to `64`, add `elk.layered.thoroughness:'7'`. Pass **measured** node width/height (already shared via `CARD_SHELL_WIDTH`) into ELK so spacing math is correct. The missing `edgeNode`/`edgeEdge` pair is the direct cause of edges grazing boxes. [ELK spacing](https://eclipse.dev/elk/reference/options.html) | **P0** |
| **6** | Should read as a clean DASHBOARD | Ration saturated color to *state* only; make node bodies neutral gray (Linear/Vercel "one gray ramp + one accent"). Near-invisible dot grid (`--xy-background-pattern-dots-color-default:#161b22`), hairline 1px edges, tighter type scale (§7). Collapse each agent's lifecycle to one fat node. [Linear redesign](https://linear.app/now/how-we-redesigned-the-linear-ui), [Temporal](https://temporal.io/blog/lets-visualize-a-workflow) | **P0** |
| **3** | Decision/boolean unclear; branches "go to the same place" | Predicate **in** the node (`material.length > 0?`); **labeled** edges (`true`/`false`) via distinct `sourceHandle` ids; ELK `portConstraints:'FIXED_ORDER'` (true above false); route true straight-ahead, false to a consistent side; tint true=green / false=red; mark `[else]` with the BPMN default-flow slash. In execution, **paint the taken edge** bold and ghost the other at ~30%. (§4) [Camunda](https://docs.camunda.io/docs/components/modeler/bpmn/exclusive-gateways/), [ELK ports](https://eclipse.dev/elk/reference/options/org-eclipse-elk-layered-portSortingStrategy.html) | **P0** |
| **2** | Distinct-item fan-out collapses to one `×7` template | Split the model: `mapFanout` (same template ×N → keep collapsed stacked card + `×N`) vs `branchFanout` (distinct agents → N real labeled sibling cards, no `×N`). Discriminator = "same template vs distinct work." (§6) [AWS Map vs Parallel](https://docs.aws.amazon.com/step-functions/latest/dg/state-map.html), [Prefect #16081](https://github.com/PrefectHQ/prefect/issues/16081) | **P1** |
| **1** | Fan-out/merge BOX nodes feel redundant | Replace `.plan-process` boxes with a ~10px edge-junction marker (filled dot = scatter, hollow ring = gather), description on hover. Keep the marker node in the graph so ELK still routes through it. (§3) [BPMN gateways](https://www.visual-paradigm.com/guide/bpmn/bpmn-gateway-types/), [Temporal points-vs-bars](https://temporal.io/blog/lets-visualize-a-workflow) | **P1** |
| **4** | Loop back-edges awkward | Control reversal in ELK (`cycleBreaking.strategy:'DEPTH_FIRST'` or `MODEL_ORDER`) so YOUR loop edge becomes the back-edge; render it as a dashed, lower-contrast, `↺`-badged custom edge on a reserved channel built from ELK bend points. In execution, prefer an **attempt badge** (`×3`) + state color over redrawing the loop. (§5) [ELK cycleBreaking](https://eclipse.dev/elk/reference/options/org-eclipse-elk-layered-cycleBreaking-strategy.html), [Node-RED junctions](https://github.com/node-red/designs/discussions/62), [Temporal](https://temporal.io/blog/lets-visualize-a-workflow) | **P2** |

Cross-cutting (affects 1–6): standardize **one status color scale** + **two encoding channels**
(color = state, shape/icon = node type) across plan and execution so the two views read as one
dashboard. [WCAG 1.4.1](https://wcag.dock.codes/documentation/wcag141/).

---

## 2. Exact ELK layered options (left→right, overlap-free, clean routing)

Drop-in replacement for the root `layoutOptions` in `planLayout` (`elk.ts`). Comments mark
the deltas vs the current config (`nodeNodeBetweenLayers:40`, `nodeNode:88`,
`mergeEdges:true`, `nodePlacement:NETWORK_SIMPLEX`).

```js
{
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',                                  // left→right (keep)

  // --- routing: ORTHOGONAL reads as a dashboard, not an organic graph ---
  'elk.edgeRouting': 'ORTHOGONAL',                           // ADD
  'elk.layered.nodePlacement.favorStraightEdges': 'true',    // ADD (pairs w/ orthogonal)

  // --- spacing: the actual overlap cure ---
  'elk.spacing.nodeNode': '64',                              // was 88; 64 once edges get their own clearance
  'elk.layered.spacing.nodeNodeBetweenLayers': '64',         // was 40 (more lane separation)
  'elk.spacing.edgeNode': '24',                              // ADD — keeps edges off node borders
  'elk.spacing.edgeEdge': '14',                              // ADD — separates parallel fan-out arms
  'elk.layered.spacing.edgeNodeBetweenLayers': '24',         // keep
  'elk.layered.spacing.edgeEdgeBetweenLayers': '14',         // ADD — un-bunches fan/merge bundles
  'elk.spacing.edgeLabel': '8',                              // ADD — room for true/false labels

  // --- placement / crossings: tidy aligned rails ---
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',     // was NETWORK_SIMPLEX (straighter, aligned rails)
  'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED', // ADD — symmetric fan-out/merge
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',// default, explicit
  'elk.layered.thoroughness': '7',                           // ADD — fewer crossings (small ms cost)

  // --- determinism: keep PLAN and EXECUTION congruent + control branch order ---
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES', // keep
  'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',       // ADD — predictable loop back-edge (see §5)

  // --- hierarchy: phase lanes + loop container (ELK can route cross-lane; dagre cannot) ---
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',               // keep

  // --- DO NOT merge edges globally: it fuses distinct fan-out into one fat pipe ---
  'elk.layered.mergeEdges': 'false',                         // was 'true' — fights distinct fan-out (§6)
}
```

Notes:
- **`spacing.edgeNode` + `spacing.edgeEdge` are the headline fix for issue #5** — the current
  config sets neither at the root, so edges can hug boxes and parallel arms collide.
- **`mergeEdges:false`** is deliberate: `true` bundles edges to a shared endpoint, which is exactly
  what makes distinct fan-out look like one trunk (works against issue #2). If you ever want the
  hyperedge "single trunk that scatters" idiom for a *homogeneous* map, scope `mergeEdges:true` to
  that container only, never globally. [ELK mergeEdges](https://eclipse.dev/elk/reference/options/org-eclipse-elk-layered-mergeEdges.html)
- **`BRANDES_KOEPF`** tends to produce the straight, aligned "instrument-panel" look; `NETWORK_SIMPLEX`
  packs tighter but staggers. A/B them on the 7-arm research fan fixture. [ELK nodePlacement](https://eclipse.dev/elk/reference/options/org-eclipse-elk-layered-nodePlacement-strategy.html)
- **Consume ELK's bend points.** ELK returns `edge.sections[].bendPoints`; draw your edges through
  them with a custom React Flow `BaseEdge` instead of letting React Flow re-route. The overlap-free
  routing ELK computed is then what you actually see. [React Flow custom edges](https://reactflow.dev/examples/edges/custom-edges), [xyflow #5125](https://github.com/xyflow/xyflow/discussions/5125)
- **Handle sides** for `RIGHT`: every node `targetPosition:'left'`, `sourcePosition:'right'`, so
  edges enter left / exit right rather than crossing the node. [React Flow elkjs example](https://reactflow.dev/examples/layout/elkjs)
- The empty-band concern in the current comment is better solved by ELK's own aspect handling +
  fitView padding than by inflating `nodeNode` to 88; 64 + real edge clearance reads cleaner.

---

## 3. Fan-out / merge rendering — tiny marker, not a box (issue #1)

**Recommendation: demote both to a ~10px edge-midpoint marker; description on hover. Drop the
`.plan-process` box.** The edge topology already encodes scatter/gather; a labeled box adds no
information and is the dominant clutter source. This is the universal convention — Argo, GitHub
Actions, Airflow, and Dagster draw *no* glyph at all; BPMN uses only a small diamond. argus's
full box is the outlier. [BPMN gateways](https://www.visual-paradigm.com/guide/bpmn/bpmn-gateway-types/), [Argo DAG](https://argo-workflows.readthedocs.io/en/latest/walk-through/dag/)

Exact spec:
- **Fan-out (scatter):** a filled dot (8–12px), `--argus-accent`, faint. Multiplicity as a small
  superscript chip `×N` **only when replicas are identical** (§6). Item list / description on hover.
- **Merge (gather):** a hollow ring / concave chevron, neutral gray. Or simply *no marker* — let the
  downstream node be the join; converging edges already say "gather." A merge marker is never labeled
  (a labeled join is a modeling error). [Visual-Paradigm](https://www.visual-paradigm.com/guide/bpmn/bpmn-gateway-types/)
- **Why bars-vs-points:** in trace UIs, instantaneous topology events (signals, splits) are drawn as
  *points*, durations as *bars*. Fan-out/merge are instantaneous → points/markers, agents → cards.
  [Temporal](https://temporal.io/blog/lets-visualize-a-workflow)
- **Implementation:** keep the marker as a tiny custom node (`width/height≈10`, hidden handles) so
  ELK still routes through it; or render it as an edge `label`/`labelBgStyle` at the section midpoint.
  Connector strokes into the marker ≤1px.
- **Execution view alternative:** in a swimlane/timeline execution view, fan-out is N bars starting at
  the same x and stacking vertically — parallelism is shown for free, zero marker needed. Consider a
  Plan(DAG) / Execution(timeline) split or toggle. [OpenTelemetry waterfalls](https://oneuptime.com/blog/post/2026-02-06-read-interpret-opentelemetry-trace-waterfalls/view), [Langfuse tree/timeline](https://langfuse.com/changelog/2025-03-19-new-trace-view)

---

## 4. Decision / boolean rendering (issue #3 — most important for clarity)

The single rule that fixes "it's not obvious what's checked / which path is which / they all go to
the same place": **question on the node, answer on the edges, and physically diverging geometry.**
[Camunda exclusive gateway](https://docs.camunda.io/docs/components/modeler/bpmn/exclusive-gateways/), [go-uml guards](https://www.go-uml.com/guard-conditions-activity-diagrams-guide/)

1. **Predicate IN the node**, in plain language: render the actual condition `material.length > 0?`
   (a question), not the word "decision". Keep the diamond shape (universal decision cue) and draw an
   in-diamond marker: `X` = exclusive (one path), `+` = parallel (all), `O` = inclusive (one-or-more).
   Never an empty diamond. [Camunda symbols](https://camunda.com/bpmn/reference/)
2. **Label EACH outgoing edge with the answer** — `true`/`false` (or `yes`/`no`, or the guard
   `[> 0]` / `[else]`) — on a small chip with a background so it stays readable over the line, placed
   near the source handle. Labeling only one side is the #1 cause of ambiguity. [LinkedIn BPMN labeling](https://www.linkedin.com/advice/3/what-some-best-practices-naming-labeling-gateways-bpmn-diagrams)
3. **Distinct `sourceHandle` ids** (`true` / `false`) on the decision node so React Flow/ELK don't
   merge the two exits into one. Pin them with ELK `portConstraints:'FIXED_ORDER'` (or `FIXED_SIDE`),
   true-port ordered above false-port. With `considerModelOrder` already on, order the true edge first
   in the model so it renders on top. [ELK portConstraints](https://eclipse.dev/elk/reference/options/org-eclipse-elk-layered-portSortingStrategy.html)
4. **Consistent branch geometry:** primary/true continues **straight in flow direction (right)**;
   false/exception drops to **one consistent perpendicular side (e.g. down)**. Consistency across all
   decisions is what makes them instantly legible. [Creately](https://creately.com/blog/software-teams/part-1-15-mistakes-you-would-unintentionally-make-with-flowcharts/), [SmartDraw](https://www.smartdraw.com/flowchart/flowchart-symbols.htm)
5. **Color the branches:** true = green edge, false = red/neutral edge (per-edge `style.stroke`,
   which React Flow honors over the var). Mark the fallback/`[else]` edge with the BPMN default-flow
   back-slash tick. Guards must be mutually exclusive + exhaustive with an explicit default so no path
   is stuck and branches reach **distinct targets** (only re-converge at an explicit, unlabeled merge).
6. **Execution painting:** bold + animate the **taken** edge; ghost the not-taken branch at ~30%
   opacity, dashed. This is what removes "they all appear to go to the same place" at run time —
   exactly one edge lights up. [LangGraph Studio path painting](https://deepwiki.com/langchain-ai/langgraph-studio/5.2-graph-visualization)
7. Give decisions extra local room (branch labels need space): a larger `nodeNode` on the decision's
   layer, plus `spacing.edgeLabel` (set in §2).

Current code already has a `.plan-decision` SVG diamond with an amber stroke — keep the shape, add
the in-diamond marker, the labeled/colored handles, and the consistent geometry.

---

## 5. Loop / back-edge routing (issue #4)

Two layers: control the reversal in ELK, then style the line in React Flow.

**ELK side:**
- Set `cycleBreaking.strategy:'DEPTH_FIRST'` (or `MODEL_ORDER` / `GREEDY_MODEL_ORDER`) so ELK reverses
  the edge **you** intend (the loop-back), not an arbitrary greedy pick. This is the root cause of
  "weird back-edge lines." [ELK cycleBreaking](https://eclipse.dev/elk/reference/options/org-eclipse-elk-layered-cycleBreaking-strategy.html)
- Keep the loop body as the nested compound container already modeled in `elk.ts`. Give the back-edge
  clearance via the `edgeEdge` / `edgeNode` spacing in §2 so it hugs the container margin instead of
  cutting through nodes.

**React Flow side:**
- **Multi-node back-edge:** a single dashed, lower-contrast, rounded-orthogonal "return rail" that
  exits the last node, runs along a reserved channel above/below the lane, and re-enters the loop head.
  Build the path from ELK's bend points in a custom `BaseEdge`. Style: dashed (`strokeDasharray:'4 4'`),
  neutral `#484f58`, arrowhead, a `↺` badge + the guard label (`[retry < 3]`) at the re-entry seam.
  Distinguish back-edges by **style, not just direction**. [xyflow #5125](https://github.com/xyflow/xyflow/discussions/5125), [Node-RED junctions](https://github.com/node-red/designs/discussions/62)
- **Self-loop (retry-on-one-node):** an elliptical arc that leaves the bottom and re-enters the top of
  the same node (`radiusY≈50`), with small handle offsets so endpoints don't collide:
  `M ${sx-5} ${sy} A ${(sx-tx)*0.6} 50 0 1 0 ${tx+2} ${ty}`. [xyflow #2720](https://github.com/xyflow/xyflow/discussions/2720), [yEd backloop](https://yed.yworks.com/support/qa/1231/correct-backloop-routing-for-self-edges)
- **Optionally hide the back-edge until hover/select** (Node-RED link-node pattern) to keep the canvas
  clean. [Node-RED Link node](https://flowfuse.com/node-red/core-nodes/link/)

**Execution view:** do **not** redraw a literal loop per iteration. Use Temporal's vocabulary — an
**attempt badge** (`×3`) + state color (dashed-red retrying, dashed-purple pending), plus an iteration
counter chip on the loop header (`run 3 of N`). This eliminates awkward back-edges for the retry case
entirely. [Temporal](https://temporal.io/blog/lets-visualize-a-workflow), [Airflow up_for_retry](https://airflow.apache.org/docs/apache-airflow/stable/ui.html)

---

## 6. Distinct fan-out vs identical replicas (issue #2)

These are **different objects** and every mature system renders them differently. The deciding
predicate, which should switch the renderer: *same template applied to a list (Map) vs structurally
different sub-graphs running concurrently (Parallel/fork)?* argus's current bug collapses the
*distinct* case into one `×7` template. Split the data model into `mapFanout` vs `branchFanout`.
[AWS Map vs Parallel](https://docs.aws.amazon.com/step-functions/latest/dg/state-map.html), [UML ExpansionRegion](https://www.uml-diagrams.org/multiplicity.html)

**Identical replicas (homogeneous map, same agent over a list) → ONE collapsed node:**
- The existing `.plan-agent.is-fanned` stacked-card silhouette (keep it) + a `×N` multiplicity chip
  (keep `.plan-mult-chip`). Use UML strings: `×N` for known count, `*` / `1..*` for runtime-dynamic.
- Optionally a BPMN parallel multi-instance marker (three short vertical bars `▮▮▮`) for "parallel",
  `☰` for sequential. [BPMN multi-instance](https://www.trisotech.com/repeating-activities-in-bpmn/)
- On hover/expand: a **per-state count summary** (`5 done · 1 running · 1 failed`) and click-to-expand
  to a list/table of the N instances. Do **not** auto-explode onto the canvas. [Prefect #16081](https://github.com/PrefectHQ/prefect/issues/16081), [AWS Map Run](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-examine-map-run.html), [New Relic ×N expand](https://docs.newrelic.com/docs/distributed-tracing/ui-data/trace-details/)

**Distinct fan-out (heterogeneous, different agents/work) → N real sibling cards:**
- Render each branch as its own labeled card, **named by its differentiator** (`agent: researcher`,
  `agent: critic`), never a bare index. This is Argo's hard-won lesson. No `×N` chip. [Argo display-name #8937](https://github.com/argoproj/argo-workflows/issues/8937)
- Group them under a thin labeled lane/bracket (`fan-out · 7 agents`) so the set still reads as one
  logical fan-out while members stay individually legible. Share one scatter marker (§3) as the origin.
- **Overflow:** when distinct N is large (>6–8), show the first few expanded + a `+K more` chip rather
  than silently template-collapsing distinct work.
- ELK: put the branches in one layer, generous `spacing.nodeNode`, preserve order via
  `considerModelOrder`, and use `elk.partitioning.activate` + per-node `partition` to pin each fan-out
  cohort into its own band so branches don't interleave. [ELK Layered](https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html)

One-line mental model: **identical ⇒ collapse (stacked card + `×N` + drill-down); distinct ⇒
enumerate (N named sibling cards under one scatter marker).** Turn `mergeEdges:false` (§2) so distinct
branches don't visually fuse.

---

## 7. Dark-theme visual-design token set (beautiful dashboard)

argus's current state hexes already match GitHub Primer dark, so this is additive. The core move:
**promote each status from one hex to a 4-tint mini-ramp** (Radix/Geist 12-step model — step 9 = solid
fill/dot, ~3 = faint fill, ~7 = border, 11/12 = text), and **encode state and type on orthogonal
channels** (color = state, shape/icon = type). [Radix scale](https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale), [Geist](https://vercel.com/geist/colors), [Primer](https://primer.style/foundations/color/overview/)

### State color roles (color = STATE; the only saturated color on the canvas)

| State | Dot/rail (solid) | Tinted fill (node wash) | Border | Text-on-dark | Glyph (redundant) |
|---|---|---|---|---|---|
| `done` | `#3fb950` | `rgba(63,185,80,0.10)` | `rgba(63,185,80,0.35)` | `#56d364` | check |
| `running` | `#5b9dff` | `rgba(91,157,255,0.12)` | `rgba(91,157,255,0.40)` | `#79c0ff` | pulsing dot |
| `queued` | `#8b949e` | `rgba(139,148,158,0.08)` | `rgba(139,148,158,0.25)` | `#8b949e` | hollow ring |
| `error` | `#f85149` | `rgba(248,81,73,0.12)` | `rgba(248,81,73,0.40)` | `#ff7b72` | × |
| `interrupted` | `#d29922` | `rgba(210,153,34,0.12)` | `rgba(210,153,34,0.40)` | `#e3b341` | pause |
| `unknown` | `#6e7681` | `rgba(110,118,129,0.06)` | `rgba(110,118,129,0.20)` | `#6e7681` | — |

Rules: **`running` is the only animated state** (1.6–2s pulse; reuse the existing `argus-pulse`
keyframe) — motion = "live", stillness = "settled". `queued` is desaturated + ~0.65 opacity (recessed,
"not started"). `error`/`interrupted` get a **border + faint tint, not a flood**. **Never encode state
by color alone** — pair every color with a glyph/text token (WCAG 1.4.1); status dots/borders need
≥3:1 contrast vs canvas, label text ≥4.5:1. [WebAIM](https://webaim.org/articles/contrast/), [W3C 1.4.11](https://www.w3.org/WAI/WCAG21/Understanding/non-text-contrast.html), [WCAG 1.4.1](https://wcag.dock.codes/documentation/wcag141/)

### Node-type encoding (separate channel = SHAPE + icon, neutral color)

| Element | Shape | Leading icon | Color source |
|---|---|---|---|
| Agent | rounded-rect card, 1px border | role/robot glyph | state ramp (tint + rail) |
| Phase lane | translucent container, label top-left | phase number | neutral, very low contrast |
| Decision | diamond + `X`/`+`/`O` marker | `?` | neutral; **branch edges** carry green/red |
| Fan-out | ~10px filled dot | none (`×N` on hover) | accent, faint |
| Merge | ~10px hollow ring | none | neutral, faint |
| Loop | dashed container + back-edge | `↺` | dashed neutral/amber |

Agents are gray, state-tinted cards; **ration saturated hue** to the live agent + decision branch
edges + fan-out markers (Linear/Vercel "one gray ramp + one accent"). This is the biggest
"dashboard, not rainbow" lever. [Linear](https://linear.app/now/how-we-redesigned-the-linear-ui)

### Surface elevation (tight 4-step stack, 1px inset borders not fills)

```
canvas        #0b0d10   (current --argus-bg)
lane          #0e1116
card          #11161c   (current .agent-shell bg) / #161b22
hover/select  #1c232b
borders       #21262d (subtle) · #30363d (interactive) · selected ring #5b9dff
```

### Spacing, radii, typography

- **Spacing scale 4px base:** 4 / 8 / 12 / 16 / 24 / 32. Card padding 12px, pill gap 8px, lane padding
  16–20px.
- **Radii:** chips/pills 4–6px, cards 8–10px, containers 10–12px (one step up per nesting level).
- **Type:** sans for prose (current `ui-sans-serif`), **mono for all machine values** (ids, tokens,
  ms, model — already partly done) with `font-variant-numeric: tabular-nums` so live metrics don't
  jitter. Sizes: node title 13px, caption 11–12px, pill/branch labels 10–11px; ≤3 sizes visible at
  once. Weights: title 550–600, body/labels 500, secondary 400; avoid 700+ inside the graph.
  Titles slightly negative tracking (`-0.01em`); tiny uppercase metric labels positive. [Linear](https://linear.app/now/how-we-redesigned-the-linear-ui), [Vercel](https://seedflip.co/blog/vercel-design-system)

### React Flow theme variables (override in `.react-flow`)

```css
.react-flow {
  --xy-background-color: #0b0d10;
  --xy-background-pattern-dots-color-default: #161b22;  /* near-invisible grid (texture, not a grid you read) */
  --xy-edge-stroke-default: #30363d;                    /* hairline neutral */
  --xy-edge-stroke-width-default: 1.5;
  --xy-edge-stroke-selected-default: #5b9dff;
  --xy-node-background-color-default: #11161c;
  --xy-node-border-default: 1px solid #21262d;
  --xy-node-color-default: #e6e8eb;
  --xy-node-boxshadow-selected-default: 0 0 0 1px #5b9dff;
  --xy-handle-background-color-default: #30363d;
  --xy-handle-border-color-default: #0b0d10;            /* hide handles into the bg */
}
/* per-edge meaning: forward=neutral, true=green, false=red, loop-back=dashed #484f58 */
```
Color edges by meaning via per-edge `style.stroke`; animate only the running agent's incoming edge
(`animated:true`). [React Flow theming](https://reactflow.dev/learn/customization/theming)

### Optional dashboard affordances (declutter at scale)

Minimap-style zoom, a "critical path only" toggle (longest blocking agent chain), status/phase/agent
filters with "show matches only", collapsible phase lanes, and rolling child state up to the lane via
Kiali's "most severe wins" rule. Cull off-screen edges past ~50 edges (Dagster). [Grafana Tempo](https://grafana.com/docs/grafana/latest/explore/trace-integration/), [Kiali health](https://kiali.io/docs/features/health/), [Dagster](https://dagster.io/blog/scaling-dag-visualization)

---

## Sources (primary)

Layout/routing: [ELK options](https://eclipse.dev/elk/reference/options.html) · [ELK layered](https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html) · [ELK cycleBreaking](https://eclipse.dev/elk/reference/options/org-eclipse-elk-layered-cycleBreaking-strategy.html) · [ELK mergeEdges](https://eclipse.dev/elk/reference/options/org-eclipse-elk-layered-mergeEdges.html) · [React Flow elkjs](https://reactflow.dev/examples/layout/elkjs) · [React Flow layouting](https://reactflow.dev/learn/layouting/layouting) · [React Flow custom edges](https://reactflow.dev/examples/edges/custom-edges) · [xyflow #5125](https://github.com/xyflow/xyflow/discussions/5125) · [xyflow #2720](https://github.com/xyflow/xyflow/discussions/2720)
Workflow tools: [AWS Map](https://docs.aws.amazon.com/step-functions/latest/dg/state-map.html) · [AWS Parallel](https://docs.aws.amazon.com/step-functions/latest/dg/state-parallel.html) · [AWS Map Run](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-examine-map-run.html) · [BPMN gateways](https://www.visual-paradigm.com/guide/bpmn/bpmn-gateway-types/) · [Camunda exclusive gateway](https://docs.camunda.io/docs/components/modeler/bpmn/exclusive-gateways/) · [Argo DAG](https://argo-workflows.readthedocs.io/en/latest/walk-through/dag/) · [Argo #8937](https://github.com/argoproj/argo-workflows/issues/8937) · [Prefect #16081](https://github.com/PrefectHQ/prefect/issues/16081) · [Airflow UI](https://airflow.apache.org/docs/apache-airflow/stable/ui.html) · [Node-RED junctions](https://github.com/node-red/designs/discussions/62) · [Node-RED Link](https://flowfuse.com/node-red/core-nodes/link/)
Trace/observability: [Temporal](https://temporal.io/blog/lets-visualize-a-workflow) · [Langfuse trace view](https://langfuse.com/changelog/2025-03-19-new-trace-view) · [LangGraph Studio](https://deepwiki.com/langchain-ai/langgraph-studio/5.2-graph-visualization) · [OpenTelemetry waterfalls](https://oneuptime.com/blog/post/2026-02-06-read-interpret-opentelemetry-trace-waterfalls/view) · [Grafana Tempo](https://grafana.com/docs/grafana/latest/explore/trace-integration/) · [Kiali](https://kiali.io/docs/features/health/) · [New Relic](https://docs.newrelic.com/docs/distributed-tracing/ui-data/trace-details/) · [Dagster](https://dagster.io/blog/scaling-dag-visualization)
Decisions/loops: [Camunda symbols](https://camunda.com/bpmn/reference/) · [go-uml guards](https://www.go-uml.com/guard-conditions-activity-diagrams-guide/) · [Creately flowchart mistakes](https://creately.com/blog/software-teams/part-1-15-mistakes-you-would-unintentionally-make-with-flowcharts/) · [SmartDraw](https://www.smartdraw.com/flowchart/flowchart-symbols.htm) · [yEd backloop](https://yed.yworks.com/support/qa/1231/correct-backloop-routing-for-self-edges)
Aesthetics: [Radix](https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale) · [Geist](https://vercel.com/geist/colors) · [Linear redesign](https://linear.app/now/how-we-redesigned-the-linear-ui) · [Primer](https://primer.style/foundations/color/overview/) · [React Flow theming](https://reactflow.dev/learn/customization/theming) · [WebAIM contrast](https://webaim.org/articles/contrast/) · [WCAG 1.4.1](https://wcag.dock.codes/documentation/wcag141/)
Multiplicity: [UML multiplicity](https://www.uml-diagrams.org/multiplicity.html) · [BPMN multi-instance](https://www.trisotech.com/repeating-activities-in-bpmn/)
