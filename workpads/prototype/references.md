# prototype — references

Sources + the captured sample journals used as fixtures (kept under gitignored
`.argus/` since they contain run content). Inherits the research/architecture
references; add prototype-specific ones with dates.

## Captured real-run fixtures (2026-06-04)

`.argus/fixtures/` — curated real runs from `modal-rust` + `argus`; see
[`.argus/fixtures/README.md`](../../.argus/fixtures/README.md) for the manifest.
Covers the edge cases the adapter/render must survive: a 14-agent layout stress
case, a 3-agent simple run, a `failed` run, a `killed` mid-multi-agent run
(`state:"progress"`), and our own `failed`→resumed run (`cached:true` agents +
`parallel`/nested structure). `runs/` holds full `journal.jsonl` + agent
transcripts for live/inspect. M1 (adapter) and M3 (render) build against these.

> A fresh **live** run still needs capturing before the M7/M8 live gate (capture a
> `subagents/workflows/wf_<id>/` dir while a workflow is mid-run).

## P0 — Plan view sources (2026-06-04)

- **Real on-disk meta verified:** `/Users/nicolas/devel/modal-rust/.claude/workflows/`
  holds 10 `*.js` workflow definitions; `plan-research.js` declares
  `meta.name = 'modal-rust-plan-research'` with `phases: [{title:'Research',...},
  {title:'Design',...},{title:'Review',...},{title:'Synthesize',...}]` (each with a
  `detail` string used as the Plan-view subtitle). Confirmed via
  `GET /api/projects/-Users-nicolas-devel-modal-rust/workflows` against the real
  `~/.claude` (token-gated server on :4317) → 10 `WorkflowMeta`.
- **Screenshots (gitignored `.argus/screenshots/`):**
  `argus-p0-plan-research-plan.png` (the run-free Plan view: 4 declared lanes +
  subtitles, Playwright 1440×900) and `argus-p0-execution-toggle-back.png` (the
  Plan→Execution toggle returning to the unchanged M3 14-agent run).
- **Verifier independent re-run (2026-06-04):** live server on the real `~/.claude` →
  10 `WorkflowMeta`; token/Host/method/slug gates re-confirmed (401/403/405/400);
  emitted keys exactly the allowlisted `WorkflowMeta` set (no `scriptPath` leak); Stance 4
  diff-clean (`packages/adapter`, `packages/contract`, `apps/web/src/mapping.ts`
  byte-identical vs HEAD). Live Playwright on the 14-agent run + Plan view, 0 app console
  errors. Verdict: COMPLETE, capability_proven: true. Commits: `baf8769` + `eb11e07` on
  branch `phase1-scaffold-and-research`.
- **Stray/misplaced artifact (to remove):** `verify-p0-plan.png` was committed to the
  REPO ROOT in `eb11e07` (should live under gitignored `.argus/screenshots/`); Plan-view
  only, no run/transcript content. See `knowledge.md` P0 open question.

## PX — Explanation layer sources (2026-06-04)

- **Real on-disk engine verified:** `claude` is on PATH here (v2.1.162); the explanation
  layer shells out to `claude -p --model haiku --output-format json` via
  `apps/server/src/explain.ts` and caches captions under the argus repo's own gitignored
  `.argus/cache/explanations/<hash>.json`. Verified live on the real `~/.claude`
  modal-rust project: `plan-research` (11 nodes) + the 14-agent run (14 execution agents)
  both enrich.
- **UI-smoke screenshots (gitignored `.argus/screenshots/`):**
  `argus-px-enriched-caption.png` (Plan view of the real `modal-rust-plan-research` AST
  plan with LLM captions on fan-out/agent/merge nodes) and
  `argus-px-degraded-baseline.png` (`claude` stripped from PATH → baseline captions,
  byte-identical topology). Verifier captured a fresh Playwright screenshot of the
  **14-agent execution view at 1440×900, 0 console errors** (captions 2-line-clamped with
  a green left-tick; the single-agent Synthesize lane reads well — covers the 1-agent
  case).
- **Verifier independent re-run (2026-06-04):** verdict COMPLETE, capability_proven:
  true. Re-ran tsc/lint/build green + vitest 95/95; live cache cold-miss (50s / 11 files
  written) vs warm-reload on a fresh server process (~1s / 0 writes); `claude`-stripped
  graceful degrade (engineAvailable=false, all baseline, /health 200, no crash, no cache
  writes); annotation-only confirmed at the wire (no caption fields in /plan or run
  snapshot); Stance-4/isolation/privacy + security gates (401/400/403, cache outside the
  target `.claude` tree, no secret leakage) all hold. Follow-up logged (not a PX
  regression): the horizontal Plan-AST elk layout leaves ~60% of the canvas empty —
  Plan-view layout polish, out of scope for PX.
