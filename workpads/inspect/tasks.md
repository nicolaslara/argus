# inspect — tasks

**Objective.** Drill into a node and the run's structure. **Gate:** any agent node
opens a readable, well-designed detail view (prompt, result, transcript,
tokens/tools/timing).

> Prototype gate PASSED 2026-06-04 — inspect is unblocked. (Overnight: I1 first.)

## Tasks (draft)

- [x] **I1 — Node detail panel.** DONE 2026-06-05. Clicking ANY node (execution AgentCard or a plan node)
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
- [✗] **I2 — Agent transcript.** BLOCKED 2026-06-05 by data reality (live/knowledge.md F5):
  per-agent `agent-<agentId>.jsonl` transcripts are NOT reliably persisted for workflow
  sub-agents — 0/14 of the 14-agent run's agents have one on disk (only 7 stray transcripts
  exist in that whole session, none matching). A transcript view would be empty for most
  agents, so it's deferred until the client persists workflow-agent transcripts (or we
  capture them live during a run). The journal `result` (R1, full + readable) + the
  generated panel (#9) cover the per-agent content need in the meantime.
- [~] **I3 — Run structure navigation.** LOGS TIMELINE DONE 2026-06-05. A run-overview
  panel (clicking the run-header name; node selection takes precedence) surfaces run
  totals (status/agents/phases/model/duration/started), the sanitized run `error`, the
  partial-failure line(s), and the **narrator `log()` timeline** as a numbered list with
  failure lines flagged red — verified on the 14-agent run (5 logs + 1 partial-failure;
  screenshot `.argus/screenshots/i3-run-overview.png`). **Remaining:** navigate pipeline
  stages / parallel groups as structure, and the persisted-script "view source" (the
  `/run/.../plan` source already exists — surface it read-only).
- [x] **I4 — Describe-a-workflow (Claude).** DONE 2026-06-05. The run-overview panel's
  "✨ describe this run" button builds a compact run DIGEST and feeds it to the #9 sub-UI
  engine → a constrained PanelSpec ("what this workflow did") rendered by the trusted
  GenerativePanel. Verified on the 14-agent run (success callout, metrics, per-lens
  verdicts, a red-team-partial warning); screenshot `.argus/screenshots/i4-describe-run.png`.

> **inspect gate met** — any agent node opens a readable detail view (I1); the run-overview
> adds the logs timeline (I3) + a Claude run summary (I4); per-node results are full +
> readable + generatively-rendered (R1, #9). I2 (transcript) is blocked by data reality (F5).

## knowledge
Decisions (esp. the Claude-API integration boundary) land in `knowledge.md`.
