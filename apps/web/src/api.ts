// @argus/web — typed fetch client for the local server's read API.
//
// The web app talks ONLY to its own origin (the Vite dev proxy / the production
// same-origin server) and consumes ONLY @argus/contract wire types. It NEVER
// imports the adapter or any node:* module (boundaries.md §1). The bearer token is
// injected server-side by the Vite proxy, so there is no token handling here and
// the browser stays token-free.

import type {
  AgentActivity,
  AgentFailureCause,
  ExplanationBatch,
  PlanModel,
  ProjectRef,
  RunModel,
  RunRef,
  RunSummary,
  SubUiResponse,
  WorkflowMeta,
} from '@argus/contract';

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    headers: { accept: 'application/json' },
    // Same-origin; no credentials needed (token is proxy-injected server-side).
    credentials: 'omit',
  });
  if (!res.ok) {
    throw new ApiError(res.status, `GET ${path} -> ${res.status}`);
  }
  return (await res.json()) as T;
}

export function fetchProjects(): Promise<ProjectRef[]> {
  return getJson<ProjectRef[]>('/api/projects');
}

export function fetchProjectRuns(slug: string): Promise<RunSummary[]> {
  return getJson<RunSummary[]>(`/api/projects/${encodeURIComponent(slug)}/runs`);
}

/** P0: the run-free declared-workflow listing for a project (the "review-the-workflow" view). */
export function fetchProjectWorkflows(slug: string): Promise<WorkflowMeta[]> {
  return getJson<WorkflowMeta[]>(`/api/projects/${encodeURIComponent(slug)}/workflows`);
}

/**
 * P1: the run-free static plan DAG for one workflow (the richer "review-the-workflow"
 * view). `file` is the `.js` basename. Returns the adapter's PlanModel (phases/agents/
 * fan-out/merge/decisions/loops/multiplicity) — derived statically, never from a run.
 */
export function fetchProjectPlan(slug: string, file: string): Promise<PlanModel> {
  return getJson<PlanModel>(
    `/api/projects/${encodeURIComponent(slug)}/workflows/${encodeURIComponent(file)}/plan`,
  );
}

export function fetchRunModel(ref: Pick<RunRef, 'slug' | 'sessionId' | 'runId'>): Promise<RunModel> {
  const { slug, sessionId, runId } = ref;
  return getJson<RunModel>(
    `/api/runs/${encodeURIComponent(slug)}/${encodeURIComponent(sessionId)}/${encodeURIComponent(runId)}`,
  );
}

/**
 * L2 (live): the PARTIAL live snapshot of an IN-PROGRESS run, built from its
 * `journal.jsonl` (no finalized `wf_<id>.json` yet). Returns a RunModel with
 * `incomplete:true` / `status:'running'`; labels/phases are recovered from the persisted
 * script when statically resolvable, else agents are anonymous. The caller polls this
 * while the run is `running`, then switches to {@link fetchRunModel} once it finalizes.
 */
export function fetchRunLive(ref: Pick<RunRef, 'slug' | 'sessionId' | 'runId'>): Promise<RunModel> {
  const { slug, sessionId, runId } = ref;
  return getJson<RunModel>(
    `/api/runs/${encodeURIComponent(slug)}/${encodeURIComponent(sessionId)}/${encodeURIComponent(runId)}/live`,
  );
}

/** R1: the lazy FULL result of one agent (string for a text agent, object for a schema agent). */
export interface AgentResult {
  agentId: string;
  value: unknown;
  truncated: boolean;
}
export function fetchAgentResult(
  ref: Pick<RunRef, 'slug' | 'sessionId' | 'runId'>,
  agentId: string,
): Promise<AgentResult> {
  const { slug, sessionId, runId } = ref;
  return getJson<AgentResult>(
    `/api/runs/${encodeURIComponent(slug)}/${encodeURIComponent(sessionId)}/${encodeURIComponent(runId)}/result?agentId=${encodeURIComponent(agentId)}`,
  );
}

/**
 * STEP 4 (failure-and-live-inspector §4/§5): the lazy, transcript-fed per-agent ACTIVITY
 * summary — label, tool counts, token totals, duration, a capped tool/text timeline, and
 * the last activity / final error line. Parsed by the adapter from `agent-<id>.jsonl`; this
 * is the ONLY source of tokens/tools/timing for a LIVE agent (the journal is starved). Lazy:
 * fetched only for the selected / visible agent, never bundled into the run list. The server
 * 404s when the transcript is absent (cleaned/old run) → the caller degrades to the journal.
 */
