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
