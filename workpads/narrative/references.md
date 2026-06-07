# narrative — references

Sources + local paths + dates backing the `narrative` workpad. Empirical claims cite the
exact artifact inspected + the observed field.

## The plan's origin
- **Workflow:** `explore-session-narrative`, run `wf_4e4d6d47-f83` (2026-06-07). 5 parallel
  research agents → 1 design → 3 adversarial reviews → synthesis. Recovered after a transient
  StructuredOutput/socket failure via a `withRetry` wrapper + `resumeFromRunId` (cached the 5
  Ground agents). Script: `.../workflows/scripts/explore-session-narrative-wf_4e4d6d47-f83.js`.

## Data sources (the on-disk surface this feature reads)
- **Session transcript** (NEW surface): `~/.claude/projects/<slug>/<sessionId>.jsonl` — a SIBLING
  file to the `<sessionId>/` dir. For this session `-Users-nicolas-devel-argus/d2cfe0e6-…f741bf.jsonl`,
  ~64–67 MB, 12,865 records, 9,720 timestamped (inspected 2026-06-07).
  - Record-type counts (probed): assistant 5560, user 2721, attachment 801, ai-title 665,
    last-prompt 666, mode 666, permission-mode 666, system 360, queue-operation 278,
    bridge-session 303, file-history-snapshot 179.
  - `tool_use` name counts: Bash 751, Read 424, Edit 413, Workflow 70, Write 86, Playwright `browser_*`.
  - `tool_result.content` is a LIST 880/2600× (140 screenshots / 722 text / 38 tool_reference).
  - ~120 REAL user prompts vs 2,600 tool_result carriers + ~13 synthetic.
  - `/Users/` on 9,660 lines; one 2 MB line; 45 lines > 256 KB; 120 git commits all `-q`.
- **Run journals/models** (existing surface, for run linkage): `<sessionId>/workflows/wf_*.json`
  (finalized), `<sessionId>/workflows/scripts/*.js`, `<sessionId>/subagents/workflows/wf_*/journal.jsonl`.

## Codebase seams to reuse (read these before building)
- `packages/adapter/src/index.ts` — `loadRun`/`parseFinalizedRun` (pure, `FileSystemPort`), `recoverProjectPath`
  (`~:94`), `parseFinalizedRun` (`~:114`), `deriveSlug` (`~:82`, lossy — prefer the `RunRef.slug` field).
- `packages/adapter/src/discovery.ts`, `live.ts` (`parseJournal`/`buildLiveModel`) — the defensive
  line-buffered JSONL + coded-warning + format-pin pattern to mirror.
- `apps/server/src/explain.ts` — the content-addressed local-`claude -p` cache pattern (the M4 engine model).
- `apps/server/src/routes.ts` — `tokenOk`/`hostAllowed`, `safeRun*Path` `resolve()`-inside-`claudeHome`
  guards (the new `discoverSessionTranscript` guard mirrors these for the sibling `.jsonl`),
  `redactInternalPaths` (only strips `/$bunfs/` — M0.5 extends it).
- `apps/web/src/App.tsx` — `ViewMode = 'plan' | 'run'` toggle (~:92); the URL-state pattern; the rail.
- `apps/web/src/nodes/AgentCard.tsx` / `index.css` — the card visual language to reuse for block cards.
- `workpads/architecture/boundaries.md` — §2.2 (adapter surface, HEADER-only discovery), §2.3 (defensive
  parse, emit-allowlist, RunModel size budget test to mirror for the watch-view payload).

## Full workflow output
Findings + design + adversarial verdicts + synthesis captured in `knowledge.md` (decisions) +
`tasks.md` (roadmap). The raw run result is in the run journal under
`<sessionId>/subagents/workflows/wf_4e4d6d47-f83/` (ephemeral task output not committed).