export function fetchAgentActivity(
  ref: Pick<RunRef, 'slug' | 'sessionId' | 'runId'>,
  agentId: string,
): Promise<AgentActivity> {
  const { slug, sessionId, runId } = ref;
  return getJson<{ activity: AgentActivity }>(
    `/api/runs/${encodeURIComponent(slug)}/${encodeURIComponent(sessionId)}/${encodeURIComponent(runId)}/activity?agentId=${encodeURIComponent(agentId)}`,
  ).then((r) => r.activity);
}

/**
 * The ACCURATE failure cause for a failed run's proximate agent — classified from its transcript
 * tail (infra socket/limit/overload vs a real schema-validation fault). Lazy: fetched only when a
 * run failed. Returns null when no transcript / no known signature (the banner falls back to the
 * run's cleaned error message). Never throws on a missing transcript (the server returns cause:null).
 */
export function fetchFailureCause(
  ref: Pick<RunRef, 'slug' | 'sessionId' | 'runId'>,
  agentId: string,
): Promise<AgentFailureCause | null> {
  const { slug, sessionId, runId } = ref;
  return getJson<{ cause: AgentFailureCause | null }>(
    `/api/runs/${encodeURIComponent(slug)}/${encodeURIComponent(sessionId)}/${encodeURIComponent(runId)}/failure-cause?agentId=${encodeURIComponent(agentId)}`,
  ).then((r) => r.cause);
}

/** I4: a Claude-generated plain-language "what this run did" panel (whole-run digest, lazy). */
export function fetchRunDescribe(ref: Pick<RunRef, 'slug' | 'sessionId' | 'runId'>): Promise<SubUiResponse> {
  const { slug, sessionId, runId } = ref;
  return getJson<SubUiResponse>(
    `/api/runs/${encodeURIComponent(slug)}/${encodeURIComponent(sessionId)}/${encodeURIComponent(runId)}/describe`,
  );
}

/** #9: a Claude-generated, constrained PanelSpec rendering of an agent's result (lazy). */
export function fetchSubUi(
  ref: Pick<RunRef, 'slug' | 'sessionId' | 'runId'>,
  agentId: string,
): Promise<SubUiResponse> {
  const { slug, sessionId, runId } = ref;
  return getJson<SubUiResponse>(
    `/api/runs/${encodeURIComponent(slug)}/${encodeURIComponent(sessionId)}/${encodeURIComponent(runId)}/subui?agentId=${encodeURIComponent(agentId)}`,
  );
}

/**
 * P2: the PER-RUN plan DAG — parsed from the EXACT script a run executed (its persisted
 * `<session>/workflows/scripts/<name>-wf_<id>.js`), NOT the project `.claude/workflows/*.js`
 * (which may have drifted). Returns the adapter's PlanModel. A run with no persisted
 * script 404s — the caller falls back to the project workflow plan.
 */
export function fetchRunPlan(ref: Pick<RunRef, 'slug' | 'sessionId' | 'runId'>): Promise<PlanModel> {
  const { slug, sessionId, runId } = ref;
  return getJson<PlanModel>(
    `/api/runs/${encodeURIComponent(slug)}/${encodeURIComponent(sessionId)}/${encodeURIComponent(runId)}/plan`,
  );
}

/**
 * PX: poll the per-node LLM captions for a plan (the Plan view). Returns baseline
 * captions immediately and llm-enriched ones as the background pool finishes. The
 * caller keeps polling while `batch.pending` is true. Never blocks the plan render.
 */
export function fetchPlanExplanations(slug: string, file: string): Promise<ExplanationBatch> {
  return getJson<ExplanationBatch>(
    `/api/projects/${encodeURIComponent(slug)}/workflows/${encodeURIComponent(file)}/explanations`,
  );
}

/** PX: poll the per-node LLM captions for a run (the Execution view's agent cards). */
export function fetchRunExplanations(
  ref: Pick<RunRef, 'slug' | 'sessionId' | 'runId'>,
): Promise<ExplanationBatch> {
  const { slug, sessionId, runId } = ref;
  return getJson<ExplanationBatch>(
    `/api/runs/${encodeURIComponent(slug)}/${encodeURIComponent(sessionId)}/${encodeURIComponent(runId)}/explanations`,
  );
}

export { ApiError };
