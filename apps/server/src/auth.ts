// @argus/server — the PURE auth guards (per-launch token + DNS-rebinding host/origin),
// extracted from index.ts so they are unit-testable WITHOUT the server's listen()-on-import
// side effect. boundaries.md §4: the per-launch bearer token gates ALL /api + /stream routes
// (401 before any filesystem access); the Host/Origin allowlist defeats DNS rebinding
// independent of CORS. Both are pure (the secret/allowlists are passed in), so index.ts wires
// its launch-time constants and a test can exercise the decisions directly.

import type { IncomingMessage } from 'node:http';

/**
 * The per-launch bearer-token gate. True iff the request carries the EXACT token, either as
 * `Authorization: Bearer <token>` OR as a `?token=<token>` query param. The query form exists
 * because EventSource — the only client of the /stream route — cannot set request headers, so a
 * live SSE subscription authenticates via the query string. A missing/blank/mismatched token is
 * always false (→ the caller sends 401 before any filesystem access).
 */
export function tokenOk(req: IncomingMessage, url: URL, token: string): boolean {
  if (req.headers.authorization === `Bearer ${token}`) return true;
  return url.searchParams.get('token') === token;
}

/**
 * DNS-rebinding guard: the Host header must be one of the allowed binds, and any Origin present
 * must be allowed. A request with no Origin (a same-origin GET / EventSource) passes the Origin
 * check; a foreign Origin is rejected even if the Host somehow matched.
 */
export function hostAllowed(
  req: IncomingMessage,
  allowedHosts: ReadonlySet<string>,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  const host = req.headers.host ?? '';
  if (!allowedHosts.has(host)) return false;
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.has(origin)) return false;
  return true;
}
