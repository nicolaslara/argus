// @argus/web — the collapsible left rail (M4 shell), redesigned to a VS Code-style TREE.
//
// The fix for "weird": the prior panel rendered Workflows and Runs as two FLAT SIBLING
// lists, asserting they're peers — but a run is an INSTANCE OF a workflow, and the reader
// had to re-join them by the workflow name repeated on every run row. The tree makes
// containment literal: a finished run is drawn INSIDE its workflow (like a file in a
// folder), so the join IS the indentation and the run row drops the redundant name.
//
// Live runs are a first-class, NOT-name-joined REGION pinned to the top: while running a
// run's workflowName is '' (discovery emits one running RunSummary per live journal, with
// no cap), so it's structurally unjoinable and there can be N≥1 of them. Calm budget: at
// most ONE animated token per visible region — the LIVE group header pulses once (its N
// children are static), so two concurrent dogfood runs still mount exactly one pulse.
//
// Selection is LIFTED into App (controlled); the rail only reports the choice. All labels
// are React text nodes; consumes ONLY @argus/contract types (no node:* / adapter import).

import { memo, useCallback, useMemo, useState } from 'react';
import type { ProjectRef, RunSummary, WorkflowMeta } from '@argus/contract';
import type { LoopDrillMode } from '../expand-context.ts';
import { readGroupBy, writeGroupBy } from '../group-by-setting.ts';
import { filterTree } from '../filter-runs.ts';
import { formatDuration, formatRelativeTime, isStale, statusGlyph } from './format.ts';

// 'explorer' is the tree; 'settings' the stub. ('projects'/'runs' accepted for back-compat.)
export type RailSection = 'explorer' | 'settings' | 'projects' | 'runs';

// The explorer's group-by LENS: re-buckets the SAME finished runs into different TreeNode[].
// 'workflow' = the original tree (workflows as folders); 'time' = recency buckets; 'status' =
// Failed/Completed. Orthogonal to selection/canvas — it only changes which TreeNode[] render.
export type RailGroupBy = 'workflow' | 'time' | 'status';

interface RailProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  section: RailSection;
  onSelectSection: (s: RailSection) => void;

  projects: ProjectRef[];
  selectedProjectPath: string | undefined;
  onSelectProject: (p: ProjectRef) => void;
  projectsLoading: boolean;

  runs: RunSummary[];
  selectedRunId: string | undefined;
  onSelectRun: (r: RunSummary) => void;
  runsLoading: boolean;

  workflows: WorkflowMeta[];
  selectedWorkflowName: string | undefined;
  onSelectWorkflow: (w: WorkflowMeta) => void;

  // Settings: the loop-drill MODE (round-axis vs lane-drawer) + its setter, surfaced as a
  // segmented control in the ⚙ settings pane.
  loopDrillMode: LoopDrillMode;
  onSelectLoopDrillMode: (mode: LoopDrillMode) => void;
  // Whether the active run actually has a drillable (>1-round) loop. When false the loop-drill
  // mode has no visible effect, so the control is shown as inert (dimmed + an explanatory note)
  // instead of reading as a broken toggle.
  loopDrillable: boolean;
}

/** Newest-first by startTime; runs without a startTime sort last (stable). */
function runsNewestFirst(runs: RunSummary[]): RunSummary[] {
  return [...runs].sort((a, b) => (b.startTime ?? -Infinity) - (a.startTime ?? -Infinity));
}

/** A tree node = a workflow folder (declared OR ad-hoc-by-name) or a Time/Status bucket. */
export interface TreeNode {
  key: string;
  name: string; // display label
  // The declared WorkflowMeta (→ clicking the folder opens its Plan). null = an AD-HOC workflow
  // folder (a distinct workflowName with no declared workflow → no Plan) or a Time/Status bucket.
  workflow: WorkflowMeta | null;
  runs: RunSummary[]; // finished runs, newest-first
  orderKey: number; // max(startTime) of its runs — immutable, for a frozen sort
  // 'bucket' = a Time/Status grouping header (whole label toggles open/closed); undefined for
  // workflow folders (declared or ad-hoc) where the label opens the Plan / toggles the folder.
  kind?: 'bucket';
}

