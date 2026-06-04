# inspect — tasks

**Objective.** Drill into a node and the run's structure. **Gate:** any agent node
opens a readable, well-designed detail view (prompt, result, transcript,
tokens/tools/timing).

> Blocked until the prototype gate passes.

## Tasks (draft)

- [ ] **I1 — Node detail view.** Open an agent: full prompt, `resultPreview`/result,
  `model`, `state`, tokens, toolCalls, timing, `attempt`, `lastToolName`.
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
