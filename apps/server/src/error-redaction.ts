// @argus/server — the error-redaction seam (boundaries.md §4: "never log file contents or
// full paths; codes only"). The HTTP dispatch catch-all used to inline `{ error:
// 'internal_error' }`, which is correct but UNTESTABLE in isolation — a drift (e.g. someone
// "helpfully" attaching err.message to the body) would silently leak an absolute path, a
// `$bunfs/...` runtime path, a stack frame, or a bearer token into a 500 response.
//
// scrubError is the single chokepoint: whatever a route throws (an Error with a path in its
// message, a raw string, a structured object, null/undefined), it returns ONLY the coded
// body. It is intentionally TOTAL and CONSTANT — it never reflects any part of the input — so
// the redaction invariant is provable: there is no input-dependent branch that could echo the
// error's contents. Tests assert this against path/stack/token/$bunfs-bearing errors.

/** The single coded error body shape every internal failure collapses to. */
export interface CodedError {
  error: string;
}

/**
 * Scrub ANY thrown value into a coded 500 body. By construction the output never depends on
 * the input, so no path / stack / `$bunfs` runtime path / bearer token / file content can ever
 * leak through it. Pure, deterministic, total (never throws — even on a getter that throws).
 */
export function scrubError(_err: unknown): CodedError {
  return { error: 'internal_error' };
}
