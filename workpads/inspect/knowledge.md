# inspect — knowledge

Findings, decisions, open questions for the inspect phase. Blocked until the
prototype gate passes.

## Findings
- **I1 (2026-06-05): the detail panel needs NO new endpoint.** Every scalar it shows is
  already plumbed onto `node.data` by the I1 data-plumbing pass (full AgentNode fields for
  exec; kind/typed/optional/confidence/condition/multiplicity + overlay binding for plan).
  The panel reads `node.data` synchronously — instant open, no fetch, no contract change.
- **Title precedence matters across views.** Plan agent nodes carry the authored *template*
  in `labelRaw` (`research:${r.key}`) and the static prefix in `title` (`research:`); exec
  agents carry the concrete `label` (`research:modal-rs-surface`) and no `labelRaw`. The
  panel title resolves `labelRaw ?? label ?? title ?? conditionLabel ?? type` so it matches
  what the node card shows in all three views (caught by a Morph-view visual audit where the
  title had collapsed to `research:`).

## Decisions (locked)
- **No `dangerouslySetInnerHTML` anywhere in the panel.** Previews/results/labels echo the
  user's own run content and may contain secrets — all rendered as React text nodes
  (boundaries §4). Capped `promptPreview`/`resultPreview` show a `truncated` marker; the
  full-result lazy fetch is deferred (I2).
- Node selection is enabled (`onNodeClick`/`onPaneClick`) WITHOUT enabling drag/connect
  (`nodesDraggable`/`nodesConnectable` stay false) — the read-only path is preserved.

## Open questions
- Where does the Claude API call run (local backend) and how is content kept on the
  user's machine / not logged? (Privacy stance.)
- Transcript rendering: how much of a large `agent-*.jsonl` to load eagerly.
