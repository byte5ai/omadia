import { adminJson, arrayField } from './adminJson';

/**
 * #2320 — typed client for the sandbox admin surface (#576, ADR-0055):
 * `GET /v1/admin/sandboxes`, `POST /reap` (dry run or sweep) and
 * `POST /teardown`. Persistent sandboxes are never reaped by idle time; the
 * server applies that rule, the UI only shows it.
 */

export interface SandboxDto {
  readonly scope_key: string;
  readonly backend: string;
  readonly sandbox_ref: string;
  readonly persistent: boolean;
  readonly egress: boolean;
  readonly created_at: string;
  readonly last_used_at: string;
}

export interface SandboxReaperBounds {
  readonly default_idle_minutes: number;
  readonly min_idle_minutes: number;
  readonly max_idle_minutes: number;
}

export interface SandboxListResponse {
  readonly sandboxes: SandboxDto[];
  readonly reaper: SandboxReaperBounds;
}

export type SandboxReapResponse =
  | { readonly dry_run: true; readonly candidates: readonly string[] }
  | { readonly dry_run: false; readonly reaped: readonly string[]; readonly failed: readonly string[] };

const SANDBOXES = '/v1/admin/sandboxes';

export async function listSandboxes(): Promise<SandboxListResponse> {
  const body = await adminJson<SandboxListResponse>(SANDBOXES);
  return { ...body, sandboxes: arrayField<SandboxDto>(body, 'sandboxes', SANDBOXES) };
}

export async function reapSandboxes(idleMinutes: number, dryRun: boolean): Promise<SandboxReapResponse> {
  return adminJson<SandboxReapResponse>(`${SANDBOXES}/reap`, { method: 'POST', body: { idleMinutes, dryRun } });
}

export async function teardownSandbox(scopeKey: string): Promise<void> {
  await adminJson(`${SANDBOXES}/teardown`, { method: 'POST', body: { scopeKey } });
}
