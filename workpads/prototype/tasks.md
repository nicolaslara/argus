# prototype — tasks

**Objective.** Smallest end-to-end app that renders **one finished run** beautifully
on a fullscreen canvas. **Gate:** a real `modal-rust` run renders correctly,
observed in a browser; reads well at 1 agent and at the 14-agent run.

> Blocked until the architecture gate passes.

## Tasks (draft)

- [ ] **M0 — Scaffold the app** per the R5 stack (frontend + local backend, dev
  server, typecheck/lint/test wired). `tsc --noEmit` + build green; empty app
  loads fullscreen.
- [ ] **M1 — Adapter v0.** Read one `wf_*.json` → normalized run model. Unit-tested
  against a captured `modal-rust` journal (incl. unknown-field tolerance).
- [ ] **M2 — Discovery.** Given a local project path, derive the slug, list its
  sessions + runs (name, status, agentCount, duration, time).
- [ ] **M3 — Render one run.** Run model → fullscreen phase/agent graph (the chosen
  graph lib + layout). Phases group agents; nodes show label/state/model; the graph
  pans/zooms.
- [ ] **M4 — Shell.** Collapsible minimal left toolbar (switch project / pick run);
  canvas is the focus.
- [ ] **M5 — UI smoke + polish.** Render the 14-agent `modal-rust-plan-research`
  run; screenshot/Playwright; pass the UI/UX review lens (reads at a glance,
  legible, beautiful defaults). Update README "Try it".

## knowledge

Evidence (screenshots, the rendered run, test output) and decisions land in
`knowledge.md`.
