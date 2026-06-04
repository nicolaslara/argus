# live — tasks

**Objective.** Watch the journals so a *currently running* workflow renders live.
**Gate:** a live (or journal-replayed) run animates to completion with no
lost/duplicated nodes and clean reconnect.

> Unblocked 2026-06-05 (prototype gate passed). The on-disk live behavior is now
> empirically locked — see knowledge.md F1–F5.

## Tasks (draft)

- [~] **L1 — Running-run detection.** ADAPTER CORE DONE 2026-06-05. `classifyRunLiveness`
  (running/stale/finalized) + `discoverRunningRunsReport` (scans
  `subagents/workflows/<runId>/journal.jsonl` for runs with no finalized json) land in the
  adapter, tested on a real captured journal. Key finding (F1): the finalized json is
  written ONCE at finalize, so its *existence* ≈ run-over — detection keys off "journal but
  no json". **Remaining:** merge `discoverRunningRunsReport` into the server run-list + a
  "● running" row.
- [~] **L2 — Journal tailing.** ADAPTER CORE DONE 2026-06-05. `parseJournal` (line-
  independent), `reduceJournal`, `buildLiveModel(journalText, ref, {plan})` build a partial
  `RunModel` (`incomplete:true`, `status:'running'`): agent state running→done from
  started/result, labels/phases recovered from the persisted script by start-order binding
  (F4) else anonymous. Proven by an incremental journal-replay test on the real probe run.
  **Remaining:** server `/live` endpoint (`loadLiveModel`) + a `chokidar` watch re-reading
  on append. Transcripts are NOT reliable live (F5) — the journal `result` is the content.
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
