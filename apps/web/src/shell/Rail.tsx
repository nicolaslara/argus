// @argus/web — the collapsible left icon-rail (M4 shell).
//
// Collapsed by default → a thin icon strip (~52px) so the canvas keeps >90% of the
// viewport. Expanding reveals a panel with three sections: Project switcher, Run
// picker, and a Settings stub. Selection is LIFTED into App state (this component is
// controlled): the rail never fetches a run model or mutates the canvas itself — it
// only reports the user's project/run choice up via callbacks, so the Plan⟷Execution
// toggle keeps the same project context.
//
// All labels/values are rendered as React text nodes (no dangerouslySetInnerHTML).
// The rail consumes ONLY @argus/contract wire types; no node:* / adapter import.

import { memo } from 'react';
import type { ProjectRef, RunSummary, WorkflowMeta } from '@argus/contract';
import { formatDuration, formatRelativeTime, statusGlyph } from './format.ts';

export type RailSection = 'projects' | 'runs' | 'settings';

interface RailProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Which section panel is open when expanded. */
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

  /** Plan-view workflow context, surfaced in the rail so it is reachable in both views. */
  workflows: WorkflowMeta[];
  selectedWorkflowName: string | undefined;
  onSelectWorkflow: (w: WorkflowMeta) => void;
}

/** Newest-first by startTime; runs without a startTime sort last (stable). */
function runsNewestFirst(runs: RunSummary[]): RunSummary[] {
  return [...runs].sort((a, b) => {
    const at = a.startTime ?? -Infinity;
    const bt = b.startTime ?? -Infinity;
    return bt - at;
  });
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

  const sortedRuns = runsNewestFirst(runs);

  // When collapsed the rail is a pure icon strip; expanding opens a section and the
  // user can switch sections via the icon buttons.
  function openSection(s: RailSection) {
    onSelectSection(s);
    if (collapsed) onToggleCollapsed();
  }

  return (
    <aside className={`rail${collapsed ? ' is-collapsed' : ''}`} aria-label="navigation">
      {/* The always-visible icon strip. */}
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
            className={`rail-icon${!collapsed && section === 'projects' ? ' is-active' : ''}`}
            onClick={() => openSection('projects')}
            aria-label="projects"
            aria-pressed={!collapsed && section === 'projects'}
            title="Projects"
          >
            <span className="rail-glyph">▤</span>
          </button>
          <button
            type="button"
            className={`rail-icon${!collapsed && section === 'runs' ? ' is-active' : ''}`}
            onClick={() => openSection('runs')}
            aria-label="runs"
            aria-pressed={!collapsed && section === 'runs'}
            title="Runs"
          >
            <span className="rail-glyph">≣</span>
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

      {/* The expanded panel — only mounted (and only takes width) when expanded. */}
      {collapsed ? null : (
        <div className="rail-panel">
          {section === 'projects' ? (
            <section className="rail-section" aria-label="project switcher">
              <header className="rail-section-head">Projects</header>
              {projectsLoading ? (
                <div className="rail-muted">loading…</div>
              ) : projects.length === 0 ? (
                <div className="rail-muted">no projects in ~/.claude</div>
              ) : (
                <ul className="rail-list">
                  {projects.map((p) => {
                    const active = p.projectPath === selectedProjectPath;
                    return (
                      <li key={p.projectPath}>
                        <button
                          type="button"
                          className={`rail-row${active ? ' is-active' : ''}`}
                          onClick={() => onSelectProject(p)}
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
              )}
            </section>
          ) : null}

          {section === 'runs' ? (
            <section className="rail-section" aria-label="run picker">
              <header className="rail-section-head">Runs</header>
              {runsLoading ? (
                <div className="rail-muted">loading…</div>
              ) : sortedRuns.length === 0 ? (
                <div className="rail-muted">no runs for this project</div>
              ) : (
                <ul className="rail-list">
                  {sortedRuns.map((r) => {
                    const active = r.ref.runId === selectedRunId;
                    return (
                      <li key={`${r.ref.sessionId}/${r.ref.runId}`}>
                        <button
                          type="button"
                          className={`rail-row rail-run${active ? ' is-active' : ''}`}
                          onClick={() => onSelectRun(r)}
                          aria-pressed={active}
                          title={r.workflowName}
                        >
                          <span className="rail-run-line">
                            <span
                              className={`rail-status status-${r.status}${r.partialFailure ? ' is-partial' : ''}`}
                              aria-hidden="true"
                            >
                              {statusGlyph(r.status, r.partialFailure)}
                            </span>
                            <span className="rail-row-title">{r.workflowName}</span>
                          </span>
                          <span className="rail-run-meta">
                            <span className="rail-run-agents">
                              {r.agentCount} {r.agentCount === 1 ? 'agent' : 'agents'}
                            </span>
                            <span className="rail-run-dot" aria-hidden="true">
                              ·
                            </span>
                            <span className="rail-run-dur">{formatDuration(r.durationMs)}</span>
                            <span className="rail-run-time">{formatRelativeTime(r.startTime)}</span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          ) : null}

          {section === 'settings' ? (
            <section className="rail-section" aria-label="settings">
              <header className="rail-section-head">Settings</header>
              {/* M4 stub — no behavior yet (the icon + panel reserve the slot). */}
              <div className="rail-muted rail-settings-stub">
                <p>argus · local-first, read-only</p>
                <p>Dark theme · v1</p>
                <p className="rail-settings-note">settings are a stub for now</p>
              </div>
              {/* The Plan-view workflow context is surfaced here too so it stays
                  reachable from the rail regardless of the active view. */}
              {workflows.length > 0 ? (
                <div className="rail-wf-block">
                  <div className="rail-subhead">Plan workflow</div>
                  <ul className="rail-list">
                    {workflows.map((w) => {
                      const active = w.name === selectedWorkflowName;
                      return (
                        <li key={w.file}>
                          <button
                            type="button"
                            className={`rail-row${active ? ' is-active' : ''}`}
                            onClick={() => onSelectWorkflow(w)}
                            aria-pressed={active}
                            title={w.description || w.name}
                          >
                            <span className="rail-row-title">{w.name}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      )}
    </aside>
  );
});
