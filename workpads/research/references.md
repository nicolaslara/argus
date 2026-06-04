# research — references

External/local sources with URLs/paths and observation dates. Prefer primary
sources; for the undocumented on-disk format, the primary source is the real
artifacts themselves.

## Local artifacts (primary evidence for the on-disk format)

- `~/.claude/projects/-Users-nicolas-devel-modal-rust/27b1a6f8-92a6-42eb-a6f1-5f34d8db36b4/`
  — 16 real workflow runs (statuses `completed`/`failed`/`killed`, 1–14 agents).
  Inspected 2026-06-04. The reference dataset for R3.
  - `workflows/wf_9f32796b-c0b.json` — the 14-agent `modal-rust-plan-research`
    finalized journal (richest example of `workflowProgress[]`).
  - `subagents/workflows/wf_9f32796b-c0b/{journal.jsonl, agent-*.jsonl, agent-*.meta.json}`
    — live event stream + per-agent transcripts.
  - `workflows/scripts/*.js` — persisted per-run script sources.
- `../modal-rust/.claude/workflows/*.js` — saved/named workflow definitions
  (`plan-research.js`, `refine-plan.js`, `implement.js`, `materialize-workpads.js`)
  with `export const meta` blocks. Inspected 2026-06-04.
- `~/.claude/projects/` — the project-slug directory listing used to derive the
  slug rule. Inspected 2026-06-04.

## Docs to gather (R1, R2, R5) — to be filled by the workflow

- Claude Code official docs (features, Workflow tool, settings, sessions) — via the
  claude-code-guide agent / official docs.
- Claude Agent SDK docs (headless agents) — relevant to R2/interact.
- ACP (Agent Client Protocol) spec/docs — relevant to R2/interact.
- Claude API docs — relevant to inspect-phase "describe this workflow".

## Library docs to gather (R4, R5) — to be filled by the workflow

- Graph libs: React Flow, Svelte Flow, Reaflow, Cytoscape.js, Sigma.js,
  vis-network, AntV G6, D3 + elkjs / dagre / d3-hierarchy. (Use the context7 MCP +
  official docs; record versions + dates.)
- Stack: Vite, Bun vs Node, Tauri, a test runner (Vitest), Playwright.

## Prior-art references (R6) — to be filled by the workflow

- LangSmith / trace viewers; GitHub Actions & Buildkite DAG views; n8n / ComfyUI /
  Blender node editors; observability waterfalls.