/** max(startTime) of a run list — immutable, drives the frozen sort. */
function maxStart(rs: RunSummary[]): number {
  return rs.reduce((m, r) => Math.max(m, r.startTime ?? 0), 0);
}

/**
 * Split an (already newest-first) run list into RECENT (≤7d) and OLDER (>7d) by an
 * INJECTED reference time — the recency-fold input. Pure: delegates the boundary to
 * isStale() (which mirrors the timeBucket cutoff), so a folder's fold matches its
 * age-dimming. Order within each partition is preserved (so it stays newest-first).
 */
export function partitionByRecency(
  runs: RunSummary[],
  referenceNow: number,
): { recent: RunSummary[]; older: RunSummary[] } {
  const recent: RunSummary[] = [];
  const older: RunSummary[] = [];
  for (const r of runs) {
    if (isStale(r.startTime, referenceNow)) older.push(r);
    else recent.push(r);
  }
  return { recent, older };
}

/** How many recent runs a folder shows before the rest fold under a "+N older" toggle. */
const RECENT_CAP = 5;

/**
 * The group-by LENS reducer: re-buckets the SAME finished runs into different TreeNode[]
 * depending on `groupBy`. Running runs are NEVER bucketed here (they live in the pinned
 * LiveGroup), and every branch freezes membership + order on IMMUTABLE fields (startTime +
 * terminal status) so a running→completed transition can't move a row between buckets mid-poll.
 * All branches emit the same TreeNode[] shape so WorkflowTreeNode / RunRow render unchanged.
 */
