// @argus/web — the PURE, React-free persistence seam for the explorer PINNED-WORKFLOWS set
// (the Workflow lens lets you PIN a workflow so it sorts to the top regardless of recency, so
// active work stays reachable as run counts grow). The Rail holds the set in state and mirrors it
// to localStorage so the choice sticks across reloads; this module owns the read/write/normalize
// (and the pure toggle) so it can be unit-tested (the node test env has no `localStorage`) WITHOUT
// importing the full React app. Mirrors group-by-setting.ts / loop-drill-setting.ts exactly:
//   - DEFAULT is the EMPTY set (nothing pinned — the zero-regression baseline, recency sort wins).
//   - the value is a comma-separated list of workflowNames; reading NORMALIZES it (trims each
//     entry, drops empties/dupes) so a malformed value (extra commas, whitespace) degrades to a
//     clean set rather than throwing or polluting the tree with phantom names.
//   - a missing / private-mode / throwing store is non-fatal: read → empty set, write → no-op.

/** The localStorage key the pinned-workflows set is persisted under. */
export const PINNED_KEY = 'argus.pinnedWorkflows';

/** The default pinned set when nothing valid is persisted (empty — recency sort wins). */
export const DEFAULT_PINNED_WORKFLOWS: ReadonlySet<string> = new Set<string>();

/** The minimal `Storage` surface we touch (so a test can inject a fake without a DOM). */
export interface PinnedStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Resolve the persisted value into a clean Set of workflow names. The default store is the
 * ambient `localStorage`; a missing/throwing store (private mode, node) degrades to an empty set.
 * The stored value is a comma-separated list; each entry is trimmed and empties/dupes are dropped
 * so a malformed value ("foo,,, bar ") normalizes to a clean set instead of phantom-pinning "".
 */
export function readPinnedWorkflows(store: PinnedStore | undefined = ambientStore()): Set<string> {
  if (!store) return new Set();
  try {
    const v = store.getItem(PINNED_KEY);
    return parsePinned(v);
  } catch {
    return new Set();
  }
}

/**
 * Persist the pinned set as a normalized comma-separated list. A disabled/throwing store is
 * non-fatal — the set simply won't survive a reload (the in-memory Rail state still reflects it
 * this session). Names are sorted so the stored value is stable (no spurious rewrites on reorder).
 */
export function writePinnedWorkflows(
  set: ReadonlySet<string>,
  store: PinnedStore | undefined = ambientStore(),
): void {
  if (!store) return;
  try {
    store.setItem(PINNED_KEY, serializePinned(set));
  } catch {
    // a private-mode / disabled store is non-fatal — the setting simply won't persist.
  }
}

/**
 * PURE pin toggle: returns a NEW Set with `name` flipped (added if absent, removed if present).
 * Never mutates the input set — the Rail relies on a fresh reference so the groupRuns memo re-runs
 * and the tree re-sorts. A blank/whitespace name is a no-op (returns a copy unchanged).
 */
export function togglePinned(name: string, set: ReadonlySet<string>): Set<string> {
  const next = new Set(set);
  const clean = name.trim();
  if (clean === '') return next;
  if (next.has(clean)) next.delete(clean);
  else next.add(clean);
  return next;
}

/** Parse a stored comma-separated value into a clean Set (trim, drop empties/dupes). */
function parsePinned(value: string | null): Set<string> {
  if (!value) return new Set();
  const out = new Set<string>();
  for (const part of value.split(',')) {
    const name = part.trim();
    if (name !== '') out.add(name);
  }
  return out;
}

/** Serialize a Set to a stable, normalized comma-separated value (sorted, trimmed, no empties). */
function serializePinned(set: ReadonlySet<string>): string {
  const names: string[] = [];
  for (const raw of set) {
    const name = raw.trim();
    if (name !== '') names.push(name);
  }
  return names.sort().join(',');
}

/** The ambient browser store, or undefined where there is none (e.g. the node test env). */
function ambientStore(): PinnedStore | undefined {
  try {
    const ls = (globalThis as { localStorage?: PinnedStore }).localStorage;
    return ls ?? undefined;
  } catch {
    // accessing localStorage can THROW (sandboxed iframe / disabled cookies), not just be absent.
    return undefined;
  }
}
