# project.md — argus

**argus** is a web app for **visualizing and exploring Claude Code workflows**: the
multi-agent runs spawned by the `Workflow` tool. It turns the on-disk run journals
that Claude Code already writes into a beautiful, fullscreen, interactive graph of
phases, agents, pipelines, tokens, tools, and results.

The name fits the job: Argus Panoptes, the many-eyed watcher — a single surface
that lets you see everything a workflow is doing at once.

> This file is the **product source of truth**. When docs conflict, `project.md`
> and the design stances below win. `AGENTS.md` is the operating manual;
> `WORKING.md` is the loop; `TASKS.md` chooses the active phase.

---

## What it is

- A **fullscreen graph explorer** for Claude Code workflows. The visualization is
  the product — the canvas is the app; chrome is minimal and gets out of the way.
- **Local-first and read-only (initially).** Point argus at a local project
  directory where Claude Code runs; it discovers that project's workflow runs from
  `~/.claude/projects/<slug>/<session>/` and renders them — both **finished runs**
  (history) and **running ones** (live).
- **Iterative and always working end-to-end.** Every milestone ships a usable app
  on real data. The first version can be as small as: pick a local project → list
  its runs → render one run's phase/agent graph from its journal.

## What it is not (yet)

- Not a Claude Code *client* or a replacement for the CLI. argus observes; it does
  not (in early phases) drive a session.
- Not dependent on any private/leaked Claude Code source. We build on the
  **observable on-disk contract** (see below), defensively versioned.
- Not a generic DAG/observability tool. It is opinionated specifically around the
  shape of `Workflow`-tool runs (phases → agents → pipelines/parallel barriers).

## Who it's for

The developer running Claude Code workflows who wants to *understand* what a run
did (or is doing): which agents ran in which phase, what each was asked, what it
returned, where the wall-clock and tokens went, and where a run failed or was
killed — then, later, to interact with and edit those workflows.

---

## Design stances (hard invariants)

These come from the brief and override convenience.

1. **File-first, zero-instrumentation, read-only in early phases.** The on-disk
   journals Claude Code writes (`workflows/wf_*.json`, `subagents/workflows/wf_*/`,
   `.claude/workflows/*.js`) **are the interface**. Phase 1 requires *no* Claude
   client API, *no* reverse-engineered binary, *no* remote control, *no* ACP.
   Advanced connectivity (live drive, ACP, embedded agent) is **strictly additive**
   and must never become a Phase-1 blocker. If a capability needs more than the
   files give us, it waits for the phase that earns it.

2. **Working end-to-end from the very first milestone.** Keep it clean, simple, and
   demonstrable on real data at every step. No big-bang. We would rather ship a
   tiny correct render of one real run than a half-built grand architecture. Each
   milestone proves exactly one new capability against a real Claude Code project
   (we dogfood on `../modal-rust`, which has 16 real runs).

3. **UI and design quality are first-class invariants, not polish.** The
   visualization is the product. Graph layout, legible state/typography, motion,
   and the fullscreen-canvas + collapsible-minimal-toolbar shell are held to a high
   bar and reviewed as deliverables, not afterthoughts. "It renders" is not done;
   "it reads beautifully at a glance and scales to a 14-agent run" is.

4. **Treat the on-disk schema as observed, versioned, and untrusted.** The format
   is not officially documented and will drift across Claude Code versions. The
   ingestion layer tolerates unknown/missing fields, never crashes on a new field,
   pins an observed-format version, and isolates all schema knowledge behind one
   adapter so a format change is a one-file fix. Parsing is defensive by contract.

---

## Architecture stance (high level — ratified in the architecture workpad)

A thin **local backend** (TypeScript) owns filesystem access — discovering
projects/sessions/runs, reading and normalizing journals, and watching files for
live updates — and exposes a small typed API + a live channel to a **web
frontend** that owns the graph rendering and the shell. This split is what lets a
*web* app read the *local* `~/.claude` tree, and keeps a future desktop wrapper
(e.g. Tauri) or remote backend as a swap of the same boundary.