export function groupRuns(runs: RunSummary[], workflows: WorkflowMeta[], groupBy: RailGroupBy): TreeNode[] {
  const finished = runs.filter((r) => r.status !== 'running');

  // --- 'workflow' (default): one folder per DISTINCT workflowName. Declared workflows are folders
  //     even with 0 runs; every ad-hoc/inline workflowName (a run whose workflowName is NOT a
  //     declared workflow) becomes its OWN named folder too — so a run is findable by its name in
  //     the Workflow lens just as it is in Time/Status (no opaque "(other runs)" catch-all). ---
  if (groupBy === 'workflow') {
    const wfNames = new Set(workflows.map((w) => w.name));
    const byName = new Map<string, RunSummary[]>();
    for (const r of finished) {
      const list = byName.get(r.workflowName);
      if (list) list.push(r);
      else byName.set(r.workflowName, [r]);
    }
    // (1) one node per declared workflow (even with 0 runs), keyed on its file.
    const nodes: TreeNode[] = workflows.map((w) => {
      const rs = runsNewestFirst(byName.get(w.name) ?? []);
      return { key: `wf:${w.file}`, name: w.name, workflow: w, runs: rs, orderKey: maxStart(rs) };
    });
    // (2) one node per AD-HOC workflowName (not a declared workflow), keyed on the name itself so
    //     it's stable + distinct from the file-keyed declared folders. workflow:null = no Plan to
    //     open (the folder still toggles to reveal its runs, same as a declared folder).
    for (const [name, rs] of byName) {
      if (wfNames.has(name)) continue;
      const sorted = runsNewestFirst(rs);
      nodes.push({ key: `wf:${name}`, name: name || '(unnamed)', workflow: null, runs: sorted, orderKey: maxStart(sorted) });
    }
    // (3) sort: declared-with-runs first (most-recent on top), then declared-empty (by name),
    //     then ad-hoc folders (by recency, newest-first). Keyed on immutable startTime/name.
    const rank = (n: TreeNode): number => {
      const adHoc = n.workflow === null;
      if (!adHoc && n.runs.length > 0) return 0; // declared, with runs
      if (!adHoc) return 1; // declared, empty
      return 2; // ad-hoc
    };
    nodes.sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      // declared-empty: alphabetical (no runs → no recency); everything else: recency, newest-first.
      if (ra === 1) return a.name.localeCompare(b.name);
      return b.orderKey - a.orderKey || a.name.localeCompare(b.name);
    });
    return nodes;
  }

  // --- 'time': recency buckets keyed on the IMMUTABLE startTime (Today → Older). ---
  if (groupBy === 'time') {
    // Bucket order is fixed Today→Older; each bucket's runs are newest-first. Empty buckets omitted.
    const order = ['today', 'yesterday', 'week', 'older'] as const;
    const labels: Record<(typeof order)[number], string> = {
      today: 'Today',
      yesterday: 'Yesterday',
      week: 'This week',
      older: 'Older',
    };
    const buckets: Record<(typeof order)[number], RunSummary[]> = { today: [], yesterday: [], week: [], older: [] };
    for (const r of finished) buckets[timeBucket(r.startTime)].push(r);
    const nodes: TreeNode[] = [];
    for (const k of order) {
      const rs = runsNewestFirst(buckets[k]);
      if (rs.length === 0) continue;
      nodes.push({ key: `time:${k}`, name: labels[k], workflow: null, runs: rs, orderKey: maxStart(rs), kind: 'bucket' });
    }
    return nodes;
  }

  // --- 'status': terminal-status buckets (Failed = failed|killed, Completed = completed). ---
  const failed: RunSummary[] = [];
  const completed: RunSummary[] = [];
  for (const r of finished) {
    if (r.status === 'failed' || r.status === 'killed') failed.push(r);
    else completed.push(r);
  }
  const nodes: TreeNode[] = [];
  // Failed first (the thing you're scanning for), then Completed; empty buckets omitted.
  if (failed.length > 0) {
    const rs = runsNewestFirst(failed);
    nodes.push({ key: 'status:failed', name: 'Failed', workflow: null, runs: rs, orderKey: maxStart(rs), kind: 'bucket' });
  }
  if (completed.length > 0) {
    const rs = runsNewestFirst(completed);
    nodes.push({ key: 'status:completed', name: 'Completed', workflow: null, runs: rs, orderKey: maxStart(rs), kind: 'bucket' });
  }
  return nodes;
}

/** Which recency bucket a finished run falls in, keyed on its IMMUTABLE startTime. */
function timeBucket(startMs: number | null): 'today' | 'yesterday' | 'week' | 'older' {
  if (startMs == null || !Number.isFinite(startMs)) return 'older';
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 86_400_000;
  if (startMs >= startOfToday) return 'today';
  if (startMs >= startOfToday - dayMs) return 'yesterday';
  if (startMs >= startOfToday - 7 * dayMs) return 'week';
  return 'older';
}

