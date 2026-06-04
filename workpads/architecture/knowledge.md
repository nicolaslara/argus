# architecture — knowledge

Decisions, findings, open questions for the architecture phase. Blocked until the
research gate passes. Canonical ratified contracts live in `boundaries.md` (created
during this phase).

## Findings

The ratified contracts are in [`boundaries.md`](./boundaries.md), distilled from the
adversarially-reviewed research synthesis (`workpads/research/synthesis.md` §2):
adapter (single format-aware module behind `FileSystemPort`, parse-permissive /
emit-allowlisted, heavy-field caps, lazy script+transcript+result), run model
(`Run→Phase[]→Agent[]`, synthesized phase-spine edges only, derived state enum,
run-level partial-failure, sanitized `error`), server↔client API (REST snapshot +
SSE deltas, `RunRef` keyed by recovered `projectPath`, localhost+token+CSP+path
security), the live path (running detection, journal-tail authoritative, finalize
reconciliation), render/layout (xyflow + hand-rolled lane layout default, elk lazy
fallback, batched relayout), shell/IA, the failure-mode catalog, and the
format-version policy.

## Decisions (locked)

- **Edges are INFERRED, not read** — the journal has no agent edges (R3); the only
  edge is the synthesized `phase_i → phase_i+1` spine.
- **Live transport = SSE** (not WebSocket); deltas patch `node.data` in place,
  re-layout only on structural change (batched).
- **`RunRef` keyed by recovered absolute `projectPath`** (from `scriptPath`), never by
  the lossy slug; slug collisions surface as multiple switcher entries.
- All other §2 decisions ratified in `boundaries.md`.

## Open questions (carried to implementation)

- Exact live journal-flush timing — must be confirmed against a **real captured live
  run** before the M7/M8 live gate (residual risk from research).
- Sub-workflow (`workflow()`) on-disk nesting — no fixture yet; revisit when one
  appears.
