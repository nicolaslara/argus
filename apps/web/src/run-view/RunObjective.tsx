import { useState } from 'react';
import { formatArgs } from '../failure-info.ts';

/** The Run-view OBJECTIVE band: the workflow's purpose + a readable "called on <args>" line
 * (with a raw-JSON toggle). Surfaced as text in the MAIN view (not the sidebar). Renders
 * nothing when there is neither an objective nor args.
 *
 * Extracted from App.tsx (behavior-preserving, props-in/JSX-out). */
export function RunObjective({ objective, args }: { objective: string | null; args: unknown }) {
  const [raw, setRaw] = useState(false);
  const argsText = formatArgs(args);
  const hasStructuredArgs = args != null && typeof args === 'object';
  if (!objective && !argsText) return null;
  return (
    <div className="run-objective">
      {objective ? <div className="run-objective-purpose">{objective}</div> : null}
      {argsText ? (
        <div className="run-objective-args">
          <span className="run-objective-k">called on</span>
          {raw && hasStructuredArgs ? (
            <pre className="run-objective-raw">{JSON.stringify(args, null, 2)}</pre>
          ) : (
            <span className="run-objective-v">{argsText}</span>
          )}
          {hasStructuredArgs ? (
            <button type="button" className="run-objective-toggle" onClick={() => setRaw((r) => !r)}>
              {raw ? 'readable' : '{ } raw'}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
