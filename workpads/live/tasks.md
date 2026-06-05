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
- [x] **L3 — Push channel.** DONE 2026-06-05. `GET /api/runs/:slug/:session/:runId/stream`
  is an SSE stream: it fs-watches the journal and pushes a `changed` event per append
  (+ `open`, a 15s heartbeat, `retry:3000` for clean EventSource reconnect). The web
  subscribes while a run is live and invalidates the live query on `changed` (instant, no
  poll lag); a 4s poll is a dropped-stream safety net; the run-list poll detects finalize.
  Verified: two journal appends → two `changed` events over the stream. (Incremental DELTA
  diffs — vs. the current refetch-on-signal — remain a future optimization.)
- [x] **L4 — Live re-layout.** DONE 2026-06-05 (R8b/R9). A running run renders on the
  PLAN (Morph) with done (green) / running (amber, pulsing) / **upcoming** (ghosted) — the
  only view that shows what's NEXT (the Execution model holds only started agents). Screenshot
  `.argus/screenshots/r8-running-morph.png`. (The journal has no `log()` lines — F2 — so a
  live narrator timeline is N/A; the finalized run-overview shows logs, I3.)
- [x] **L5 — Finalize reconciliation.** DONE 2026-06-05. The run list de-dups a finalized
  runId over its running entry; the web swaps `/live`→finalized `/run` when status flips;
  the L6 replay test asserts the final live agent SET + labels equal the finalized json
  (agentId/start-order reconciliation). (A no-jump in-place node swap is a future polish.)
- [x] **L6 — Robustness.** DONE 2026-06-05. Clean reconnect via SSE `retry:`; killed/failed
  handled (interrupted/error agents pop, R8a); a JOURNAL-REPLAY test replays the captured
  journal line-by-line asserting no lost/duplicated nodes + reconciliation to finalized.

> **Live GATE met 2026-06-05:** a journal-replayed run animates to completion (done/running/
> upcoming on Morph, SSE-pushed) with no lost/duplicated nodes and clean reconnect. Residual
> future polish: incremental SSE deltas + a no-jump finalize swap.

## knowledge
Live event schema findings + decisions land in `knowledge.md`.
