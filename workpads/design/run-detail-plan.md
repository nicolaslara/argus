# Run-view drill: prompts, results, subagents, run-selector — design + plan

Status: DESIGN-ONLY. Companion gallery: `run-detail-gallery.html` (5 mockups). Authored
in the main loop (the plan agent socket-died — the recurring StructuredOutput/socket flake).
Builds on `run-view-merge-plan.md` (the merged Run view) + `failure-and-live-inspector.md`
(the transcript activity drill).

## 1. Decision summary

Keep the **Plan / Run toggle**. Make **Run** the place to *drill*, with three additions the
user asked for, layered by depth:

1. **Run-selector** — Run defaults to the **latest** run of the selected workflow, with a
   compact picker in the Run chrome that opens a drawer of this workflow's other runs
   (status `●/◐/✕/◌` + when + agents·duration); picking one switches the Run view.
2. **Default-expanded fan-outs** — a `×N` step shows its **N instance cards** by default (not
   collapsed), so "what each subagent is doing" is visible without a click.
3. **Prompt + Result, two depths** — every instance card carries a one-line **preview**;
   expanding a card (inline) reveals the **full prompt + result + tool timeline** in place;
   selecting it opens the **rich DetailPanel** for the deep read.

## 2. The detail view — recommended blend

The gallery's five designs split cleanly into "at-a-glance" vs "deep read":

| Mockup | Verdict | Role |
|---|---|---|
| **inline-expand** | **SHIP (primary)** | Fan-out expanded by default; each card = label·status·dur·tokens + a 1-line prompt/result **preview**; an `open ▸` expands that card **in place** to the full prompt + result + tool chips. Answers "see each subagent + its prompt/result" without leaving the lane. |
| **panel-rich** | **SHIP (deep)** | The existing right `DetailPanel`, evolved: collapsible **PROMPT** (verbatim, monospace) / **RESULT** (readable key-value + `{ } raw` JSON toggle) / **ACTIVITY** (the tool timeline we already fetch). The deep single-agent read. Low-friction, keeps the canvas. |
| **run-selector** | **SHIP** | The run picker drawer (§1.1). |
| **transcript-reader** | **LATER** | A focused full-overlay "read the whole agent top-to-bottom" view, reachable from a panel‑rich "open full ⤢". Great for very deep reading; not needed for v1 once inline-expand + panel-rich exist. |
| **bottom-dock** | **NEVER** | A tabbed bottom dock competes with the canvas for vertical space and re-introduces a tab-switch (Prompt/Result/Activity) — the same anti-pattern the Progress/Execution merge removed. The right panel + inline preview dominate it. |

**Why this blend:** inline-expand makes the fan-out + prompts/results legible *in the graph*
(the user's core ask); panel-rich is the calm deep read for one agent; together they cover
"glance at all subagents" → "read one closely" with no modal tab-switching. transcript-reader
is the escalation for the rare "read everything."

## 3. Prompt + Result sourcing (data is in hand)

- **Result** — already served by `/result` (`fetchAgentResult`), the full StructuredOutput
  value (object or string). Render readable (key → value rows; arrays as bullets) with a
  `{ } raw` toggle to the JSON. Reuse the existing `tryReadable`/`JsonReadable` in DetailPanel.
- **Prompt** — the **first `user` message** of `agent-<id>.jsonl`. The adapter parser already
  reads that file (`activity.ts`); add `prompt?: string` to `AgentActivity` (cap length) +
  surface it. No new route — it rides the `/activity` response.
- **Live** — a running agent has no result yet → show the prompt + the live tool timeline +
  "running…" (the `/activity` refetch already polls at 4s).

## 4. Default-expanded fan-outs

- Seed `expandedNodeIds` with **all fanned steps** of the selected run by default (extend the
  current `live`-only seed in `App.tsx`), so a finished run also opens its fans. User can
  collapse any (state is user-owned after seed, already implemented).
- Respect the **>24 chip-degrade** (run-view-merge-plan.md Ship #6, Phase 2): above the
  threshold a fan stays collapsed to chips + "expand" — auto-expand only up to the readability
  budget, then `log`/note the rest. Avoids a 50-fan exploding the canvas.

## 5. Phased plan

**Phase 1 — prompts + results in the drill (highest value).**
- `packages/adapter/src/activity.ts` + `packages/contract` — add `prompt?: string` to
  `AgentActivity`; parser captures the first user message (capped). +test.
- `apps/web/src/nodes/DetailPanel.tsx` — add a **PROMPT** section (from activity.prompt) above
  the existing RESULT/ACTIVITY; ensure RESULT readable+raw is present for the bound agent
  (single-agent plan step already drills via `bindAgentIds[0]`).
- Acceptance: selecting any agent (instance or single-agent step) shows its verbatim prompt +
  readable result + raw toggle + activity. UI-smoke: a research instance + the failed implement.

**Phase 2 — default-expanded fan-outs + inline card preview/expand.**
- `apps/web/src/App.tsx` — seed `expandedNodeIds` with all fanned steps (within the degrade
  budget) on run-change.
- `apps/web/src/nodes/AgentCard.tsx` / `AgentCardShell.tsx` + `overlay-expand.ts` — instance
  card gains a 1-line **preview** (result/prompt) + an `open ▸` that expands it inline to the
  full prompt/result (reuse the DetailPanel renderers in a compact inline variant); grow the
  drawer row for the expanded card (extend the existing `expandInstances` arithmetic).
- Acceptance: a ×7 step shows 7 cards by default; expanding one reveals its prompt+result in
  the lane; >24 stays degraded.

**Phase 3 — run-selector.**
- `apps/web/src/nodes/RunSelector.tsx` (new) — current run chip + a drawer of the workflow's
  runs (reuse `runsQ` filtered to the workflow + `statusGlyph`/`formatRelativeTime`); pick →
  `handleSelectRun`. Rendered in the Run-view chrome (near the run-header).
- Default to latest (`defaultRun`/most-recent). Acceptance: switch runs from the canvas; status
  visible per row; the selected/latest highlighted; a running one pulses.

**Phase 4 (LATER) — transcript-reader** full-overlay, opened from panel-rich "open full ⤢".

## 6. Non-goals
- No bottom dock / new tab-switch (re-creates the merged-away split).
- No new fetch beyond `/activity` (carries the prompt) + the existing `/result`.
- No eager fetch of every agent's prompt/result — lazy per visible/expanded card.
- Raw stacks / raw JSON only behind a toggle; never copy transcript content off-machine.

## 7. Open questions
1. Inline-expanded card: show **result-first** with prompt collapsed, or both peers? (Proposed:
   result-first; prompt is one click.)
2. Default-expand budget: expand all fans up to N total instances (e.g. 24), else leave the
   biggest collapsed? Confirm N.
3. Run-selector home: a chip by the run-header (compact) vs a left-edge strip in the Run view?
   (Proposed: run-header chip + drawer.)
