// @argus/web — typed fetch client for the local server's read API.
//
// The web app talks ONLY to its own origin (the Vite dev proxy / the production
// same-origin server) and consumes ONLY @argus/contract wire types. It NEVER
// imports the adapter or any node:* module (boundaries.md §1). The bearer token is
// injected server-side by the Vite proxy, so there is no token handling here and
// the browser stays token-free.

import type { ProjectRef, RunModel, RunRef, RunSummary } from '@argus/contract';

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

export function fetchRunModel(ref: Pick<RunRef, 'slug' | 'sessionId' | 'runId'>): Promise<RunModel> {
  const { slug, sessionId, runId } = ref;
  return getJson<RunModel>(
    `/api/runs/${encodeURIComponent(slug)}/${encodeURIComponent(sessionId)}/${encodeURIComponent(runId)}`,
  );
}

export { ApiError };
