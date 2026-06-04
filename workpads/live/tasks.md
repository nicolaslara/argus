# live — tasks

**Objective.** Watch the journals so a *currently running* workflow renders live.
**Gate:** a live (or journal-replayed) run animates to completion with no
lost/duplicated nodes and clean reconnect.

> Blocked until the prototype gate passes.

## Tasks (draft)

- [ ] **L1 — Running-run detection.** Identify in-progress runs (per R3) before a
  finalized `wf_*.json` exists.
- [ ] **L2 — Journal tailing.** Watch `subagents/workflows/wf_*/journal.jsonl` +
  `agent-*.jsonl`; parse incremental events into run-model deltas.
- [ ] **L3 — Push channel.** Stream deltas to the client (transport per R2/R5);
  snapshot-on-connect + incremental thereafter.
- [ ] **L4 — Live re-layout.** Apply deltas to the graph without jarring jumps;
  show queued→running→done state transitions and the narrator `log()` lines.
- [ ] **L5 — Finalize reconciliation.** When `wf_*.json` lands, reconcile the live
  model with the authoritative finalized one.
- [ ] **L6 — Robustness.** Reconnect after a dropped channel; handle killed/failed
  mid-run; replay a captured journal in a test.

## knowledge
Live event schema findings + decisions land in `knowledge.md`.
