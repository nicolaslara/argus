# live — knowledge

Findings, decisions, open questions for the live-updates phase. Unblocked
2026-06-05 (prototype gate passed).

## Findings

### F1 — `wf_<id>.json` is written ONCE, at finalization (NOT progressive)
Empirically verified 2026-06-05 by polling the filesystem (1 s cadence) while a
2-phase / 3-agent probe workflow ran (`wf_dc04a1d4-e8e`, this argus session):
- t=13 s: `subagents/workflows/wf_<id>/journal.jsonl` appears with 2 lines and grows.
- t=19 s: `workflows/wf_<id>.json` materialises **already `status:"completed"`,
  4047 B, and never changes again**.
There is **no in-progress / partially-written `wf_<id>.json`**. (Confidence: HIGH —
direct observation. The 4 `state:"progress"` agent entries seen in killed runs are
the *kill-time snapshot* written into the single finalize write, not progressive
updates.) **Implication:** running-run detection cannot wait for or poll the json —
the json's existence ≈ the run is OVER. The live source of truth is the journal.

### F2 — the live journal is impoverished: agentId lifecycle only
`journal.jsonl` contains exactly two event types across ALL 30+ captured runs:
`{type:"started", key, agentId}` and `{type:"result", key, agentId, result}`.
- `key` = `v2:<sha>` content-hash of (prompt,opts) — NOT present in the finalized
  json, so it does not join anywhere; **`agentId` is the only join key**.
- **No label, no phaseIndex, no model, no tokens, no timing, no phase/log events.**
  Phase ordering is only *implicit*: a later-phase agent's `started` arrives after
  the prior phase's `result`s (probe: `probe:combine` started only after
  `probe:dag`+`probe:toposort` produced results).
- The `result` event **does** carry the full result text (our preview-cap applies).

### F3 — labels/phases live ONLY in the finalized json
`agentId → label (probe:dag) / phaseIndex / phaseTitle / model / tokens / timing`
exists only in `workflowProgress[].type==="workflow_agent"`. None of it is on disk
during the run. So a journal-only live model is **anonymous** (agents keyed by
agentId, state running/done, result text) unless we recover labels another way.

### F4 — the persisted SCRIPT is on disk at launch (the way to get live labels)
`workflows/scripts/<name>-wf_<id>.js` is written when the workflow launches (the
Workflow tool returns its path immediately), present throughout the run. We already
parse this into a PlanModel (P1a `plan.ts`). **So the live view = the Plan skeleton
(from the script) + journal progress painted on it** — i.e. the Morph view (P2),
driven live. Binding journal agents → plan nodes has no label to join on live, so it
must be **by start-ordered arrival within phase order** (phases advance in script
order; F2). Static plans bind cleanly; dynamic multiplicity / data-dependent loops
are ambiguous → fall back to anonymous agents in a single "running" lane.

### F5 — per-agent `subagents/agent-<id>.jsonl` transcripts are NOT reliable live
MISSING for all 3 probe agents (present for some older modal-rust agents). Do **not**
depend on transcripts for the live model; the journal `result` is the content source.
(Transcript rendering stays an inspect-phase concern, I2, best-effort.)

## Decisions (locked)
- **Detection (L1):** a run is *running* iff its `journal.jsonl` exists AND no
  finalized `wf_<id>.json` exists yet. Add a liveness guard for crashed runs (journal
  with no json AND no journal growth / mtime older than a threshold → `stale`, not
  `running`). The finalized json's appearance is the run-over signal (F1).
- **Live model (L2):** `buildLiveModel(journalEvents, plan?, prev?) -> RunModel` with
  `incomplete:true`, `status:"running"`. Agent state = `result`-seen ? `done` :
  `running`. Labels/phases come from the parsed persisted script (F4) bound by
  start-order; absent/ambiguous → anonymous agents, `incomplete:true`.
- **Reconciliation (L5, later):** when `wf_<id>.json` lands, the authoritative
  finalized model replaces the live one (join by agentId for a no-jump transition).
- Build/verify against a **journal replay** (gate allows it). The probe journal
  `wf_dc04a1d4-e8e` is captured as a fixture (real 2-phase/3-agent lifecycle).

## Open questions
- Live label binding for dynamic multiplicity / loops — heuristic vs. leave anonymous
  until finalize. (M6 leaves ambiguous cases anonymous.)
- Push channel (L3): SSE per boundaries §4 vs. client poll of the snapshot endpoint.
- Debounce/coalesce strategy for rapid journal appends (watch + tail-from-offset).
