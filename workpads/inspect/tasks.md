# inspect — tasks

**Objective.** Drill into a node and the run's structure. **Gate:** any agent node
opens a readable, well-designed detail view (prompt, result, transcript,
tokens/tools/timing).

> Prototype gate PASSED 2026-06-04 — inspect is unblocked. (Overnight: I1 first.)

## Tasks (draft)

- [ ] **I1 — Node detail panel.** Clicking ANY node (execution AgentCard or a plan node)
  opens a **right-hand detail panel** (LangSmith-style, per design §2.7) reachable from
  all three views (Plan/Morph/Execution); clicking empty space or a close button dismisses
  it. Enable node selection (`onNodeClick`) WITHOUT enabling drag/connect (keep
  `nodesDraggable`/`nodesConnectable` false). Content from the data ALREADY in hand (no new
  endpoint required for v1):
  - **Execution agent:** label, state, model, tokens, toolCalls, durationMs, queued/started
    timing, attempt, lastToolName/lastToolSummary, the capped `promptPreview` +
    `resultPreview` (show the truncated marker; a "view full result" lazy fetch via the
    existing result handle is a nice-to-have), and the PX caption.
  - **Plan node:** kind, label template, phase, multiplicity, optional/typed, and (for the
    Morph view) its binding (bound agentIds, status, succeeded/total). The code-slice
    "view source" is a nice-to-have (lazy).
  - Render ALL text as text nodes (no `dangerouslySetInnerHTML`) — previews/results can
    carry the user's own content/secrets (boundaries §4). Long fields scroll/clamp+expand.
  - Acceptance: clicking an agent in Execution opens the panel with its full details;
    clicking a plan node in Plan/Morph opens its panel; reads well; closeable; `tsc`/`lint`/
    `test`/`build` green; Playwright screenshot of an open panel. RunModel/PlanModel/Overlay
    contracts unchanged (panel reads existing data).
- [ ] **I2 — Agent transcript.** Render `agent-<agentId>.jsonl` (user/assistant/
  tool messages) readably; link tool calls to `tool-results/*.txt` where present.
- [ ] **I3 — Run structure navigation.** Navigate phases, pipeline stages, and
  parallel groups; surface the `logs[]` narrator timeline and the persisted script
  source.
- [ ] **I4 — Describe-a-workflow (Claude).** Use the Claude API on the script +
  run to generate a plain-language summary of what the workflow did. (First use of
  the Claude API — read-only over local content; privacy stance applies.)

## knowledge
Decisions (esp. the Claude-API integration boundary) land in `knowledge.md`.
