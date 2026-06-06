// @argus/web — the PURE, React-free persistence seam for the loop-drill MODE setting
// (loop-drill-gallery.html opt1 vs opt2). App.tsx holds the mode in state and mirrors it to
// localStorage so the choice sticks across reloads; this module owns the read/write/normalize
// so it can be unit-tested (the node test env has no `localStorage`) WITHOUT importing the full
// React app. Behaviour is byte-identical to the old inline App helpers:
//   - DEFAULT is 'round-axis' (option 1, the fully-working baseline).
//   - ONLY the exact string 'lane-drawer' selects option 2; anything else (missing key,
//     garbage, a removed/renamed value) degrades to the default.
//   - a missing / private-mode / throwing store is non-fatal: read → default, write → no-op.

import type { LoopDrillMode } from './expand-context.ts';

/** The localStorage key the loop-drill mode is persisted under. */
export const LOOP_DRILL_MODE_KEY = 'argus.loopDrillMode';

/** The default mode when nothing valid is persisted (option 1 — the working baseline). */
export const DEFAULT_LOOP_DRILL_MODE: LoopDrillMode = 'round-axis';

/** The minimal `Storage` surface we touch (so a test can inject a fake without a DOM). */
export interface ModeStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Resolve the persisted value into a valid mode. The default store is the ambient
 * `localStorage`; a missing/throwing store (private mode, node) degrades to the default.
 * Exactly mirrors the App helper: only the literal 'lane-drawer' opts into option 2.
 */
export function readLoopDrillMode(store: ModeStore | undefined = ambientStore()): LoopDrillMode {
  if (!store) return DEFAULT_LOOP_DRILL_MODE;
  try {
    const v = store.getItem(LOOP_DRILL_MODE_KEY);
    return v === 'lane-drawer' ? 'lane-drawer' : DEFAULT_LOOP_DRILL_MODE;
  } catch {
    return DEFAULT_LOOP_DRILL_MODE;
  }
}

/**
 * Persist the chosen mode. A disabled/throwing store is non-fatal — the setting simply
 * won't survive a reload (the in-memory App state still reflects the choice this session).
 */
export function writeLoopDrillMode(
  mode: LoopDrillMode,
  store: ModeStore | undefined = ambientStore(),
): void {
  if (!store) return;
  try {
    store.setItem(LOOP_DRILL_MODE_KEY, mode);
  } catch {
    // a private-mode / disabled store is non-fatal — the setting simply won't persist.
  }
}

/** The ambient browser store, or undefined where there is none (e.g. the node test env). */
function ambientStore(): ModeStore | undefined {
  try {
    const ls = (globalThis as { localStorage?: ModeStore }).localStorage;
    return ls ?? undefined;
  } catch {
    // accessing localStorage can THROW (sandboxed iframe / disabled cookies), not just be absent.
    return undefined;
  }
}
