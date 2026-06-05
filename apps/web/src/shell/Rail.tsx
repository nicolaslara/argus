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

import { memo, useMemo, useState } from 'react';
import type { ProjectRef, RunSummary, WorkflowMeta } from '@argus/contract';
import { formatDuration, formatRelativeTime, statusGlyph } from './format.ts';

// 'explorer' is the tree; 'settings' the stub. ('projects'/'runs' accepted for back-compat.)
export type RailSection = 'explorer' | 'settings' | 'projects' | 'runs';

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
}

/** Newest-first by startTime; runs without a startTime sort last (stable). */
function runsNewestFirst(runs: RunSummary[]): RunSummary[] {
  return [...runs].sort((a, b) => (b.startTime ?? -Infinity) - (a.startTime ?? -Infinity));
}

/** A workflow node = a declared workflow (or an orphan bucket) + its finished runs. */
interface TreeNode {
  key: string;
  name: string; // display label
  workflow: WorkflowMeta | null; // null = the orphan bucket
  runs: RunSummary[]; // finished runs, newest-first
  orderKey: number; // max(startTime) of its runs — immutable, for a frozen sort
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
  } = props;

  // --- split + group (memoized; order keyed on immutable startTime so the 2.5s live poll
  //     never reshuffles the tree) -------------------------------------------------------
  const liveRuns = useMemo(() => runsNewestFirst(runs.filter((r) => r.status === 'running')), [runs]);
  const tree = useMemo<TreeNode[]>(() => {
    const finished = runs.filter((r) => r.status !== 'running');
    const wfNames = new Set(workflows.map((w) => w.name));
    const byName = new Map<string, RunSummary[]>();
    for (const r of finished) {
      const list = byName.get(r.workflowName);
      if (list) list.push(r);
      else byName.set(r.workflowName, [r]);
    }
    const maxStart = (rs: RunSummary[]) => rs.reduce((m, r) => Math.max(m, r.startTime ?? 0), 0);
    // one node per declared workflow (even with 0 runs) + an orphan bucket for unjoinable runs.
    const nodes: TreeNode[] = workflows.map((w) => {
      const rs = runsNewestFirst(byName.get(w.name) ?? []);
      return { key: `wf:${w.file}`, name: w.name, workflow: w, runs: rs, orderKey: maxStart(rs) };
    });
    const orphans = finished.filter((r) => !wfNames.has(r.workflowName));
    if (orphans.length > 0) {
      nodes.push({ key: 'orphans', name: '(other runs)', workflow: null, runs: runsNewestFirst(orphans), orderKey: maxStart(orphans) });
    }
    // workflows WITH runs first (most-recent on top); empty declared workflows after; orphans last.
    nodes.sort((a, b) => {
      if (a.key === 'orphans') return 1;
      if (b.key === 'orphans') return -1;
      const ar = a.runs.length > 0 ? 1 : 0;
      const br = b.runs.length > 0 ? 1 : 0;
      if (ar !== br) return br - ar;
      return b.orderKey - a.orderKey || a.name.localeCompare(b.name);
    });
    return nodes;
  }, [runs, workflows]);

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
            <div className="rail-muted rail-settings-stub">
              <p>argus · local-first, read-only</p>
              <p>Dark theme · v1</p>
              <p className="rail-settings-note">settings are a stub for now</p>
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

            {anyLive ? <LiveGroup runs={liveRuns} selectedRunId={selectedRunId} onSelectRun={onSelectRun} /> : null}

            <div className="rail-tree" role="tree">
              {runsLoading && tree.length === 0 ? (
                <div className="rail-muted">loading…</div>
              ) : tree.length === 0 ? (
                <div className="rail-muted">no workflows or runs for this project</div>
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

/** The pinned-top LIVE region: a group header (the ONE pulse) + static child rows. */
const LiveGroup = memo(function LiveGroup({
  runs,
  selectedRunId,
  onSelectRun,
}: {
  runs: RunSummary[];
  selectedRunId: string | undefined;
  onSelectRun: (r: RunSummary) => void;
}) {
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
}: {
  node: TreeNode;
  open: boolean;
  onToggle: () => void;
  selectedRunId: string | undefined;
  isSelectedWorkflow: boolean;
  onSelectWorkflow: (w: WorkflowMeta) => void;
  onSelectRun: (r: RunSummary) => void;
}) {
  const hasChildren = node.runs.length > 0;
  const isOrphan = node.workflow === null;
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
          disabled={isOrphan}
        >
          <span className="rail-tree-kind" aria-hidden="true">{isOrphan ? '◷' : '◇'}</span>
          <span className="rail-tree-name">{node.name}</span>
          <span className="rail-tree-count">{node.runs.length || '—'}</span>
        </button>
      </div>
      {open && hasChildren ? (
        <ul className="rail-list rail-indent">
          {node.runs.map((r) => (
            <RunRow key={`${r.ref.sessionId}/${r.ref.runId}`} run={r} active={r.ref.runId === selectedRunId} onSelect={onSelectRun} />
          ))}
        </ul>
      ) : null}
    </div>
  );
});

/** A finished run row (no workflow name — it's nested under its workflow). */
const RunRow = memo(function RunRow({
  run: r,
  active,
  onSelect,
}: {
  run: RunSummary;
  active: boolean;
  onSelect: (r: RunSummary) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={`rail-row rail-run${active ? ' is-active' : ''}`}
        onClick={() => onSelect(r)}
        aria-pressed={active}
        title={`${r.workflowName} · ${r.status}`}
      >
        <span className="rail-run-line">
          <span className={`rail-status status-${r.status}${r.partialFailure ? ' is-partial' : ''}`} aria-hidden="true">
            {statusGlyph(r.status, r.partialFailure)}
          </span>
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
