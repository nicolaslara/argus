# Plan-View Design — argus

Status: design pass, synthesized 2026-06-04. Extends `workpads/architecture/boundaries.md`.
This is an **additive extension**: a `PlanModel` alongside the existing `RunModel`, a
pure `parsePlan` behind the **single adapter seam** (§0), and a plan/execution overlay.
**M3 execution rendering is untouched.**

This document folds in every high-severity review must_fix; each is called out inline
under **[review fix]** with what changed and why.

---

## 0. TL;DR and the one slice that ships first

There are **two views** of one workflow:

- **Plan** — the *template*: the intended shape derived statically from the workflow
  `.js` source. Fan-out arms, barriers, decisions, loops exist here because they exist
  in the source.
- **Execution** — the *instantiation*: a concrete run. This is today's `RunModel`
  (phase-lane grouped agents). It carries no fabricated structure.

And **two modes**:

- **review-the-workflow** — pure Plan, **no run required**. A read-only, file-first,
  offline, lint-able page. Dogfoods argus on its own workflows. This is the lowest-risk,
  highest-value slice.
- **review-the-execution** — a run painted onto the shared layout, expanded from the
  Plan template (GitHub Actions / Airflow run_id / Dagster pattern).

> **[review fix — complexity lens, high] The committed v1 is one thin slice, not the whole vocabulary.**
> The full design below describes the target. **v1 ships SLICE 1 only**: review-the-workflow,
> Plan view, derived from **`meta.phases` only** (Tier-1, already parsed by `parseWorkflowMeta`).
> Ordered phase lanes + subtitles. **No body AST, no agents, no rich edges, no overlay, no
> `RunModel` change, no acorn.** It reuses the shipped `parseWorkflowMeta` + the existing
> `phaseLane` node + one new endpoint. Tier-2 AST and the execution overlay are SLICE 2 / SLICE 3.
> See §7 for the milestone sequence.

---

## 1. The two views and two modes (definitions + "start at the plan, expand into execution")

