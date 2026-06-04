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
- [~] **L3 — Push channel.** FIRST CUT DONE 2026-06-05 via POLLING (a valid
  snapshot-on-connect transport): `GET /api/runs/:slug/:session/:runId/live` serves the
  partial model; the web fetches it for a `running` run and re-polls every 1.5 s, and
  re-polls the run list every 2.5 s so a running→completed flip is noticed. **Remaining:**
  the SSE/chokidar delta stream (incremental, not full re-fetch) per boundaries §4.
- [~] **L4 — Live re-layout.** STATE-TRANSITIONS DONE 2026-06-05: the execution view
  renders the live model with queued→running→done agent colors (running = blue) and a
  pulsing "● running" run badge; verified on a frozen mid-run fixture (3 done + 1 running,
  screenshot `.argus/screenshots/m6-live-execution.png`). **Remaining:** smooth re-layout
  without jarring jumps as the node set grows; surface the narrator `log()` lines (the
  journal has none — F2 — so logs come from the finalized model or a future event).
- [ ] **L5 — Finalize reconciliation.** When `wf_*.json` lands, reconcile the live
  model with the authoritative finalized one. PARTIAL: the run list de-dups a finalized
  runId over its running entry, and the web swaps `/live`→finalized `/run` once the status
  flips. Remaining: a no-jump in-place swap keyed by agentId (vs. the current refetch).
- [ ] **L6 — Robustness.** Reconnect after a dropped channel; handle killed/failed
  mid-run; replay a captured journal in a test.

## knowledge
Live event schema findings + decisions land in `knowledge.md`.