export const Rail = memo(function Rail(props: RailProps) {
  const {
    collapsed,
    onToggleCollapsed,
    section,
    onSelectSection,
    projects,
    selectedProjectPath,
    onSelectProject,
    projectsLoading,
    runs,
    selectedRunId,
    onSelectRun,
    runsLoading,
    workflows,
    selectedWorkflowName,
    onSelectWorkflow,
    loopDrillMode,
    onSelectLoopDrillMode,
    loopDrillable,
  } = props;

  // The explorer group-by lens. 'workflow' (default) is the original tree; 'time'/'status'
  // re-bucket the SAME finished runs. Unlike other ephemeral rail selections this is a personal
  // finding HABIT, so it's mirrored to localStorage (read on init, written on change) the same
  // way App persists the loop-drill mode — non-fatal if the store is missing/disabled.
  const [groupBy, setGroupByState] = useState<RailGroupBy>(() => readGroupBy());
  const setGroupBy = useCallback((g: RailGroupBy) => {
    setGroupByState(g);
    writeGroupBy(g);
  }, []);

  // The explorer FILTER lens — an ephemeral substring query over workflow name + status.
  // Unlike groupBy this is exploratory (not a habit), so it is NOT persisted: it resets on
  // reload. It composes with — never replaces — the group-by lens.
  const [filterQuery, setFilterQuery] = useState('');

  // ONE reference time per render cycle (passed down to the age-dim + recency-fold children),
  // so the memoized RunRow / WorkflowTreeNode don't churn on a fresh Date.now() per render.
  const referenceNow = Date.now();

  // --- split + group + filter (memoized; order keyed on immutable startTime so the 2.5s live
  //     poll never reshuffles the tree) ---------------------------------------------------
  const liveRuns = useMemo(() => runsNewestFirst(runs.filter((r) => r.status === 'running')), [runs]);
  const grouped = useMemo<TreeNode[]>(() => groupRuns(runs, workflows, groupBy), [runs, workflows, groupBy]);
  // The filter runs AFTER grouping so it composes orthogonally with the lens; live runs are
  // NEVER filtered (they're the ACTIVITY stream — always visible in the pinned LiveGroup).
  const tree = useMemo<TreeNode[]>(() => filterTree(grouped, filterQuery), [grouped, filterQuery]);
  // Time/Status lenses bucket runs from many workflows, so the run row must re-show the workflow
  // name (it's no longer implied by the parent folder). The Workflow lens leaves it off (nested).
  const showWorkflowName = groupBy !== 'workflow';

  // Per-node open state. Folders start COLLAPSED by default — the selected workflow's folder is
  // still highlighted (isSelectedWorkflow) without auto-expanding, and running runs stay visible in
  // the pinned LiveGroup, so liveness never depends on a folder being open.
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set());
  const isOpen = (key: string) => openKeys.has(key);
  const toggle = (key: string) =>
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  function openSection(s: RailSection) {
    onSelectSection(s);
    if (collapsed) onToggleCollapsed();
  }

  const anyLive = liveRuns.length > 0;

  return (
    <aside className={`rail${collapsed ? ' is-collapsed' : ''}`} aria-label="navigation">
      <nav className="rail-strip" aria-label="sections">
        <button
          type="button"
          className="rail-icon rail-toggle"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? 'expand navigation' : 'collapse navigation'}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? '»' : '«'}
        </button>

        <div className="rail-icon-group">
          <button
            type="button"
            className={`rail-icon${!collapsed && section !== 'settings' ? ' is-active' : ''}`}
            onClick={() => openSection('explorer')}
            aria-label="explorer"
            aria-pressed={!collapsed && section !== 'settings'}
            title="Projects · workflows · runs"
          >
            <span className="rail-glyph">▤</span>
            {/* one pulsing dot if ANY run is live AND the panel is collapsed (never concurrent
                with the LIVE region, which only exists in the expanded panel). */}
            {collapsed && anyLive ? <span className="rail-strip-live" aria-hidden="true" /> : null}
          </button>
        </div>

        <button
          type="button"
          className={`rail-icon rail-settings${!collapsed && section === 'settings' ? ' is-active' : ''}`}
          onClick={() => openSection('settings')}
          aria-label="settings"
          aria-pressed={!collapsed && section === 'settings'}
          title="Settings"
        >
          <span className="rail-glyph">⚙</span>
        </button>
      </nav>

      {collapsed ? null : section === 'settings' ? (
        <div className="rail-panel">
          <section className="rail-section" aria-label="settings">
            <header className="rail-section-head">Settings</header>
            <LoopDrillSetting mode={loopDrillMode} onSelect={onSelectLoopDrillMode} drillable={loopDrillable} />
            <div className="rail-muted rail-settings-stub">
              <p>argus · local-first, read-only</p>
              <p>Dark theme · v1</p>
            </div>
          </section>
        </div>
      ) : (
        <div className="rail-panel">
          <section className="rail-section rail-explorer" aria-label="project explorer">
            <ProjectSwitcher
              projects={projects}
              selectedProjectPath={selectedProjectPath}
              onSelectProject={onSelectProject}
              loading={projectsLoading}
            />

            <GroupByControl groupBy={groupBy} onSelect={setGroupBy} />

            <FilterInput query={filterQuery} onChange={setFilterQuery} />

            {anyLive ? (
              <LiveGroup
                runs={liveRuns}
                selectedRunId={selectedRunId}
                onSelectRun={onSelectRun}
                referenceNow={referenceNow}
              />
            ) : null}

            <div className="rail-tree" role="tree">
              {runsLoading && tree.length === 0 ? (
                <div className="rail-muted">loading…</div>
              ) : tree.length === 0 ? (
                <div className="rail-muted">
                  {filterQuery.trim() !== '' ? 'no runs match this filter' : 'no workflows or runs for this project'}
                </div>
              ) : (
                tree.map((node) => (
                  <WorkflowTreeNode
                    key={node.key}
                    node={node}
                    open={isOpen(node.key)}
                    onToggle={() => toggle(node.key)}
                    selectedRunId={selectedRunId}
                    isSelectedWorkflow={node.workflow?.name === selectedWorkflowName}
                    onSelectWorkflow={onSelectWorkflow}
                    onSelectRun={onSelectRun}
                    showWorkflowName={showWorkflowName}
                    referenceNow={referenceNow}
                  />
                ))
              )}
            </div>
          </section>
        </div>
      )}
    </aside>
  );
});

