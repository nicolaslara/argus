# Failure & live execution inspector — why / how / when / where

Status: DESIGN-ONLY (empirically grounded). Companion to `run-view-merge-plan.md`;
this is the *content* the merged Run view + `DetailPanel` should carry. Triggered by
two user observations: (1) running agents show only an id + empty `dur/tok/tools`;
(2) a failed run shows a red badge but never says why/how/when/where it failed.

## 1. The empirical unlock — the data is all on disk

A workflow run dir (`…/subagents/workflows/<runId>/`) contains, **per agent**, a full
Claude Code session transcript `agent-<id>.jsonl` (100KB–1.2MB) next to the `journal.jsonl`.
Verified live against a running run and a failed run.

- **journal.jsonl** — only `{type:'started'|'result', agentId, key, result?}`. No labels,
  tokens, tools, or timing. (Our F1–F5 finding — the journal is *starved*.)
- **agent-`<id>`.jsonl** — the rich source. Event types `user` / `assistant` / `attachment`:
  - first `user.message` = the agent's **prompt / task** (→ a real label, not a hash).
  - each `assistant.message.usage` = `{input_tokens, output_tokens, cache_read_input_tokens}` → **tokens**.
  - `assistant.message.content[].tool_use` = **tool names** (Read/Bash/Edit/…) → a tool timeline.
  - every event `timestamp` → **duration / when**, and the **last** event = current/final activity.
- **finalized `wf_<id>.json`** — already carries `error` and `args`. The adapter parses
  `error` into `RunModel.error: RunError {message, internalDetail?}` (`contract:47,109`;
  `adapter/index.ts:237` via `sanitizeError`, raw bunfs stack hidden in `internalDetail`),
  and `args` into `RunModel.args`. **Both reach the client today and are never rendered.**

## 2. Worked diagnosis — failed run `wf_9a98db65` (argus-implement)

| Q | Answer | Source (on disk today) |
|---|---|---|
| **Where** | the **Implement** agent `a79a5932` — `started`, **no `result`** (Select agent completed) | journal: started w/o result |
| **Why (proximate)** | "subagent completed without calling StructuredOutput (after 2 nudges)" | `RunModel.error.message` |
| **Why (root)** | last transcript line = `API Error: The socket connection was closed unexpectedly` → died before finalize | `agent-a79a5932….jsonl` tail |
| **How** | did the work first: `Bash×14, Read×15, Edit×7`, **0 StructuredOutput** | transcript tool timeline |
| **When** | `21:58:01 → 22:02:01` (~4 min, 95 events) | transcript timestamps |

Root cause is a **transient API socket close**, not agent laziness — the edits likely
landed on disk while the run was marked `failed`. Confirms the `workflow-authoring-gotchas`
memory: heavy-schema agents flake on finalize; work lands; the run reads as failed.

## 3. The display gaps (today)

1. **`run.error.message` is never shown.** A failed run = a bare red "failed" badge; the
   reason sits unused in `RunModel`. (`App.tsx` only renders `partialFailure` badges.)
2. **Failure isn't attributed to a step/agent.** The screenshot shows *Implement* as
   `1/1 done` on a failed run — the agent that died (started, no terminal result) should
   read as the **failure point**, not "done". Verify the overlay's done-count treats
   started-without-result-on-a-failed-run as failed/interrupted, not done.
3. **Live cards are starved** (`dur — / tok — / tools —`, title = raw agentId) because they
   read only the journal. The transcript is right there.
4. **No drill into an agent's activity** — you can't see what it's doing/did.

## 4. The design — a transcript-fed inspector (folds into the merged Run view)

Same orthogonality rule: this is **content**, not a new view. It lives in the `Run` view
chrome + the existing `DetailPanel`.

- **Failure banner (why/when/where).** When `run.status==='failed'` (or `error!=null`):
  a calm banner at the top of the Run view — `run.error.message` + the failing step/agent
  + elapsed-to-failure. The failing node gets a red **failure-point** ring (not "done").
  "Details ▾" reveals `internalDetail` (the stack) for advanced users — behind a click,
  never raw by default.
- **Live + finished agent card (how/tokens/tools).** Fill `dur` (transcript timespan),
  `tok` (Σ usage), `tools` (distinct tool_use names + counts), and a **label** (derived
  from the prompt's first line) — for *every* agent, not just done ones.
- **Agent inspector (the drill).** Clicking an agent opens `DetailPanel` with a **tool/
  activity timeline** (each tool_use + timestamp), the **last activity** (running) or the
  **final error/result** (done/failed), and token totals. For a running agent this is the
  live "what's happening right now"; for a failed one it ends on the failing line (e.g. the
  socket-close), which IS the root-cause answer.

## 5. Implementation sketch (DESIGN-ONLY; build after run-view merge)

- **Adapter (the only format-aware module):** new `agentActivityFromJournalDir(port, runDir, agentId)`
  → `{ label, tools: {name,count}[], tokens, startedAt, lastAt, timeline: {t, kind, name}[], lastText, error? }`,
  parsing `agent-<id>.jsonl` defensively behind the `FileSystemPort` (zod; tolerate the
  big/partial live file by streaming/tailing, cap lines). Extends the existing
  `agentResultFromJournal` seam.
- **Server:** a lazy route like the existing `/result` (e.g. `/agent-activity?agentId`),
  same security envelope; never bundled into the run list (cost).
- **Web:** render `run.error` in the Run-view banner + node ring; enrich the agent card +
  `DetailPanel` from the new endpoint (lazy, on select / for live agents).
- **Non-goals:** no copying transcripts off-machine; no eager parse of every transcript in
  the list view; raw stack only behind a click.

## 6. Open questions

1. Do transcripts persist indefinitely, or get cleaned? (Old 14-agent run had none; recent
   runs do.) If they're cleaned, the inspector is best-effort — degrade gracefully to the
   journal + `run.error`.
2. Tokens — show per-agent only, or roll up a run total in the NOW strip?
3. Attribution: when several agents lack a terminal result on a failed run, which is "the"
   failure point — the last-started, or all of them flagged?
