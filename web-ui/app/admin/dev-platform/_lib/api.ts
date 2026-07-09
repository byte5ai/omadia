'use client';

/**
 * Epic #470 W0 — browser API client for the dev-platform admin surface.
 *
 * The middleware mounts the router at `/api/v1/admin/dev-platform` (spec §9);
 * from the browser that is reached through the Next rewrite prefix `/bot-api`
 * (see `next.config.ts`), same-origin, cookie-authenticated. This module is a
 * thin, page-local wrapper — it deliberately does not extend `app/_lib/api.ts`
 * so the dev-platform surface stays self-contained under its own route folder.
 *
 * The view types mirror `DevRepoView` / `DevJobView` from
 * `middleware/src/routes/devPlatformShared.ts` (browser-safe: a credential
 * STATUS, never the token; usage under `input`/`output`, never a raw hash).
 */

import { ApiError } from '@/app/_lib/api';

const BASE = '/bot-api/v1/admin/dev-platform';

export const DEV_JOB_EVENTS_PATH = (jobId: string): string =>
  `${BASE}/jobs/${encodeURIComponent(jobId)}/events`;

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
    credentials: 'include',
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!res.ok) {
    throw new ApiError(res.status, `${init?.method ?? 'GET'} ${path} failed: ${res.status}`, text);
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined as T;
  }
}

/** Extract the `{ code, message }` error code the router emits, if present. */
export function devPlatformErrorCode(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  try {
    const b = JSON.parse(err.body) as { code?: string };
    return typeof b.code === 'string' ? b.code : null;
  } catch {
    return null;
  }
}

// ── Shared enums (mirrors of the backend unions) ─────────────────────────────

export type DevJobStatus =
  | 'queued'
  | 'provisioning'
  | 'running'
  | 'waiting'
  | 'applying'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'stalled'
  | 'budget_exceeded';

export type DevJobKind = 'analyze' | 'fix_issue' | 'implement';
export type DevRepoCredentialKind = 'github_app' | 'device_flow' | 'pat' | 'deploy_key';
export type RunnerBackendKind = 'local' | 'docker' | 'fly';

export const TERMINAL_DEV_JOB_STATUSES: readonly DevJobStatus[] = [
  'done',
  'failed',
  'cancelled',
  'stalled',
  'budget_exceeded',
];

export function isTerminalStatus(status: DevJobStatus): boolean {
  return TERMINAL_DEV_JOB_STATUSES.includes(status);
}

// ── Views ────────────────────────────────────────────────────────────────────

export interface DevRepoView {
  id: string;
  forgeKind: string;
  owner: string;
  name: string;
  cloneUrl: string;
  defaultBranch: string;
  trackerKind: string | null;
  trackerConfig: Record<string, unknown>;
  allowedTriggers: string[];
  allowedLaunchers: string[];
  egressAllowlist: string[];
  runsTests: boolean;
  branchProtectionOk: boolean | null;
  branchProtectionCheckedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  credential: { kind: DevRepoCredentialKind; login: string | null; isSet: boolean };
}

export interface DevJobView {
  id: string;
  repoId: string;
  kind: DevJobKind;
  brief: string;
  source: string;
  sourceRef: string | null;
  baseSha: string | null;
  backend: RunnerBackendKind;
  agentKind: string;
  authMode: string;
  provision: number;
  phase: string;
  status: DevJobStatus;
  branch: string | null;
  prUrl: string | null;
  result: { outcome: string; summary?: string; diffArtifactId?: string; error?: string } | null;
  error: string | null;
  usage: { input: number; output: number; costUsd: number; estimated: boolean };
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  updatedAt: string;
}

export interface DevIssueSummary {
  number: number;
  title: string;
  labels: string[];
  htmlUrl: string;
  authorLogin: string | null;
}

export interface DevRepoCheckResult {
  access: boolean;
  branchProtection: boolean | null;
}

export interface DeviceFlowStart {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export type DeviceFlowPollStatus =
  | 'authorized'
  | 'pending'
  | 'expired'
  | 'denied'
  | 'error';

export interface DeviceFlowPoll {
  status: DeviceFlowPollStatus;
  login?: string | null;
  interval?: number;
}

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface CreateRepoInput {
  owner: string;
  name: string;
  credential:
    | { kind: 'device_flow' }
    | { kind: 'pat'; token: string };
  trackerKind?: string;
  runsTests?: boolean;
  allowedLaunchers?: string[];
}

export interface CreateJobInput {
  repoId: string;
  kind: DevJobKind;
  backend: RunnerBackendKind;
  issueNumber?: number;
  brief?: string;
  model?: string;
}

export interface ListJobsFilter {
  repoId?: string;
  status?: DevJobStatus;
  limit?: number;
}

// ── Repo endpoints ───────────────────────────────────────────────────────────

export function listRepos(): Promise<{ repos: DevRepoView[] }> {
  return req('/repos');
}

export function getRepo(id: string): Promise<DevRepoView> {
  return req(`/repos/${encodeURIComponent(id)}`);
}

export function createRepo(body: CreateRepoInput): Promise<DevRepoView> {
  return req('/repos', { method: 'POST', body: JSON.stringify(body) });
}

export function patchRepo(
  id: string,
  patch: Partial<Pick<DevRepoView, 'runsTests' | 'defaultBranch' | 'trackerKind' | 'allowedLaunchers'>>,
): Promise<DevRepoView> {
  return req(`/repos/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export function deleteRepo(id: string): Promise<void> {
  return req(`/repos/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function checkRepo(id: string): Promise<DevRepoCheckResult> {
  return req(`/repos/${encodeURIComponent(id)}/check`, { method: 'POST', body: JSON.stringify({}) });
}

export function listRepoIssues(id: string, limit = 30): Promise<{ issues: DevIssueSummary[] }> {
  return req(`/repos/${encodeURIComponent(id)}/issues?limit=${String(limit)}`);
}

export function deviceConnectStart(): Promise<DeviceFlowStart> {
  return req('/github/connect/start', { method: 'POST', body: JSON.stringify({}) });
}

export function deviceConnectPoll(): Promise<DeviceFlowPoll> {
  return req('/github/connect/poll', { method: 'POST', body: JSON.stringify({}) });
}

// ── Job endpoints ────────────────────────────────────────────────────────────

export function listJobs(filter: ListJobsFilter = {}): Promise<{ jobs: DevJobView[] }> {
  const q = new URLSearchParams();
  if (filter.repoId) q.set('repoId', filter.repoId);
  if (filter.status) q.set('status', filter.status);
  if (filter.limit !== undefined) q.set('limit', String(filter.limit));
  const qs = q.toString();
  return req(`/jobs${qs ? `?${qs}` : ''}`);
}

export function getJob(id: string): Promise<DevJobView> {
  return req(`/jobs/${encodeURIComponent(id)}`);
}

export function createJob(body: CreateJobInput): Promise<DevJobView> {
  return req('/jobs', { method: 'POST', body: JSON.stringify(body) });
}

export function cancelJob(id: string): Promise<{ ok: boolean; status: string }> {
  return req(`/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: JSON.stringify({}) });
}

export function retryJob(id: string): Promise<{ ok: boolean; jobId: string }> {
  return req(`/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST', body: JSON.stringify({}) });
}