/** The loop-drill MODE setting: a labelled segmented control (Round axis | Lane drawer) +
 *  a one-line description. The choice is owned + persisted by App; this only reports it. */
const LoopDrillSetting = memo(function LoopDrillSetting({
  mode,
  onSelect,
  drillable,
}: {
  mode: LoopDrillMode;
  onSelect: (mode: LoopDrillMode) => void;
  // False when the active run has no loop that ran >1 round → the mode has nothing to act on.
  drillable: boolean;
}) {
  return (
    <div className="rail-setting">
      <div className="rail-setting-label">
        Loop drill
        {!drillable ? <span className="rail-setting-tag"> · inert here</span> : null}
      </div>
      {/* When there's nothing to drill the buttons still toggle the (persisted) preference, but
          they're dimmed so the control doesn't read as a broken no-op. */}
      <div
        className="rail-segmented"
        role="group"
        aria-label="loop drill mode"
        style={drillable ? undefined : { opacity: 0.5 }}
      >
        <button
          type="button"
          className={`rail-segmented-btn${mode === 'round-axis' ? ' is-active' : ''}`}
          aria-pressed={mode === 'round-axis'}
          onClick={() => onSelect('round-axis')}
          title="Round axis: the loop stays compact; rounds open in the detail panel (default)."
        >
          Round axis
        </button>
        <button
          type="button"
          className={`rail-segmented-btn${mode === 'lane-drawer' ? ' is-active' : ''}`}
          aria-pressed={mode === 'lane-drawer'}
          onClick={() => onSelect('lane-drawer')}
          title="Lane drawer: round agents expand as cards inside the loop (the back-edge re-routes)."
        >
          Lane drawer
        </button>
      </div>
      <p className="rail-setting-note">
        {!drillable
          ? 'No multi-round loop to drill in this run. Open a run whose loop ran more than once, then ⊞ unroll it and click a round.'
          : mode === 'round-axis'
            ? 'Loop rounds open in the detail panel — the loop box stays compact.'
            : 'Round agents expand as cards inside the loop — the back-edge routes around them.'}
      </p>
    </div>
  );
});

/** The explorer group-by LENS: a 3-way segmented control (Workflow | Time | Status) that
 *  re-buckets the SAME finished runs. Reuses the .rail-segmented styles from the settings
 *  toggle. Owned + reported by the Rail; it only changes which TreeNode[] render (orthogonal
 *  to selection/canvas). */
