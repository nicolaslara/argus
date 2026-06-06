// @argus/web — the PURE, React-free persistence seam for the explorer GROUP-BY lens
// (Workflow | Time | Status). The Rail holds the lens in state and mirrors it to localStorage
// so the choice sticks across reloads; this module owns the read/write/normalize so it can be
// unit-tested (the node test env has no `localStorage`) WITHOUT importing the full React app.
// Mirrors loop-drill-setting.ts exactly:
//   - DEFAULT is 'workflow' (the original tree — the fully-working, zero-regression baseline).
//   - ONLY the exact strings 'time' / 'status' select the other lenses; anything else (missing
//     key, garbage, a removed/renamed value) degrades to the default.
//   - a missing / private-mode / throwing store is non-fatal: read → default, write → no-op.

import type { RailGroupBy } from './shell/Rail.tsx';

/** The localStorage key the group-by lens is persisted under. */
export const GROUP_BY_KEY = 'argus.groupBy';

/** The default lens when nothing valid is persisted ('workflow' — the original tree). */
export const DEFAULT_GROUP_BY: RailGroupBy = 'workflow';

/** The minimal `Storage` surface we touch (so a test can inject a fake without a DOM). */
export interface GroupByStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Resolve the persisted value into a valid lens. The default store is the ambient
 * `localStorage`; a missing/throwing store (private mode, node) degrades to the default.
 * Only the exact strings 'time' / 'status' opt into the non-default lenses.
 */
export function readGroupBy(store: GroupByStore | undefined = ambientStore()): RailGroupBy {
  if (!store) return DEFAULT_GROUP_BY;
  try {
    const v = store.getItem(GROUP_BY_KEY);
    return v === 'time' || v === 'status' ? v : DEFAULT_GROUP_BY;
  } catch {
    return DEFAULT_GROUP_BY;
  }
}

/**
 * Persist the chosen lens. A disabled/throwing store is non-fatal — the setting simply
 * won't survive a reload (the in-memory Rail state still reflects the choice this session).
 */
export function writeGroupBy(
  groupBy: RailGroupBy,
  store: GroupByStore | undefined = ambientStore(),
): void {
  if (!store) return;
  try {
    store.setItem(GROUP_BY_KEY, groupBy);
  } catch {
    // a private-mode / disabled store is non-fatal — the setting simply won't persist.
  }
}

/** The ambient browser store, or undefined where there is none (e.g. the node test env). */
function ambientStore(): GroupByStore | undefined {
  try {
    const ls = (globalThis as { localStorage?: GroupByStore }).localStorage;
    return ls ?? undefined;
  } catch {
    // accessing localStorage can THROW (sandboxed iframe / disabled cookies), not just be absent.
    return undefined;
  }
}
