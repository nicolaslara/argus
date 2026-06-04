# prototype — knowledge

Findings, decisions, and evidence (screenshots, rendered runs, test output) for the
prototype phase. Blocked until the architecture gate passes.

## Findings

- **M0 (2026-06-04):** the 4-package monorepo from `boundaries.md` §1 builds and runs
  on Node 24 / npm 11. Workspace packages resolve via npm symlinks + `exports:
  "./src/index.ts"` + `moduleResolution: bundler` (no build step for the TS libs;
  Vite transpiles the web, tsx runs the server, tsc type-checks the whole tree from
  one root `tsconfig.json`). `@vitejs/plugin-react` v5 + Vite 7 + React 19 install
  clean (no peer conflicts).
- The empty shell renders fullscreen via `@xyflow/react` (dark canvas, dot-grid,
  Controls + MiniMap) with a centered wordmark overlay (`pointer-events:none` so the
  canvas stays pannable). The dev-only console noise was a `favicon.ico` 404 → fixed
  with an inline SVG data-URI favicon (no network request).

## Decisions (locked)

- **eslint ignores `.claude/**`** — the saved workflow scripts use Workflow-tool
  runtime globals (`agent`/`phase`/`log`/`parallel`); they are not app source.
- **vitest pinned to v4** — v3 carried a critical advisory (GHSA-5xrq-8626-4rwp, the
  Vitest UI server) we never trigger, but v4 clears `npm audit` (0 vulns) and our
  test surface is trivial.
- Server **`/health` is token-free** (liveness, no FS access) but still Host-checked;
  `/api` + `/stream` require the per-launch bearer token, enforced before any FS read.

## Evidence

- `.argus/screenshots/argus-m0-empty-shell.png` — empty fullscreen shell at 1440×900.
- Gate (2026-06-04): `tsc --noEmit` clean; `eslint .` clean; `vitest run` 4/4;
  `vite build` ok (190 modules, ~373 KB JS); `npm audit` 0 vulns. Server smoke:
  `/health`→200 (no token), `/api/ping`→401 (no token)/200 (token), bad `Host`→403,
  listener bound to `127.0.0.1` only.

### M1 (2026-06-04) — adapter + node FS port

- **Built:** `packages/adapter/src/raw.ts` (the only raw-format-aware module: zod
  `.passthrough()/.catch()` schemas + projection/sanitize/derive helpers) →
  `parseFinalizedRun(raw, ctx)` (`index.ts`, pure, emit-allowlisted) → `loadRun(port,
  wfJsonPath, ctx)` reads through the injected port. `apps/server/src/fs-port.ts` is
  the **read-only** `NodeFileSystemPort` (no write method; `watch` is a minimal
  `fs.watch` stub — chokidar lands at M6). 38 tests over all 5 fixtures + a port
  contract test.
- **Decision — emitted content is shown verbatim; redaction is scoped.** `$bunfs`
  (Claude's internal cli.js bundle path) must not appear in any **default-rendered**
  field; it is allowed ONLY in the collapsed `error.internalDetail` (per
  `boundaries.md` §2.3). `/Users/` and other user paths in previews/logs/args are the
  user's OWN content shown back locally → **not scrubbed** (capped + text-node
  rendered). Redaction applies to server **logs** and the collapsed `$bunfs` stack,
  not to emitted user content. (Resolved two contradictory assertions the M1
  implementer wrote; the adapter itself was correct per boundaries.)
- **Process note (see the workflow-authoring-gotchas memory):** `argus-implement`
  failed 3× on the final `StructuredOutput` call even after hardening — but the
  **implement agent did the real work on disk** each time. Pragmatic pattern: let the
  workflow implement, then **verify + fix + commit from the main loop** (run the gate,
  resolve any issues) rather than chasing the flaky finalization. The Record phase
  (workpad updates) is being done by hand here for the same reason.
- **Evidence:** `npm test` → 2 files, 38 passed; `tsc --noEmit`, `eslint`, `vite
  build` all green.