| | Plan (template) | Execution (instance) |
|---|---|---|
| **Source** | static `.js` source (`parsePlan`) | a run's journal + `wf_*.json` (`loadRun` → `RunModel`) |
| **Multiplicity** | `1..N` template markers, folded loops | resolved counts, unrolled rounds |
| **Edges** | real fan-out / merge / optional / loop-back (legit: they're in the source) | none on disk; **inherited from the bound Plan**, never inferred from timing |
| **Needs a run?** | No (review-the-workflow) | Yes (review-the-execution) |

**"Start at the plan, expand into the execution"** is the overlay (§6): the Plan is the
canonical layout; selecting a run *paints status onto it* and *expands* template nodes
into the concrete instances the run produced. With no run selected you see the pure
Plan — that *is* review-the-workflow.

> **[review fix — complexity lens, high] MODE and VIEW are separated in v1.**
> The PLAN⟷EXECUTION morph toggle and "status-painted-on-plan as the default execution
> canvas" are **deferred**. v1 = MODE only: a standalone review-the-workflow page reached
> from the run/workflow list. The M3 execution canvas stays exactly as-is. The morph and
> shared-layout overlay land in SLICE 3 once the plan layout is validated on the 14-agent shape.

---

## 2. JS → plan-DAG derivation

### 2.1 Three deterministic tiers + one optional pass

- **Tier 1 — `meta.phases` (high confidence, `declared`).** Reuse `parseWorkflowMeta`
  (already shipped). Ordered phase **titles + details** → lane labels and node subtitles.
  The trustworthy spine. **This tier alone is SLICE 1.**
- **Tier 2 — static AST scan (medium confidence, `static`).** Vendor `acorn` (8.16.0,
  present in the lockfile). All 9 real scripts fail `acorn.parse(sourceType:'module')`
  (`return outside function`) but parse cleanly when wrapped:
  ```
  async function __wf(agent,parallel,pipeline,phase,log,workflow,budget,args){ …body… }
  ```
  parsed `sourceType:'script', ecmaVersion:2022`. The injected DSL fns are the params —
  that wrapper *is* the runtime execution shape.
- **Tier 3 — label-template inference (medium, `static`).** Parse each `agent()` label
  literal/template into a **structured** `{ literalPrefix, holes[] }` (e.g.
  `research:${r.key}` → prefix `research:`, hole `r.key`). This is the overlay join key.
- **Tier 4 — OPTIONAL LLM annotation (low, `heuristic`).** Prose subtitles + pattern-name
  recognition only. Opt-in, server-side, cached, never on the default read path. See §2.5.

> **[review fix — stances lens, high] Acorn is an EXPLICIT new adapter dep, not "zero dep".**
> `packages/adapter/package.json` declares only `@argus/contract` and `zod`; acorn resolves
> today only via root hoisting. Before SLICE 2, add `acorn` to the adapter's `dependencies`
> (it stays adapter-only, never reaches web per §1). Reword: *"reuses an already-installed
> transitive, now declared in the adapter only."* SLICE 1 ships with **no parser at all**.

> **[review fix — stances lens, medium] `loadWorkflowSource` is contracted but NOT yet built.**
> It appears in the §2.2 documented surface but has **no implementation** in the adapter.
> `loadPlan` cannot "reuse" it — it must be **built first**. `parsePlan` is a **pure fn**
> (source string in) so it is independent of the loader; sequence `loadWorkflowSource`
> before `loadPlan`.

### 2.2 Construct recognition — RECURSIVE, default-deny

The AST walk recognizes exactly the construct set covering 100% of the real corpus and
**degrades everything else to an opaque `unparsed` node — never crashes, never silently drops.**

- `phase(title)` → lane / loop container
- sequential `await agent(opts)` → `agent` node + `flow` edge
- `await parallel([t1,t2,…])` → `fanout` split + N nodes + `merge`/barrier join
- `parallel(ARR.map(()=>agent()))` → data-fanout; `multiplicity={fixed,n}` **iff** `ARR`
  is a const **array-of-literals** resolved in-scope, else `{unbounded,min:literalCount}`
- `while`/`for` → `loop` container + dashed `loop-back` edge + stop-condition decision
- `if/else`, esp. `RegExp.test(verdict)` or a schema-field guard (`blocked_reason`) →
  `decision` diamond with **conditional (dashed)** branches
- `return` → `output` terminal
- `pipeline()` / `workflow()` / `budget` → a single generic **opaque container** each
  (zero real fixtures use them — no speculative branches)

> **[review fix — red-team lens, high] The AST walk is RECURSIVE, not top-level-only.**
> Verified: `build-modal-rust-sdk.js` nests `phase('Auth')`/`agent`/`phase('Operations')`/
> `agent` **inside the `else` block** of `if(!green){…}` (lines 199–261). A top-level walk
> would emit a confident LINEAR plan with the entire Auth+Operations branch **silently
> missing** — the worst failure (wrong DAG, not partial). **Fix:** descend into every
> if/else consequent+alternate, every while/for body, and every `.map/.filter/.flatMap`
> thunk body, collecting `phase()/agent()/parallel()` at any depth. Branch-discovered
> nodes get `optional:true` + the enclosing `DecisionNode` as parent; loop-body nodes get
> `loopRef`. **Fixture assertion:** `build-modal-rust-sdk` yields Auth/Operations as
> optional children of the `BUILD_GREEN` diamond.

> **[review fix — red-team lens, high] DEFAULT-DENY for unresolvable constructs.**
> Any `agent()/parallel()/phase()` whose callee, args, or opts cannot be resolved to a
> literal/known-const **in the current lexical scope** (helper-wrapped `agent()`,
> `parallel(buildThunks())`, spread opts) emits an `unparsed` PlanNode carrying its source
> span + a coded `AdapterWarning` — **never silence**. Multiplicity is `{fixed,n}` ONLY
> for an in-scope const array-of-literals; the spread-mix
> `parallel([...WORKPADS.map(...), ()=>agent(...)])` (materialize-workpads) →
> `{unbounded, min: literalCount}`. **The spread-mix is a REQUIRED v1 fixture** (it is in
> the corpus), not an open question.

### 2.3 Meta-strip and graceful degradation

> **[review fix — red-team lens, medium] Reuse `extractBalanced`; neutralize ALL exports.**
> Do not invent a second weaker regex strip. Use the existing `extractBalanced` (in
> `discovery.ts`, already used by `parseWorkflowMeta`) to locate+remove the meta literal
> precisely, and neutralize **all** top-level `export` keywords (`export const X`,
> `export default`), not just `meta`. Mis-counted braces would shift every `unparsed`
> node's byte span (which view-source depends on). On **any** wrap-parse failure → fall
> back to `derivedFrom:'meta-only'` + coded warning. **Unit-test a deliberately malformed body.**

> **[review fix — red-team lens, medium] `import` → meta-only, no speculative esbuild path.**
> Top-level `import`/`import.meta` is illegal inside the function wrapper. No real script
> uses it. **v1:** detect `ImportDeclaration` → go straight to `meta-only` with code
> `import-detected-fallback`. **Do not** build the esbuild/ts transform fallback until a
> real fixture needs it (building it now repeats the speculative-branch mistake the design
> rejects for `pipeline`/`workflow`/`budget`).

Degradation ladder (reuses the `DiscoveryReport.reasons` discipline — never throw):
unrecognized statement → `unparsed` node (carries span); region/whole-body parse failure
→ `meta-only` skeleton (lanes, no inner structure); no meta AND no body → empty-with-reason.

### 2.4 What is and isn't statically resolvable

**Resolvable:** phase groups (source order), agent label/phase/schema/agentType from the
opts `ObjectExpression`, exact fan-out N for literal arms and const-array `.map`, if/else
diamonds, while/for loop containers, the loop cap when `MAX_ROUNDS = (args&&args.maxRounds)||3`
(the literal `3` is readable). **Not resolvable (→ honest `1..N`/ellipsis + `heuristic` tag):**
regex/verdict branch *values*, N for runtime-computed mapped arrays, exact loop iteration
count, anything depending on `args`.

### 2.5 Tier-4 LLM annotation — annotation-ONLY, real home

> **⚠ SUPERSEDED in part by §10 (user direction 2026-06-04).** The
> annotation-only-on-topology rule below STANDS. But "opt-in / server-side / never on
> the default path / privacy-gated" is **overturned**: the Explanation layer is now
> **default-on, background, cached, `claude -p`-first**, and it **feeds node captions**.
> See §10.

> **[review fix — red-team lens, high] T4 cannot touch topology.**
> `annotatePlan` must NOT return a `PlanModel`. Signature:
> `annotatePlan(plan): Promise<Map<planNodeId, {subtitle, patternName}>>` — a delta keyed
> by **existing** node ids. The merge writes **only** into `PlanAnnotation.subtitle` /
> `patternName`, **drops any annotation whose nodeId is not already present**, and stamps
> `annotation.source='heuristic'` (renders as LLM-provenance). Topology
> (nodes/edges/multiplicity/containers) is **immutable** after T2/T3. This structurally
> prevents a hallucinated edge or fan-out arm from being laundered through the plan model.

> **[review fix — stances lens, high] No fictional "M11"; this is Task #8.**
> There is no M11 — the project's series is **M0–M8**, and the embedded/LLM home is the
> ratified **Task #8 "Design the Explanation layer (cached, background, parallel Claude
> calls)"** (plus the `interact` *(exploratory)* mode, project.md row 6). The call
> mechanism is the **open decision Task #8 already records** — prefer local-first
> `claude -p` (reuses the user's Claude Code auth, no API key, stays on-machine) over the
> Claude API. Sending workflow `.js` (long prompts that can embed repo paths/secrets)
> off-machine is the **worse** choice against stance 1 + §8 ("never off-machine"). T4
> reuses Task #8's content-addressed cache (`hash(source)` under `.argus/cache/`), is
> opt-in, server-side, background, and **never blocks the snapshot**.

---

## 3. Visual vocabulary spec (mapped to @xyflow/react v12)

Today's render is the **degenerate special case**: `nodeTypes = { phaseLane, agentCard }`,
one `smoothstep` `phase_i→phase_i+1` spine edge (`mapping.ts:94`), single nesting level.
The richer vocabulary is legitimate **only in the Plan view** (structure is in the source);
the execution inherits Plan edges via binding (§6), never invents them.

### 3.1 Node kinds (registry `type`s)

| kind | glyph | xyflow mapping | source |
|---|---|---|---|
| `input`/`output` | black terminal | custom terminal node | args / `return` sink |
| `process` | solid box | reuse box | non-agent op (dedupe/synthesize barrier) |
| `agent` | solid box (reuse **AgentCard**) | existing `agentCard` | one `agent()` call |
| `decision` | **diamond** | custom **SVG** node (see fix) | if / RegExp.test / schema-field gate |
| `loop` | rounded container | xyflow group (`parentId`+`extent`) | while/for |
| `subworkflow`/`pipeline` | opaque container | styled group **stub** | deferred DSL |
| `unparsed` | dashed placeholder | box w/ source-span tooltip | graceful-degrade |

Multiplicity is a **field on a node**, not a separate node kind.

> **[review fix — visual lens, high] Diamond = fixed-size custom SVG, not CSS-rotate.**
> A CSS-rotated square gives a rotated bounding box: handles dock at the wrong points,
> dashed branch edges attach to corners, and the label rotates. **Fix:** a fixed-size
> **custom SVG** node with explicit Left/Right/Bottom `Handle`s at the rotated vertices and
> an **unrotated** centered label. Reserve the diamond for the **regex-verdict /
> schema-field gate ONLY**; render a generic `expr` condition as a small labeled rect to
> cap diamond count.

### 3.2 Edge kinds (registry `edgeTypes`)

`flow` (solid, sequential) · `fanout` (1→N, parallel spawn) · `merge` (N→1, the barrier) ·
`optional` (dashed, conditional branch off a decision) · `loop-back` (dashed, labeled with
stop condition). `bracket` (tournament) is **type-name only**, not implemented (no fixture).

> **[review fix — visual lens, low] Animate edges only near live nodes.**
> The design-system reserves looping motion for live agent state. Animate `fanout`/`merge`
> edges **only when incident to a currently-running node**, cap concurrent animated edges;
> otherwise static. Distinguish edge kinds by **dash / curvature**, not color (saturation
> is reserved for state semantics).

### 3.3 Containers

`lane` (existing `phaseLane`) · `loop` (the one real nested container — validate the
nesting path here) · `trust-boundary` (**type-name + flat styling stub only**; no layout
wiring; gated behind a real fixture).

### 3.4 Multiplicity — ONE glyph

> **[review fix — visual lens, high] One multiplicity glyph, not five stacked markers.**
> Do not stack badge + ellipsis + sourceExpr + per-arm subtitles + dashed + confidence on
> one 260px card. **Fix:** a single **stacked-card silhouette** behind the node + a corner
> count chip (`×5` static, `1..N` unbounded). `sourceExpr` (e.g. "one per item in WORKPADS")
> goes in the **detail panel / hover**, not on the canvas. Drop the separate vertical-ellipsis
> decorative node.

### 3.5 Lanes / axes

**Phase lanes** (vertical, existing) are the primary axis. **Round columns** are the loop
unroll — see §6 / the layout fix below.

### 3.6 Annotation slots

`title` (label/process name) · **`subtitle`** (NEW — the primary carrier of plan intent,
the article's "verifies the claim against sources") · status-chip (reuse `AgentState`
color + `failedInLogs`) · metric pills (existing).

> **[review fix — visual lens, nice-to-have] Subtitle reuses the lastToolSummary slot.**
> Add subtitle as a 2-line clamp below the mono label, sharing the existing
> `lastToolSummary` clamp slot, so card height doesn't grow.

### 3.7 Restrained default styling (binding)

> **[review fix — visual lens, medium + complexity lens, medium] Simple by default.**
> - **Tier-1 always-on:** AgentCard, `flow` edge, phase lane, `fanout`/`merge` edges.
> - **Tier-2 only-when-present:** diamond, loop container, optional-dashed, multiplicity glyph.
> - **Tier-3 stub-only (no renderer):** trust-boundary, bracket, pipeline/subworkflow.
> The 90% case (fan-out → synthesize → verify) renders with the existing card + one
> fan-out/merge style. Rich kinds appear **only** when the AST produced that construct.
> Confidence is **one visual axis** (solid border=declared, solid+tick=static,
> dashed=heuristic) — not opacity/desaturation (reserved for state).

### 3.8 Canonical pattern → DAG shape

1. **Fan-out-and-Synthesize** (commonest): `input → [fanout] → N agents (or one 1..N node)
   → [merge barrier] → process(synthesize) → output`.
2. **Adversarial-Verify**: each agent → a verifier agent → verdict (`implement → verify`).
3. **Generate-and-Filter**: N generators → `[merge]` → filter/dedupe → top-K.
4. **Classify-and-Act (HARD GATE)**: gating agent → **diamond** → conditional (dashed)
   downstream phases; the skipped branch is a planned-not-run phase.
5. **Loop-Until-Done**: folded loop container + dashed `loop-back` labeled with the stop
   condition ("until dry · max 3").
6. **Tournament / Quarantine-Trusted**: vocabulary present as type-names only; deferred.

---

## 4. The PlanModel contract + where the analyzer lives

### 4.1 Placement (boundaries.md extension)

- **`PlanModel` is a SIBLING of `RunModel` in `packages/contract`**, not a superset and
  not a parent class. They relate by two join keys already on disk on both sides:
  the `agent()` label (== `workflow_agent.label`) and the **phase index** (Phase.title via
  `phaseIndex`).
- **`parsePlan` lives in `packages/adapter`** (new `plan.ts`), beside `parseWorkflowMeta`.
  Workflow `.js` is a raw on-disk format → its parser belongs behind the single seam (§0).
  **No `packages/analyzer`** (would break "exactly 4"); web never parses JS (no `node:*`).

> **[review fix — complexity lens, medium + stances lens] RunModel.AgentNode is UNCHANGED in v1.**
> Earlier draft added `planNodeId?` to `AgentNode`. But `AgentNode` is journal-faithful and
> binding is an **overlay-time, web-side** concern that may have no plan for a given run.
> **Fix:** keep `AgentNode` untouched; express binding **purely in the `Overlay` type**
> (`planNodeId → agentIds[]`) computed web-side. M3 stays literally untouched. If a derived
> field is ever needed, add it later as an explicit overlay annotation, never on `AgentNode`.

### 4.2 Contract types (TS sketch)

```ts
// packages/contract/src/index.ts — NEW, sibling to RunModel. No runtime deps.
export type PlanNodeKind =
  | 'input' | 'output' | 'process' | 'agent' | 'decision'
  | 'loop' | 'subworkflow' | 'pipeline' | 'unparsed';

export type Confidence = 'declared' | 'static' | 'heuristic';

export type Multiplicity =
  | { kind: 'one' }
  | { kind: 'fixed'; n: number }
  | { kind: 'unbounded'; min: number; max: 'N'; sourceExpr?: string };

// Structured label template — distinguishes a static suffix from a runtime hole.
export interface LabelTemplate { literalPrefix: string; holes: string[]; raw: string; }

export interface PlanAnnotation {
  subtitle: string | null;     // T1/T3 deterministic; T4 LLM may enrich (heuristic)
  patternName?: string | null; // T4 only
  typed: boolean;              // StructuredOutput schema present on opts
  source: Confidence;          // provenance of the subtitle
  span?: { start: number; end: number }; // byte offsets (unparsed/view-source)
}

export interface PlanNode {
  id: string;                  // stable: labelTemplate | phaseRef | ordinal
  kind: PlanNodeKind;
  title: string;
  labelTemplate: LabelTemplate | null; // overlay join key (structured)
  agentType: string | null;
  phaseRef: number | null;     // 1-based, into PlanModel.lanes
  multiplicity: Multiplicity;
  optional: boolean;           // discovered inside a decision branch → dashed
  loopRef: string | null;      // enclosing loop node id, if any
  parentDecisionId: string | null; // enclosing decision, if any
  annotation: PlanAnnotation;
  confidence: Confidence;
}

export interface DecisionNode extends PlanNode {
  kind: 'decision';
  conditionKind: 'regex-verdict' | 'schema-field' | 'expr';
  conditionLabel: string;      // 'BUILD_GREEN?' | 'blocked_reason?'
}
export interface LoopNode extends PlanNode {
  kind: 'loop';
  stopCondition: string;       // 'until dry · max 3'
  maxRounds: number | null;    // static cap when readable, else null
}

export type PlanEdgeKind = 'flow' | 'fanout' | 'merge' | 'optional' | 'loop-back';
export interface PlanEdge { id: string; from: string; to: string; kind: PlanEdgeKind; label?: string; }

export type ContainerKind = 'lane' | 'loop' | 'trust-boundary';
export interface PlanContainer {
  id: string; kind: ContainerKind; title: string; detail: string | null;
  trust?: 'trusted' | 'untrusted';   // stub-only styling
  childIds: string[];
}

export interface PlanLane { index: number; title: string; detail: string | null; confidence: Confidence; }

export interface PlanModel {
  workflowFile: string;        // basename only
  workflowName: string;
  lanes: PlanLane[];           // primary phase axis (meta.phases seed)
  nodes: PlanNode[];
  edges: PlanEdge[];
  containers: PlanContainer[];
  warnings: AdapterWarning[];  // unparsed-statement | import-detected-fallback | meta-only
  derivedFrom: 'static-source' | 'meta-only';
  coverageRatio: number;       // recognized statements / total — honest signal (nice-to-have)
  format: string;              // ADAPTER_FORMAT pin
}
```

### 4.3 Overlay type (web-side, pure)

```ts
export interface PlanBinding {
  planNodeId: string;
  agentIds: string[];                 // SET instantiating a template node
  status: 'not-run' | 'partial' | 'complete';
  succeeded: number; total: number | 'N';
  confidence: Confidence;             // exact-literal=high, prefix+index=med, phase-only=low
  ambiguous: boolean;                 // run agent matched >1 plan node
}
export interface Overlay {
  bindings: PlanBinding[];
  unplannedAgentIds: string[];        // label-prefix matches no plan node
  rounds: number | null;             // unrolled loop rounds actually run
}
```

### 4.4 Adapter + API surface (additive)

```ts
// adapter (new plan.ts)
parsePlan(source: string): PlanModel             // PURE; acorn wrap-parse; never throws
loadWorkflowSource(port, ref): Promise<string>   // BUILD (contracted, not yet implemented)
loadPlan(port, ref): Promise<PlanModel>          // LAZY; depends on loadWorkflowSource
annotatePlan(plan): Promise<Map<id,{subtitle,patternName}>> // OPTIONAL T4, Task #8-gated

// web-side, types-only
buildOverlay(plan: PlanModel, run: RunModel): Overlay  // PURE label-prefix + phaseIndex join
```

API: `GET /api/projects/:slug/workflows/:file/plan` → PlanModel (review-the-workflow,
run-free, from `.claude/workflows/*.js`); `GET /api/runs/:slug/:session/:runId/plan` →
PlanModel (overlay, from the **per-run persisted** `workflows/scripts/*.js`).

---

## 5. Dual-view / dual-mode UI (ASCII wireframes)

**review-the-workflow (SLICE 1 — pure Plan, no run):**

```
┌─ argus ─ project: modal-rust ─ workflows ──────────────────────────────┐
│  [build-modal-rust-sdk]  refine-plan   plan-research   implement        │
├─────────────────────────────────────────────────────────────────────────┤
│  Plan: build-modal-rust-sdk            confidence: ▣ declared ◫ static   │
│                                                                           │
│  ╭─ Design ▣ ────────────╮   ╭─ Scaffold ▣ ───────────╮                  │
│  │  design:architecture   │──▶│  scaffold (verdict)    │                 │
│  ╰────────────────────────╯   ╰───────────┬────────────╯                 │
│                                    ◇ BUILD_GREEN?  (gate)                 │
│                          not green ⇠┘        └⇢ green                     │
│              ╭─ Review ▣ ─────╮      ╭┄ Auth (optional) ┄╮                │
│              │  review:*       │     ┆  auth+channel      ┆               │
│              ╰─────────────────╯     ┆  ╭┄ Operations ┄╮  ┆               │
│                                      ┆  ┆ typed-ops    ┆  ┆               │
│                                      ╰┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╯               │
│  coverage 92%   2 warnings: unparsed-step ×1                              │
└─────────────────────────────────────────────────────────────────────────┘
```
(Dashed = optional/conditional. The Auth/Operations branch is present because the AST walk
is **recursive** — the §2.2 fix. SLICE 1 renders only the lanes; the diamond/optional
branch arrives in SLICE 2.)

**review-the-workflow with a fan-out + folded loop (refine-plan):**

```
│  ╭─ Critique r{n} ◫ ─ loop: until dry · max 3 ─────────────────╮         │
│  │   ┌──────────┐  ⟜ critique:<lens>   ▦×4 (LENSES)            │         │
│  │   │ ▦ stacked│  ──[merge]──▶  ( .filter(Boolean) )          │         │
│  │   └──────────┘                       │                       │        │
│  │        ▲                              ▼                       │        │
│  │        └┄┄┄ loop-back (round++) ┄┄ revise:plan              │         │
│  ╰───────────────────────────────────────────────────────────────╯       │
```

**review-the-execution (SLICE 3 — status painted on the shared layout):**

```
│  Run: wf_7233276f  status: killed     [Plan ⟷ Execution]                  │
│  ╭─ Critique r1 ──╮ ╭─ Revise r1 ──╮ ╭─ Critique r2 ⚠ ──╮                 │
│  │ ✓✓✓✓ 4/4       │ │ ✓ done        │ │ ◷◷ 2 interrupted │  ← rounds      │
│  ╰────────────────╯ ╰───────────────╯ ╰──────────────────╯  unrolled →    │
│  research:* fan-out:  6/7 done · 1 failed (parallel[0])    ← aggregate chip│
│  ╭┄ Live (planned · not executed) ┄╮   ← gate skipped, ghosted             │
│  ╰┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╯                                       │
└───────────────────────────────────────────────────────────────────────────┘
```

> **[review fix — visual lens, high] No simultaneous in-place node expansion.**
> Status-painting stays clean only because GH Actions has no fan-out expansion and no
> loop-back edges; argus adds both. **Fix:** folded-plan ⟷ unrolled-execution is a **mode
> switch**, never simultaneous per-node explosion. In folded+painted mode a fan-out node
> shows one **aggregate chip** ("6/7 done, 1 failed"); drilling a node opens the existing
> **detail panel**, it does not relayout the canvas.

> **[review fix — visual lens, high] Plan view ships with elkjs; execution keeps hand-rolled.**
> The hand-rolled `vertical-lanes` engine does one nesting level and routes no node-level
> edges — it **cannot** place diamonds, route a back-edge, or position a barrier. §6 already
> reserves **elkjs as the lazy fallback for "a real cross-phase DAG"** — the PlanModel **is**
> that DAG. **Fix:** elkjs (layered, ports, nested compound nodes) is a **hard dependency of
> the plan view**, not deferred. Scope: **plan view = elk layered; execution view = keep
> hand-rolled lanes.** This is the intended elkjs trigger, not scope creep.

> **[review fix — visual lens, medium] Unrolled rounds are HORIZONTAL columns, not new lanes.**
> Stacking r1/r2/r3 as top-level vertical lanes explodes canvas height (refine-plan ×3 =
> 6+ lanes) and breaks "reads well fullscreen". **Fix:** render rounds as a **horizontal
> round-column axis WITHIN one loop container**, with a collapse-to-folded affordance. The
> primary phase axis stays vertical.

---

## 6. Plan ↔ execution mapping / overlay

The journal carries only opaque content-hash `key`s (not labels), so the Plan is the
**only structural map while live** — strengthening plan-first. The overlay is a **pure
label-prefix + phaseIndex join**, tolerating three first-class mismatches:
**planned-not-run** (gate skipped a phase), **unplanned-agent** (label matches no plan
node), **partial-instance** (fan-out member failed/interrupted — the 14-agent fixture's
`parallel[0] failed` dropped by `.filter(Boolean)`).

> **[review fix — stances lens, high] Join on label-prefix + phaseINDEX, not phaseTitle.**
> `AgentNode` has **no `phaseTitle` field** — only `label` and 1-based `phaseIndex`; the
> human title lives on `Phase.title`, resolved via `phaseIndex`. Phase titles can also be
> runtime template-literals (`phase(\`Critique r${round}\`)`), so a title-string join is
> fragile. **Fix:** join on **label-prefix + numeric phaseIndex** (titles resolved through
> `Phase.title`). Title-string match is a low-confidence fallback only.

> **[review fix — red-team lens, high] Binding is a 3-way classification with explicit tie-breaking.**
> Even well-formed labels are only statically prefix-known: `implement.js` uses
> `implement:${selection.task_id}` (runtime suffix); `refine-plan` uses
> `critique:${l.key}:r${round}`. **Fix:** classify each binding —
> (1) **exact `labelTemplate` literal match** (high) >
> (2) **prefix + phaseIndex unique match** (medium) >
> (3) **prefix+index AMBIGUOUS or phase-only** (low — render as a coarse group, **do NOT
> pick a winner**). "One run agent matches >1 plan node" is a first-class **`ambiguous`**
> state, rendered visibly, never silently resolved. The structured `LabelTemplate`
> (`{literalPrefix, holes[]}`) lets the overlay distinguish a static suffix from a runtime hole.

**Loop reconciliation:** Plan = ONE folded loop node + dashed back-edge. Execution =
unrolled `r1/r2/…` horizontal columns. The declared template spine is canonical for
layout; rounds render as repetition **within** the loop node. A killed mid-round-2 run
reads as "2 of 3 rounds, round 2 interrupted". No new on-disk data needed.

---

## 7. Milestone proposal (P-series for the plan view)

The plan view is a **P-series** that slots **after M3 (execution render) and alongside/before
M4–M5**, since SLICE 1 is run-free and risk-free:

- **P0 — review-the-workflow, meta-only (SLICE 1).** Build `loadWorkflowSource`; new
  `/workflows/:file/plan` endpoint; `parsePlan` Tier-1 only (reuse `parseWorkflowMeta`);
  render with existing `phaseLane` + new `subtitle` slot. **No acorn, no AST, no overlay,
  no RunModel change.** Delivers a standalone run-free workflow review page.
- **P1 — AST skeleton (SLICE 2).** Add `acorn` to adapter deps; `parsePlan` Tier-2/3
  (recursive walk, default-deny, extractBalanced strip, import→meta-only fallback);
  PlanModel nodes/edges/diamonds/loops/multiplicity. Adopt **elkjs for the plan view only**.
  Fixtures: build-modal-rust nesting, materialize-workpads spread-mix, refine-plan loop.
- **P2 — execution overlay (SLICE 3).** `buildOverlay` (3-way binding); per-run plan
  endpoint; PLAN⟷EXECUTION morph; status-painted shared layout; folded↔unrolled mode switch.
- **PX — Explanation layer (default-on, `claude -p`, cached, background).** *(Revised
  §10.)* Per-node LLM captions/simplifications grounded in (node identity + the
  artifact it represents); annotation-only on topology; content-addressed cache with
  bust-and-regenerate invalidation; feeds subtitles across every view. **Depends on P0**
  (not P1/P2) and runs in parallel — no longer deferred/opt-in.

M4/M5 (live path, polish) proceed in parallel — P-series touches new files + additive
contract types only, so it does not block them.

---

## 8. Residual risks (after fixes)

- Static JS is lossy: computed labels, dynamic phase titles, helper-wrapped `agent()`.
  Mitigated by per-node `confidence` + `1..N`/ellipsis + `coverageRatio`; never claim completeness.
- Label-prefix join is a convention; bare task-id labels (M0, E1-build) degrade to
  phase-only low-confidence binding — designed for, not assumed away.
- Template-literal phase titles can't be enumerated statically; the Plan shows one rolled
  `Critique r{n}` lane, the overlay fans it to concrete rounds.
- elkjs adds bundle weight to the plan view; gated to that view only, execution stays lean.
- Tier-4 off-machine privacy: mitigated by `claude -p`-first + cache + opt-in + never-default.

---

## 9. Verdict

All four high-severity must_fix clusters are addressed in-spec:
recursive-walk + default-deny + 3-way binding (red-team), thin SLICE-1 + separated
view/mode + AgentNode-unchanged (complexity), acorn-explicit-dep + phaseIndex-join +
Task#8-not-M11 (stances), elkjs-for-plan + custom-SVG-diamond + one-multiplicity-glyph +
no-in-place-expansion (visual). The two open items requiring user input (plan source
sourcing; tournament/quarantine timing) are non-blocking design choices with recommendations.

**Design is sound.**

---

## 10. Explanation layer — REVISED per user direction (2026-06-04)

This section **supersedes** the §2.5 / §7-P3 / §8 framing of the LLM pass as
"opt-in, privacy-gated, deferred, never on the default path." The user reframed it as
a **default-on, first-class enrichment layer**. The one constraint that stays:
**annotation-only on topology** — the LLM labels/explains nodes, it never adds or
removes structure (AST/meta own topology). Everything else below is the new design.

### 10.1 What it is (corrected framing)

Not "explain a plan node vs an execution node vs a run" (that framing was confusing).
Instead: **for any visualization node, the engine analyzes it by giving the LLM BOTH
(a) what the node IS in the visualization — its kind/role/phase/pattern/label, i.e.
how argus has classified it — AND (b) the underlying artifact it represents — the
code slice (plan node), the agent prompt + `schema` (agent node), or the state /
last-X-tokens of its transcript/result (execution node).** Grounding the LLM in *both*
the structural role and the raw artifact is what yields a faithful one-line
explanation/simplification ("fans out a verifier per claim", "fresh agent — pairwise
compare") instead of a guess. The node's identity (from AST/meta) is the prompt's
scaffold; the artifact is its evidence.

### 10.2 It feeds the VISUALIZATION, not just a detail panel

These explanations/simplifications are **the primary carrier of node intent** — they
populate the node **subtitle/caption** (the article's "verifies the claim against
sources", "fresh agent" captions) across **both views and both modes**, plus longer
forms in the detail panel. So the layer is core to legibility, not an extra. Baseline
captions come **free and instantly** from deterministic sources (meta `detail`, the
`label`, the agent prompt's first line, `schema` presence); the LLM **enriches/
simplifies** them in the background and they swap in when ready.

### 10.3 Mechanism, cache, scheduling (locked)

- **Headless `claude -p` first** (locked, not "preferred"): reuses the user's Claude
  Code auth, no API key, runs locally; use a cheap model (`--model haiku`) and
  `--output-format json`. The Claude API (`claude-api` skill) is a fallback only.
- **Default-on, background, parallel:** a server-side generation pool (bounded
  concurrency) warms explanations eagerly; the UI never blocks; results stream in over
  the existing SSE channel and swap into captions. (The explainer is itself a parallel
  fan-out — the pattern argus visualizes.)
- **Content-addressed cache** keyed by `hash(data)` (the code slice / prompt / the
  bounded last-X-tokens state window) under gitignored `.argus/cache/explanations/`.
  **Cache invalidation v1 = bust + regenerate the missing parts** when the hash
  changes. (Later optimization: when a workflow is *modified*, trigger an agent to look
  at the *modification specifically* and update the explanation surgically — deferred;
  bust-and-regenerate is fine for early versions.)
- **No privacy gate.** Dropped: this is the user's own LLM-generated code/state on
  their own machine, and `claude -p` runs locally under their own auth — nothing goes
  off-machine. So §8's "Tier-4 off-machine privacy" risk is **void**, and the
  "opt-in / never-default" constraints in §2.5 are **removed**. (If the API fallback is
  ever used, that single path re-introduces an off-machine hop — note it there, not as
  a blanket gate.)

### 10.4 Milestone adjustment

P3 is **no longer "deferred, opt-in."** The Explanation layer is a **default-on
enrichment track that can start right after P0** (as soon as there are nodes to
caption) and runs **in parallel** with P1/P2, enriching captions in every view. It
keeps the annotation-only-on-topology guarantee from §2.5's red-team fix. Re-id as
**PX — Explanation layer (default-on, `claude -p`, cached, background)**; it depends on
P0, not on P1/P2.

---

## 11. Forward direction — generative sub-UIs (Claude-authored visualization fragments)

User note (2026-06-04): beyond text captions (§10), use Claude to **build better
sub-UIs for complex things we want to visualize**. This is a forward extension of the
Explanation layer (PX), not v1.

- **The idea:** for a node/pattern whose data is too complex for the default
  vocabulary (a bespoke `result` object, a tournament bracket, a domain-specific
  metric/table), the same engine (§10: `claude -p`, `hash(data)` cache, background)
  returns not a caption but a tailored **sub-UI** that renders inside the node's detail
  panel (or as a custom node body).
- **The one design fork — spec vs code (safety + determinism):** prefer Claude
  returning a **constrained, declarative spec** that argus renders with **vetted
  components / a sub-viz registry** (bracket renderer, table, chart, key-value panel,
  diff view) and which it merely *selects + parameterizes* — NOT arbitrary executable
  React. Arbitrary generated component code is powerful but needs **sandboxing**
  (iframe + strict CSP, no host/network access) and is non-deterministic, so defer it.
  **Start:** Claude classifies the data shape → picks + fills a registered sub-viz.
  **Later (optional):** sandboxed generated components for the long tail.
- **When it fires:** only as an *escape hatch* for nodes the default lanes/cards/
  captions serve poorly — the common case stays on the deterministic vocabulary.
- **Where in the roadmap:** an extension of PX, after the core plan/execution + caption
  layer is solid — naturally an inspect/interact-era capability. Same cache + `claude -p`
  engine, so it reuses PX's infrastructure.