- **Ingestion / adapter layer** — the only place that knows the on-disk format.
  Reads `wf_*.json` (finished) and tails `journal.jsonl` + `agent-*.jsonl`
  (running), and parses `.claude/workflows/*.js` `meta` for declared structure.
  Emits a normalized, version-stable **run model**.
- **Run model** — normalized graph: a run has phases; phases contain agents; agents
  carry state, label, model, tokens, toolCalls, durationMs, prompt/result previews,
  and timing. Pipeline/parallel structure is inferred from phase + timing where the
  journal doesn't state it explicitly (an architecture open question).
- **Server↔client contract** — typed; snapshot + incremental updates for live runs.
- **Render + layout** — graph library + layout engine chosen in research; the
  rendering pipeline maps the run model to a fullscreen, navigable canvas.
- **Shell / IA** — fullscreen canvas with an optional, collapsible, minimal left
  toolbar (switch project, settings). Exploration-first.

Concrete library/framework/desktop-vs-web choices are **research deliverables** and
are locked in `workpads/research/` → ratified in `workpads/architecture/`.

---

## The on-disk data contract (observed 2026-06-04, Claude Code w/ workflows)

This is the spine of the whole product. Verified by inspecting real runs under
`~/.claude/projects/-Users-nicolas-devel-modal-rust/`. The research workpad treats
this as a finding to harden and version; the architecture workpad ratifies it as
the adapter contract.

**Project root & slug.** Runs live under
`~/.claude/projects/<project-slug>/<session-id>/`. The slug is the project's
absolute working directory with **every non-alphanumeric character replaced by
`-`** (observed: `/Users/nicolas/.config/ghostty` → `-Users-nicolas--config-ghostty`;
`/Users/nicolas/devel/modal-rust` → `-Users-nicolas-devel-modal-rust`). `<session-id>`
is a UUID; a project has many sessions, a session has many runs.

**Per session directory:**

| Path | Role |
| --- | --- |
| `workflows/wf_<id>.json` | **Finalized run journal** (written on completion). The richest single source. |
| `workflows/scripts/<name>-wf_<id>.js` | The persisted workflow **script source** for that run. |
| `subagents/workflows/wf_<id>/journal.jsonl` | **Live append-only event stream** (the resume journal): `{type:"started", key, agentId}`, etc. The source of truth while a run is in progress. |
| `subagents/workflows/wf_<id>/agent-<agentId>.jsonl` | Per-subagent **transcript** (user/assistant/tool messages; `isSidechain:true`). |
| `subagents/workflows/wf_<id>/agent-<agentId>.meta.json` | `{"agentType":"workflow-subagent"}`. |
| `subagents/agent-<id>.{jsonl,meta.json}` | Top-level `Agent`-tool subagents (not workflow-bound). |
| `tool-results/<id>.txt` | Overflow tool outputs. |

**`wf_<id>.json` shape (finalized):** `runId`, `timestamp`, `taskId`, `script`
(inline source), `scriptPath`, `args` (JSON string), `result` (the returned
object), `agentCount`, `logs[]` (the `log()` narrator lines), `durationMs`,
`summary`, `workflowName`, `status` (`completed` | `failed` | `killed`; `running`
while live), `startTime` (epoch ms), `phases[]` (`{title, detail}`), `defaultModel`,
and **`workflowProgress[]`** — the rendered tree.

**`workflowProgress[]` node types** (the primary render source):
- `{type:"workflow_phase", index, title, detail?}`
- `{type:"workflow_agent", index, label, phaseIndex, phaseTitle, agentId, model,
  state, startedAt, queuedAt, attempt, lastToolName, lastToolSummary,
  promptPreview, resultPreview, lastProgressAt, tokens, toolCalls, durationMs}`