const GroupByControl = memo(function GroupByControl({
  groupBy,
  onSelect,
}: {
  groupBy: RailGroupBy;
  onSelect: (g: RailGroupBy) => void;
}) {
  const opts: { value: RailGroupBy; label: string; title: string }[] = [
    { value: 'workflow', label: 'Workflow', title: 'Group runs under their workflow (default).' },
    { value: 'time', label: 'Time', title: 'Group runs by recency — Today, Yesterday, This week, Older.' },
    { value: 'status', label: 'Status', title: 'Group runs by outcome — Failed, Completed.' },
  ];
  return (
    <div className="rail-groupby">
      <div className="rail-segmented" role="group" aria-label="group runs by">
        {opts.map((o) => (
          <button
            key={o.value}
            type="button"
            className={`rail-segmented-btn${groupBy === o.value ? ' is-active' : ''}`}
            aria-pressed={groupBy === o.value}
            onClick={() => onSelect(o.value)}
            title={o.title}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
});

/** The explorer FILTER lens: a calm substring input (workflow name + status) below the
 *  group-by control. Controlled by the Rail; composes with the lens. A clear (×) button
 *  appears only when there's a query. Reuses the rail's segmented border/background tokens. */
const FilterInput = memo(function FilterInput({
  query,
  onChange,
}: {
  query: string;
  onChange: (q: string) => void;
}) {
  return (
    <div className="rail-filter">
      <div className="rail-filter-box">
        <span className="rail-filter-icon" aria-hidden="true">⌕</span>
        <input
          type="text"
          className="rail-filter-input"
          value={query}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Filter by name, status…"
          aria-label="filter runs by name or status"
          spellCheck={false}
          autoComplete="off"
        />
        {query !== '' ? (
          <button
            type="button"
            className="rail-filter-clear"
            onClick={() => onChange('')}
            aria-label="clear filter"
            title="Clear filter"
          >
            ×
          </button>
        ) : null}
      </div>
    </div>
  );
});

/** The pinned-top LIVE region: a group header (the ONE pulse) + static child rows. */
const LiveGroup = memo(function LiveGroup({
  runs,
  selectedRunId,
  onSelectRun,
  referenceNow,
}: {
  runs: RunSummary[];
  selectedRunId: string | undefined;
  onSelectRun: (r: RunSummary) => void;
  // Accepted for a consistent call shape with the finished-run rows; live runs are always
  // "now" so they never read as stale — the prop is intentionally not used for dimming here.
  referenceNow: number;
}) {
  void referenceNow;
  return (
    <div className="rail-live" role="group" aria-label="live runs">
      <div className="rail-live-head">
        <span className="rail-live-dot" aria-hidden="true" />
        <span className="rail-live-title">Live</span>
        <span className="rail-live-count">
          {runs.length} running
        </span>
      </div>
      <ul className="rail-list rail-indent">
        {runs.map((r) => {
          const active = r.ref.runId === selectedRunId;
          // labeled from data that EXISTS while running: a short run id + client elapsed.
          const elapsed = r.startTime ? formatDuration(Date.now() - r.startTime) : null;
          const shortId = r.ref.runId.replace(/^wf_/, '');
          return (
            <li key={`${r.ref.sessionId}/${r.ref.runId}`}>
              <button
                type="button"
                className={`rail-row rail-live-child${active ? ' is-active' : ''}`}
                onClick={() => onSelectRun(r)}
                aria-pressed={active}
                title={`running — ${r.ref.runId}`}
              >
                <span className="rail-run-line">
                  <span className="rail-status status-running rail-live-child-dot" aria-hidden="true">
                    {statusGlyph('running', false)}
                  </span>
                  <span className="rail-row-title">{r.workflowName || shortId}</span>
                </span>
                <span className="rail-run-meta">{elapsed ? `≈${elapsed} active` : 'running'}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
});

/** One workflow folder: a clickable header (→ Plan) + a twisty; children = its runs. */
const WorkflowTreeNode = memo(function WorkflowTreeNode({
  node,
  open,
  onToggle,
  selectedRunId,
  isSelectedWorkflow,
  onSelectWorkflow,
  onSelectRun,
  showWorkflowName,
  referenceNow,
}: {
  node: TreeNode;
  open: boolean;
  onToggle: () => void;
  selectedRunId: string | undefined;
  isSelectedWorkflow: boolean;
  onSelectWorkflow: (w: WorkflowMeta) => void;
  onSelectRun: (r: RunSummary) => void;
  showWorkflowName: boolean;
  referenceNow: number; // injected so age-dim + recency-fold are deterministic/testable
}) {
  const hasChildren = node.runs.length > 0;
  const isBucket = node.kind === 'bucket'; // a Time/Status grouping header (label toggles)
  // An ad-hoc workflow folder (workflowName with no declared workflow): no Plan to open, so its
  // label TOGGLES the folder (revealing its named runs) — the same affordance as a Time/Status
  // bucket. Only a label with nothing to do at all (no Plan AND no children) stays disabled.
  const isAdHocWorkflow = node.workflow === null && !isBucket;
  const labelInert = isAdHocWorkflow && !hasChildren;

  // RECENCY FOLD: show the most-recent RECENT_CAP runs; collapse the rest under a "+N older"
  // toggle so a deep folder doesn't bury recent activity. "older" = the stale (>7d) runs PLUS
  // any recent runs past the cap (a folder with 20 today-runs still folds the tail). Fold state
  // is local per node — switching lenses re-mounts the node, so it starts collapsed (acceptable:
  // the fold is a per-folder convenience, not a persisted preference).
  const [showOlder, setShowOlder] = useState(false);
  const { recent, older } = partitionByRecency(node.runs, referenceNow);
  const visibleRecent = recent.slice(0, RECENT_CAP);
  const foldedOlder = [...recent.slice(RECENT_CAP), ...older];
  return (
    <div className="rail-treenode" role="treeitem" aria-expanded={open}>
      <div className={`rail-tree-head${isSelectedWorkflow ? ' is-active' : ''}`}>
        <button
          type="button"
          className="rail-twisty"
          onClick={onToggle}
          aria-label={open ? 'collapse' : 'expand'}
          disabled={!hasChildren}
        >
          {hasChildren ? (open ? '▾' : '▸') : '·'}
        </button>
        <button
          type="button"
          className="rail-tree-label"
          onClick={() => (node.workflow ? onSelectWorkflow(node.workflow) : onToggle())}
          title={node.workflow?.description || node.name}
          disabled={labelInert}
        >
          <span className="rail-tree-kind" aria-hidden="true">{isBucket ? '▤' : isAdHocWorkflow ? '◷' : '◇'}</span>
          <span className="rail-tree-name">{node.name}</span>
          <span className="rail-tree-count">{node.runs.length || '—'}</span>
        </button>
      </div>
      {open && hasChildren ? (
        <ul className="rail-list rail-indent">
          {visibleRecent.map((r) => (
            <RunRow
              key={`${r.ref.sessionId}/${r.ref.runId}`}
              run={r}
              active={r.ref.runId === selectedRunId}
              onSelect={onSelectRun}
              showWorkflowName={showWorkflowName}
              referenceNow={referenceNow}
            />
          ))}
          {foldedOlder.length > 0 ? (
            <li>
              <button
                type="button"
                className="rail-fold-toggle"
                onClick={() => setShowOlder((v) => !v)}
                aria-expanded={showOlder}
                title={showOlder ? 'Hide older runs' : 'Show older runs'}
              >
                <span className="rail-fold-icon" aria-hidden="true">{showOlder ? '▾' : '▸'}</span>
                <span className="rail-fold-label">
                  {showOlder ? 'fewer' : `+${foldedOlder.length} older`}
                </span>
              </button>
            </li>
          ) : null}
          {showOlder
            ? foldedOlder.map((r) => (
                <RunRow
                  key={`${r.ref.sessionId}/${r.ref.runId}`}
                  run={r}
                  active={r.ref.runId === selectedRunId}
                  onSelect={onSelectRun}
                  showWorkflowName={showWorkflowName}
                  referenceNow={referenceNow}
                />
              ))
            : null}
        </ul>
      ) : null}
    </div>
  );
});

/** A finished run row. Under the Workflow lens the parent folder implies the workflow, so the
 *  name is omitted; under the Time/Status lenses (`showWorkflowName`) the row re-shows the
 *  workflow name because the bucket parent no longer implies it. */
const RunRow = memo(function RunRow({
  run: r,
  active,
  onSelect,
  showWorkflowName = false,
  referenceNow,
}: {
  run: RunSummary;
  active: boolean;
  onSelect: (r: RunSummary) => void;
  showWorkflowName?: boolean;
  // Injected reference time → AGE-DIMMING: a run >7d old gets `.is-stale` (reduced opacity)
  // so recent work pops. Deterministic (never reads the wall clock here); the Rail passes one
  // referenceNow per render cycle so this memoized row doesn't churn on the 2.5s live poll.
  referenceNow: number;
}) {
  const stale = isStale(r.startTime, referenceNow);
  return (
    <li>
      <button
        type="button"
        className={`rail-row rail-run${active ? ' is-active' : ''}${stale ? ' is-stale' : ''}`}
        onClick={() => onSelect(r)}
        aria-pressed={active}
        title={`${r.workflowName} · ${r.status}`}
      >
        <span className="rail-run-line">
          <span className={`rail-status status-${r.status}${r.partialFailure ? ' is-partial' : ''}`} aria-hidden="true">
            {statusGlyph(r.status, r.partialFailure)}
          </span>
          {showWorkflowName ? (
            <span className="rail-row-title rail-run-wf">{r.workflowName || '(other)'}</span>
          ) : null}
          <span className="rail-run-meta rail-run-meta-inline">
            <span className="rail-run-agents">
              {r.agentCount} {r.agentCount === 1 ? 'agent' : 'agents'}
            </span>
            <span className="rail-run-dot" aria-hidden="true">·</span>
            <span className="rail-run-dur">{formatDuration(r.durationMs)}</span>
            <span className="rail-run-time">{formatRelativeTime(r.startTime)}</span>
          </span>
        </span>
      </button>
    </li>
  );
});

/** Project header + an inline switcher (collapsed to the current project; expands only
 *  when there's a choice). Keeps the project context at the top so the tree reads as
 *  "OF this project". */
const ProjectSwitcher = memo(function ProjectSwitcher({
  projects,
  selectedProjectPath,
  onSelectProject,
  loading,
}: {
  projects: ProjectRef[];
  selectedProjectPath: string | undefined;
  onSelectProject: (p: ProjectRef) => void;
  loading: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = projects.find((p) => p.projectPath === selectedProjectPath) ?? projects[0];
  if (loading) return <div className="rail-muted">loading projects…</div>;
  if (projects.length === 0) return <div className="rail-muted">no projects in ~/.claude</div>;
  return (
    <div className="rail-project">
      <button
        type="button"
        className="rail-project-current"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        disabled={projects.length === 1}
        title={current?.projectPath}
      >
        <span className="rail-project-label">project</span>
        <span className="rail-project-name">{current?.name ?? '—'}</span>
        {projects.length > 1 ? (
          <span className="rail-project-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
        ) : null}
      </button>
      {open && projects.length > 1 ? (
        <ul className="rail-list rail-project-list">
          {projects.map((p) => {
            const active = p.projectPath === current?.projectPath;
            return (
              <li key={p.projectPath}>
                <button
                  type="button"
                  className={`rail-row${active ? ' is-active' : ''}`}
                  onClick={() => {
                    onSelectProject(p);
                    setOpen(false);
                  }}
                  aria-pressed={active}
                  title={p.projectPath}
                >
                  <span className="rail-row-title">{p.name}</span>
                  <span className="rail-row-path">{p.projectPath}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
});
