import { ApiError, rscTimeoutSignal } from './api';

/**
 * #2082 — typed client for the operator view of agent-owned triggers
 * (`/api/v1/operator/triggers`, spec 2042 §5.12 "Visible"). Same
 * dual-environment shape as `privacyReports.ts`: browser via `/bot-api`,
 * server via MIDDLEWARE_URL + forwarded cookies.
 */

function botApi(path: string): string {
  if (typeof window !== 'undefined') return `/bot-api${path}`;
  const base = process.env['MIDDLEWARE_URL'] ?? 'http://localhost:3979';
  return `${base}/api${path}`;
}

async function forwardCookieHeader(): Promise<Record<string, string>> {
  if (typeof window !== 'undefined') return {};
  try {
    const mod = await import('next/headers');
    const jar = await mod.cookies();
    const cookieHeader = jar
      .getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
    return cookieHeader ? { cookie: cookieHeader } : {};
  } catch {
    return {};
  }
}

export type TriggerOrigin = 'agent' | 'routine' | 'system';

export interface TriggerDto {
  id: string;
  agent: string;
  kind: 'on_event' | 'wake_at' | 'wake_every';
  origin: TriggerOrigin;
  purpose: string;
  state: 'active' | 'paused';
  pausedBecause?: string;
  context: string;
  contextId: string;
  until: string;
  event?: string;
  at?: string;
  everySeconds?: number;
  cron?: string;
  timezone?: string;
  runs: number;
  maxRuns?: number;
  actions: string[];
  spentUsd: number;
  budgetUsd: number;
  lastOutcome?: string;
  lastFiredAt: string | null;
  lastError: string | null;
  createdBy: string;
  createdAt: string;
}

export interface SpendDto {
  spentUsd: number;
  reservedUsd: number;
}

export interface PluginJobDto {
  agentId: string;
  name: string;
  running: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  nextProbeAt: string | null;
}

export interface BatchJobDto {
  id: string;
  purpose: string;
  intervalMinutes: number;
}

export interface TriggerOverviewDto {
  month: string;
  instance: SpendDto;
  caps: {
    monthlyInstanceUsd: number;
    monthlyAgentUsd: number;
    perTriggerUsd: number;
    perFiringUsd: number;
    maxActivePerAgent: number;
  };
  agents: Record<string, SpendDto>;
  triggers: TriggerDto[];
  jobs: PluginJobDto[];
  batchJobs: BatchJobDto[];
}

const BASE = '/v1/operator/triggers';

export async function getTriggerOverview(): Promise<TriggerOverviewDto> {
  const res = await fetch(botApi(BASE), {
    headers: { ...(await forwardCookieHeader()) },
    signal: rscTimeoutSignal(),
    cache: 'no-store',
  });
  if (!res.ok) throw new ApiError(res.status, `triggers list failed: ${String(res.status)}`);
  const body = (await res.json()) as TriggerOverviewDto;
  return { ...body, jobs: body.jobs ?? [], batchJobs: body.batchJobs ?? [] };
}

async function act(path: string, method: 'POST' | 'DELETE'): Promise<void> {
  const res = await fetch(botApi(path), { method, headers: { ...(await forwardCookieHeader()) } });
  if (!res.ok) throw new ApiError(res.status, `trigger ${method} ${path} failed: ${String(res.status)}`);
}

export const pauseTrigger = (id: string): Promise<void> => act(`${BASE}/${encodeURIComponent(id)}/pause`, 'POST');
export const resumeTrigger = (id: string): Promise<void> => act(`${BASE}/${encodeURIComponent(id)}/resume`, 'POST');
export const endTrigger = (id: string): Promise<void> => act(`${BASE}/${encodeURIComponent(id)}`, 'DELETE');