So a **finished** run renders entirely from `wf_*.json`. A **running** run renders
by tailing `journal.jsonl` + per-agent `agent-*.jsonl` until the finalized
`wf_*.json` lands. **Named/saved workflows** (`<project>/.claude/workflows/*.js`)
expose `export const meta = {name, description, whenToUse?, phases[], model?}` and
are parseable statically — argus can list available workflows and their declared
phase structure even before any run exists. (Built-in workflows ship inside the
client, not on disk.)

Open contract questions for research/architecture: exact `state` enum
(`queued`/`running`/`done`/`error`/…); how nested `workflow()`/`pipeline()`/
`parallel()` structure surfaces in the tree (phase grouping + timing vs explicit
edges); live-update event schema in `journal.jsonl` beyond `started`; token/$ cost
fields; how a run in progress is distinguished before `wf_*.json` exists.

---

## Phases (one capability per phase; see `workpads/WORKPADS.md`)

| # | Workpad | Proves |
| --- | --- | --- |
| 1 | `research` | Client availability; connect strategy (file vs ACP vs remote vs headless SDK); the data contract above, hardened; graph-viz library + UI direction; TS stack. **Gate:** a synthesis with locked decisions + a milestone plan. |
| 2 | `architecture` | Ingestion/adapter contract, normalized run model, server↔client API, render/layout pipeline, shell/IA. **Gate:** boundaries doc ratified. |
| 3 | `prototype` | Smallest e2e: pick local project → list runs → render **one finished run** as a fullscreen phase/agent graph from `wf_*.json`. **Gate:** a real `modal-rust` run renders correctly. |
| 4 | `live` | File-watching → live progress as a workflow runs (`journal.jsonl` + `agent-*.jsonl` tail → incremental graph updates). **Gate:** a live run animates correctly to completion. |
| 5 | `inspect` | Drill into a node (prompt, result, transcript, tokens/tools/timing); navigate phase/pipeline structure; "describe this workflow" via Claude. **Gate:** any agent node opens a readable detail view. |
| 6 | `interact` *(exploratory)* | Jump into a session; embedded agent (runs in the project dir) to review & **modify** a workflow. Here ACP / remote-control / headless SDK earn their place. **Gate:** a decision-ready design + spike, not a committed build. |

The intended sequence validates one boundary per step:
`research → architecture → prototype → live → inspect → interact`.

---

## Backlog (cross-cutting; not yet scheduled)

- Multi-run / cross-run views (compare runs of the same named workflow; cost over
  time; flaky-agent detection).
- Cost/token rollups per phase and per run; "where did the wall-clock go".
- Diffing a workflow script against its persisted-per-run source.
- Search across runs (by agent label, by tool, by failure).
- Desktop packaging (Tauri) once the web+local-backend split is proven.
- Theming / shareable read-only snapshots (export a run to a static viewer).

---

## Resolved decisions (research gate, 2026-06-04)

Locked via the research synthesis (`workpads/research/synthesis.md`) and confirmed
by the user:

1. **App shape: web app + local Node/TS backend** for v1 (the only shape that lets a
   browser read local `~/.claude`; the HTTP+SSE seam keeps a later Tauri desktop
   wrapper a cheap sidecar swap).
2. **Frontend: React 19 + `@xyflow/react`** (React Flow), with a hand-rolled
   deterministic phase-lane layout as default and elkjs as a lazy fallback. The run
   model stays framework-agnostic.
3. **Read-only v1, reserve the interact seam.** Build nothing for editing/driving now,
   but architect so it's cheap to add (the embedded-agent vision is a real later goal,
   not abandoned).
4. **Prototype-first, then live.** Ship the finished-run visualizer (M0–M5) first;
   gate the live track (M6–M8) on a real captured running run. **Binding caveat: use
   REAL captured data from the start** (from this project and/or `../modal-rust`) so
   rendering is proven on real, messy runs — fixtures live under `.argus/fixtures/`.

Defaults taken (overridable): raw token/tool activity metrics, no `$` cost; run badge
matches on-disk `status` + a "partial failure" chip; dark-only v1.
