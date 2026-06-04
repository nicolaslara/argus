# argus

A web app for **visualizing and exploring Claude Code workflows** — the multi-agent
runs produced by the `Workflow` tool. argus turns the run journals Claude Code
already writes on disk into a beautiful, fullscreen, interactive graph of phases,
agents, pipelines, tokens, tools, and results.

> Argus Panoptes — the many-eyed watcher. One surface to see everything a workflow
> is doing at once.

## Status

**Phase 1 — research.** No app yet. We are grounding the build plan in verified
facts: how to connect to Claude Code's workflow data (it's all on disk — no client
reverse-engineering needed for v1), the on-disk data contract, the best web
graph-visualization library, the UI direction, and the TypeScript stack.

See [`project.md`](./project.md) for the product vision and the design stances,
[`TASKS.md`](./TASKS.md) for the active phase, and [`workpads/`](./workpads/) for
the per-phase work.

## How it will work (the short version)

Claude Code writes every workflow run to
`~/.claude/projects/<project-slug>/<session>/` — a finalized `workflows/wf_*.json`
per run (carrying the full phase/agent progress tree, result, logs, and timing),
plus live `journal.jsonl` + per-agent transcripts while a run is in progress.
argus's first version points at a **local project directory**, derives its slug,
reads those journals, and renders each run as a graph. Live updates (phase 4) come
from watching the journals as a workflow runs. Richer inspection and interaction
come in later phases.

## Try it

_Nothing to run yet — the prototype lands in phase 3. This section will carry the
exact, minimal commands to render one of your own runs as soon as it does._

## How this repo works

argus is built with the file-backed **workpads** methodology (see
[`AGENTS.md`](./AGENTS.md) and [`WORKING.md`](./WORKING.md)): progress lives in
files and git, one capability is validated per phase, and multi-agent
[`.claude/workflows/`](./.claude/workflows/) encode the planning, plan-refinement,
and implementation loops. Fittingly, argus's own workflow runs are its first
dataset.
