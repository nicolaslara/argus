# WORKPADS.md

Per-workpad objectives, load lists, and gates. `../TASKS.md` chooses which is
active. Keep each workpad's `tasks.md` cockpit-like; canonical decisions live in
`knowledge.md` (and, for architecture, `boundaries.md`).

Every workpad loads the base set first: `../AGENTS.md`, `../project.md`,
`../WORKING.md`, this file, then its own `tasks.md` / `knowledge.md` /
`references.md`.

---

## research (phase 1) — active

**Objective.** Ground the entire build plan in verified facts and lock the
foundational decisions so architecture can proceed with confidence.

Answer, with evidence:
1. **Client availability** — For workflow-era Claude Code, is the client source
   available, leaked, or only documented? Do we need any of it, or is the on-disk
   contract sufficient? (Spoiler from seeded evidence: the files suffice for v1 —
   confirm and bound this.)
2. **Connection strategy per phase** — file-watch (read journals) vs ACP vs "remote
   control" vs the headless Agent SDK. Establish *why file-first is right for v1*
   and *which later capability (live/inspect/interact) would justify each heavier
   mechanism*.
3. **Data contract, hardened + versioned** — confirm/extend the observed contract
   in `project.md`: the `state` enum, how nested `pipeline`/`parallel`/`workflow`
   structure surfaces, the live `journal.jsonl` event schema, running-run detection,
   token/cost fields.
4. **Graph-visualization library + UI direction** — the decisive comparison
   (React Flow / Reaflow / Cytoscape / Sigma / D3 + a layout engine like elk/dagre,
   etc.) against argus's needs: phase-grouped agent graph, 1–14+ nodes, live
   updates, rich node cards, fullscreen pan/zoom, great default aesthetics. This is
   a first-class deliverable — UI quality is a stance.
5. **TypeScript stack + shape** — frontend framework, backend/runtime (Node/Bun),
   bundler, and web-vs-desktop (Tauri) for v1.

**Load list.** Base set + `workpads/research/{tasks,knowledge,references}.md`. The
seeded data contract in `knowledge.md` is verified evidence — build on it.

**Gate.** A synthesis (`workpads/research/synthesis.md` or in `knowledge.md`) with
locked decisions, a milestone plan, and explicit user questions. The primary tool
is `.claude/workflows/plan-research.js`.

---

## architecture (phase 2)

**Objective.** Turn the research synthesis into ratified contracts in
`workpads/architecture/boundaries.md`:
- **Adapter contract** — the only module that knows the raw on-disk format; inputs
  (paths), outputs (normalized run model), and its defensive-parsing guarantees.
- **Run model** — the normalized graph (run → phases → agents; pipeline/parallel
  structure; state; metrics; previews) the rest of the app consumes.
- **Server↔client API** — discovery, snapshot, and incremental/live updates; typed.
- **Render/layout pipeline** — run model → laid-out graph → canvas.
- **Shell / IA** — fullscreen canvas + collapsible minimal left toolbar.
- **Failure modes** — malformed/partial/huge journal, killed mid-run, no runs yet.

**Load list.** Base set + architecture workpad files. Reads heavily from the
research synthesis.

**Gate.** `boundaries.md` ratified — internally consistent, derived from research,
failure modes covered.

---

## prototype (phase 3)

**Objective.** The smallest end-to-end app that renders **one finished run**
beautifully: pick a local project → derive slug → list its runs → render a chosen
run's phase/agent graph from `wf_*.json` on a fullscreen canvas with the minimal
shell. Dogfood on `../modal-rust`.

**Load list.** Base set + `architecture/boundaries.md` + prototype workpad files.

**Gate.** A real `modal-rust` run renders correctly, observed in a browser
(screenshot/Playwright). Reads well at 1 agent and at the 14-agent run.

---

## live (phase 4)

**Objective.** Watch the journals so a workflow that is *currently running* renders
live: tail `subagents/workflows/wf_*/journal.jsonl` + `agent-*.jsonl`, push
incremental updates to the client, and reconcile with the finalized `wf_*.json`
when it lands.

**Load list.** Base set + `architecture/boundaries.md` + live workpad files.

**Gate.** A live (or journal-replayed) run animates to completion with no
lost/duplicated nodes and clean reconnect.

---

## inspect (phase 5)

**Objective.** Drill into a node: prompt, result, agent transcript
(`agent-*.jsonl`), tokens/tools/timing; navigate phase/pipeline structure; and
"describe this workflow" using Claude on the script + run.

**Load list.** Base set + `architecture/boundaries.md` + inspect workpad files.

**Gate.** Any agent node opens a readable, well-designed detail view.

---

## interact (exploratory)

**Objective.** Design (not necessarily build) the interactive layer: jump into a
session, and an **embedded agent** running in the project dir to review and modify
a workflow. This is where ACP / remote control / the headless Agent SDK are
evaluated against the file-first baseline.

**Load list.** Base set + `architecture/boundaries.md` + interact workpad files +
the research findings on connection strategy.

**Gate.** A decision-ready design matrix + spike plan. Does **not** change the
proven read-only path; any write/drive capability is an explicit user opt-in.
