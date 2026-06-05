// @argus/web — the GENERATIVE sub-UI renderer (#9). Renders a Claude-generated PanelSpec
// (a constrained section grammar) with TRUSTED React components. Every leaf is a text node
// (no dangerouslySetInnerHTML): the LLM chose the structure, never executable markup, so
// there is no injection surface. Lazily generated on demand (it spends a `claude -p` call).

import { memo } from 'react';
import type { PanelSection, PanelSpec, CalloutTone } from '@argus/contract';

const TONE_CLASS: Record<CalloutTone, string> = {
  info: 'subui-callout-info',
  success: 'subui-callout-success',
  warn: 'subui-callout-warn',
  danger: 'subui-callout-danger',
};

function Section({ section }: { section: PanelSection }) {
  switch (section.kind) {
    case 'callout':
      return <div className={`subui-callout ${TONE_CLASS[section.tone]}`}>{section.text}</div>;
    case 'text':
      return <div className="subui-text">{section.text}</div>;
    case 'metrics':
      return (
        <div className="subui-metrics">
          {section.items.map((m, i) => (
            <div key={i} className="subui-metric">
              <span className="subui-metric-value">{m.value}</span>
              <span className="subui-metric-label">{m.label}</span>
            </div>
          ))}
        </div>
      );
    case 'keyvalue':
      return (
        <div className="subui-kv">
          {section.items.map((kv, i) => (
            <div key={i} className="subui-kv-row">
              <span className="subui-kv-key">{kv.key}</span>
              <span className="subui-kv-val">{kv.value}</span>
            </div>
          ))}
        </div>
      );
    case 'list': {
      const items = section.items.map((it, i) => <li key={i}>{it}</li>);
      return section.ordered ? (
        <ol className="subui-list">{items}</ol>
      ) : (
        <ul className="subui-list">{items}</ul>
      );
    }
    case 'table':
      return (
        <div className="subui-table-wrap">
          <table className="subui-table">
            <thead>
              <tr>
                {section.columns.map((c, i) => (
                  <th key={i}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {section.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td key={ci}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return null;
  }
}

export const GenerativePanel = memo(function GenerativePanel({ spec }: { spec: PanelSpec }) {
  return (
    <div className="subui">
      <div className="subui-title">{spec.title}</div>
      {spec.sections.map((section, i) => (
        <Section key={i} section={section} />
      ))}
    </div>
  );
});
