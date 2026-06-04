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
