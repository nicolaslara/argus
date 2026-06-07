// @argus/adapter — the redaction SEAM for the Session Narrative engine
// (knowledge.md "The redact() seam"; design-options pick = A: a dedicated
// adapter/redact.ts + RedactionStrategy).
//
// argus is a full-access LOCAL tool, so privacy is NOT a gate. Instead, EVERY emitted
// narrative text path — promptPreview, responsePreview, click-in turn text, and (future)
// the bounded head+tail sent to `claude -p` — routes through ONE chokepoint: redact().
//
// TODAY redact() is the IDENTITY function (a noop): nothing is gated, the text is returned
// byte-for-byte. The VALUE now is the SEAM PLACEMENT — adding a real redactor later (a
// `sk-`/`ghp_`/`AKIA`/`bearer`/`token=`/`.env` regex scrubber, or a `/Users/<home> → ~`
// rewrite, or a diff/entropy scanner) is a ONE-LINE strategy swap at this seam, with ZERO
// changes at any call site. Mirrors the single-chokepoint posture of `error-redaction.ts`'s
// `scrubError` (one total function the whole layer funnels through) so the invariant — "all
// emitted text passed through the active strategy" — stays provable in one place.

/**
 * A pluggable redaction strategy: a pure text→text transform. The default is the identity
 * (noop) strategy; a future strategy swaps in a real scrubber WITHOUT touching call sites.
 * Implementations MUST be total (never throw) and SHOULD be deterministic.
 */
export interface RedactionStrategy {
  redact(text: string): string;
}

/** The shipped default: the IDENTITY transform. Returns its input byte-for-byte. */
export const noopRedactionStrategy: RedactionStrategy = {
  redact: (text: string): string => text,
};

/** The single mutable seam. Defaults to the noop; swapped via {@link setRedactionStrategy}. */
let activeStrategy: RedactionStrategy = noopRedactionStrategy;

/**
 * The single chokepoint every emitted narrative text path calls. Today it delegates to the
 * noop identity strategy (text returned unchanged); later, a real strategy is installed via
 * {@link setRedactionStrategy} and EVERY call site is redacted with no further changes.
 * Total: never throws — a hostile strategy that throws falls back to the raw text rather than
 * crashing the parse (defense-in-depth; a redactor failing is never worse than a 500).
 */
export function redact(text: string): string {
  try {
    return activeStrategy.redact(text);
  } catch {
    return text;
  }
}

/**
 * Install a redaction strategy (the one-line swap that turns the noop seam into a real
 * redactor). Returns the previously-active strategy so a caller/test can restore it.
 */
export function setRedactionStrategy(strategy: RedactionStrategy): RedactionStrategy {
  const previous = activeStrategy;
  activeStrategy = strategy;
  return previous;
}

/** Restore the shipped noop identity strategy (the default). Primarily for tests/teardown. */
export function resetRedactionStrategy(): void {
  activeStrategy = noopRedactionStrategy;
}
