import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import type { Express } from 'express';

import {
  createDevPlatformRouter,
  assertAuthModeAdmissible,
  assertLocalBackendAdmissible,
  type DevPlatformRouterDeps,
} from '../../src/routes/devPlatform.js';
import { DevJobEventBus } from '../../src/devplatform/devJobEventBus.js';
import type { Ticket } from '../../src/devplatform/githubIssuesTracker.js';
import type { FinalizeContext } from '../../src/devplatform/finalizeDevJob.js';
import type {
  DevJob,
  DevJobEvent,
  DevJobStatus,
  DevRepo,
  NewDevJob,
  NewDevRepo,
} from '../../src/devplatform/types.js';

/**
 * Epic #470 W0 — admin REST + SSE router (`/api/v1/admin/dev-platform`).
 * Verifies the session gate (401), launch authorization (403), repo onboarding
 * (forge probe + branch-protection), brief composition, the local-backend and
 * subscription admission guards, the credential-leak invariant, and the single
 * job-event SSE tail (headers, Last-Event-ID replay, live delivery, provision
 * boundary, `id:` = events table id). Injected fakes, no DB.
 */

export const PAT_TOKEN = 'PAT-SECRET-DO-NOT-LEAK';
export const DEVICE_TOKEN = 'DEVICE-SECRET-DO-NOT-LEAK';

// ---------------------------------------------------------------------------
// Fakes.
// ---------------------------------------------------------------------------

export function makeRepo(o: Partial<DevRepo> = {}): DevRepo {
  const iso = new Date().toISOString();
  return {
    id: 'repo-1', forgeKind: 'github', owner: 'o', name: 'r',
    cloneUrl: 'https://github.com/o/r.git', defaultBranch: 'main',
    credentialKind: 'pat', credentialRef: 'repo/repo-1', trackerKind: 'github_issues',
    trackerConfig: {}, allowedTriggers: ['admin'], allowedLaunchers: [], egressAllowlist: [],
    runsTests: false, branchProtectionOk: null, branchProtectionCheckedAt: null,
    createdBy: 'alice', createdAt: iso, updatedAt: iso, ...o,
  };
}

export function makeJob(o: Partial<DevJob> = {}): DevJob {
  const iso = new Date().toISOString();
  return {
    id: 'job-1', repoId: 'repo-1', kind: 'implement', brief: 'do it', source: 'admin',
    sourceRef: null, baseSha: null, backend: 'local', agentKind: 'claude-cli',
    authMode: 'api_key', provision: 1, phase: 'implement', status: 'queued',
    claimedBy: null, claimedAt: null, lastHeartbeatAt: null, runnerHandle: null,
    runnerTokenHash: 'HASH-DO-NOT-LEAK', branch: null, prUrl: null, result: null, error: null,
    tokensIn: 3, tokensOut: 5, costUsd: 0, createdBy: 'alice', createdAt: iso,
    startedAt: null, endedAt: null, updatedAt: iso, ...o,
  };
}

export class FakeRepoStore {
  readonly repos = new Map<string, DevRepo>();
  readonly branchProtectionCalls: Array<{ id: string; ok: boolean | null }> = [];
  private seq = 0;
  add(r: DevRepo): DevRepo { this.repos.set(r.id, r); return r; }
  async createRepo(input: NewDevRepo): Promise<DevRepo> {
    const id = `repo-new-${String(++this.seq)}`;
    const repo = makeRepo({
      id, owner: input.owner, name: input.name, cloneUrl: input.cloneUrl,
      defaultBranch: input.defaultBranch ?? 'main', credentialKind: input.credentialKind,
      credentialRef: input.credentialRef, createdBy: input.createdBy,
      runsTests: input.runsTests ?? true, allowedLaunchers: input.allowedLaunchers ?? [],
      trackerKind: input.trackerKind ?? null,
    });
    this.repos.set(id, repo);
    return repo;
  }
  async listRepos(): Promise<DevRepo[]> { return [...this.repos.values()]; }
  async getRepo(id: string): Promise<DevRepo | null> { return this.repos.get(id) ?? null; }
  async updateRepo(id: string, patch: Partial<NewDevRepo>): Promise<DevRepo | null> {
    const r = this.repos.get(id);
    if (!r) return null;
    const next = { ...r, ...patch } as DevRepo;
    this.repos.set(id, next);
    return next;
  }
  async deleteRepo(id: string): Promise<boolean> { return this.repos.delete(id); }
  async setBranchProtection(id: string, ok: boolean | null): Promise<DevRepo | null> {
    this.branchProtectionCalls.push({ id, ok });
    const r = this.repos.get(id);
    if (!r) return null;
    const next = { ...r, branchProtectionOk: ok };
    this.repos.set(id, next);
    return next;
  }
}

export class FakeJobStore {
  readonly jobs = new Map<string, DevJob>();
  readonly created: Array<NewDevJob & { runnerTokenHash: string }> = [];
  readonly events: DevJobEvent[] = [];
  readonly artifacts = new Map<string, { id: string; jobId: string; kind: string; content: string; meta: Record<string, unknown>; createdAt: string }>();
  private seq = 0;
  add(j: DevJob): DevJob { this.jobs.set(j.id, j); return j; }
  addEvent(e: DevJobEvent): void { this.events.push(e); }
  async createJob(input: NewDevJob & { runnerTokenHash: string }): Promise<DevJob> {
    this.created.push(input);
    const id = `job-new-${String(++this.seq)}`;
    const job = makeJob({
      id, repoId: input.repoId, kind: input.kind, brief: input.brief, source: input.source,
      sourceRef: input.sourceRef ?? null, backend: input.backend, authMode: input.authMode ?? 'api_key',
      createdBy: input.createdBy, runnerTokenHash: input.runnerTokenHash, status: 'queued',
    });
    this.jobs.set(id, job);
    return job;
  }
  async getJob(id: string): Promise<DevJob | null> { return this.jobs.get(id) ?? null; }
  async listJobs(filter: { repoId?: string; status?: DevJobStatus; limit?: number } = {}): Promise<DevJob[]> {
    let out = [...this.jobs.values()];
    if (filter.repoId) out = out.filter((j) => j.repoId === filter.repoId);
    if (filter.status) out = out.filter((j) => j.status === filter.status);
    return out;
  }
  async listEvents(jobId: string, afterId?: number, limit = 500): Promise<DevJobEvent[]> {
    return this.events
      .filter((e) => e.jobId === jobId && (afterId === undefined || e.id > afterId))
      .sort((a, b) => a.id - b.id)
      .slice(0, limit);
  }
  async listArtifacts(jobId: string) {
    return [...this.artifacts.values()].filter((a) => a.jobId === jobId);
  }
  async getArtifact(id: string) { return this.artifacts.get(id) ?? null; }
  addArtifact(a: { id: string; jobId: string; kind: string; content: string }): void {
    this.artifacts.set(a.id, { ...a, meta: {}, createdAt: new Date().toISOString() });
  }
}

export class FakeCredentialStore {
  readonly tokens = new Map<string, string>();
  readonly pending = new Map<string, string>();
  readonly logins = new Map<string, string>();
  readonly cleared: string[] = [];
  async getConnection(repoId: string) {
    const token = this.tokens.get(repoId);
    if (!token) return { connected: false };
    return { connected: true, login: this.logins.get(repoId), kind: 'pat' as const };
  }
  async resolve(repoId: string): Promise<string | undefined> { return this.tokens.get(repoId); }
  async save(repoId: string, input: { token: string; kind: 'device_flow' | 'pat'; login?: string }): Promise<void> {
    this.tokens.set(repoId, input.token);
    if (input.login) this.logins.set(repoId, input.login);
  }
  async clear(repoId: string): Promise<void> { this.cleared.push(repoId); this.tokens.delete(repoId); }
  async stashPending(sub: string, token: string): Promise<void> { this.pending.set(sub, token); }
  async resolvePending(sub: string): Promise<string | undefined> { return this.pending.get(sub); }
  async clearPending(sub: string): Promise<void> { this.pending.delete(sub); }
  async promotePending(sub: string, repoId: string, login?: string): Promise<boolean> {
    const t = this.pending.get(sub);
    if (!t) return false;
    this.tokens.set(repoId, t);
    if (login) this.logins.set(repoId, login);
    this.pending.delete(sub);
    return true;
  }
}

export interface Harness {
  server: Server;
  baseUrl: string;
  repoStore: FakeRepoStore;
  jobStore: FakeJobStore;
  credentials: FakeCredentialStore;
  eventBus: DevJobEventBus;
  finalizeCalls: Array<{ jobId: string; status: DevJobStatus; ctx?: FinalizeContext }>;
  probeCalls: Array<{ owner: string; name: string; token: string }>;
  trackerCalls: number[];
  ticket: Ticket;
  close(): Promise<void>;
}

export async function makeHarness(overrides: Partial<DevPlatformRouterDeps> = {}): Promise<Harness> {
  const repoStore = new FakeRepoStore();
  const jobStore = new FakeJobStore();
  const credentials = new FakeCredentialStore();
  const eventBus = new DevJobEventBus();
  const finalizeCalls: Harness['finalizeCalls'] = [];
  const probeCalls: Harness['probeCalls'] = [];
  const trackerCalls: number[] = [];
  const ticket: Ticket = {
    number: 123, title: 'Login button is broken', body: 'It throws on click.\nPlease fix.',
    labels: ['bug'], htmlUrl: 'https://github.com/o/r/issues/123', authorLogin: 'reporter',
  };

  const deps: DevPlatformRouterDeps = {
    repoStore,
    jobStore,
    credentials,
    eventBus,
    probeRepoAccess: async (input) => {
      probeCalls.push(input);
      return { ok: true, defaultBranch: 'develop', login: 'octocat' };
    },
    makeIssuesTracker: () => ({
      getTicket: async (n: number) => { trackerCalls.push(n); return ticket; },
      listOpenTickets: async () => [ticket],
    }),
    finalizeDevJob: async (jobId, status, ctx) => {
      finalizeCalls.push({ jobId, status, ctx });
      const j = jobStore.jobs.get(jobId);
      if (j) j.status = status;
      return j ?? null;
    },
    applyJob: async () => ({ prUrl: 'https://github.com/o/r/pull/7' }),
    subscriptionModeEnabled: false,
    checkBranchProtection: async () => ({ ok: true, checkedAt: new Date() }),
    heartbeatMs: 0,
    ...overrides,
  };

  const app: Express = express();
  // Test session injector (in prod the router is mounted behind requireAuth):
  // a request carrying `x-sub` is treated as authenticated.
  app.use((req, _res, next) => {
    const sub = req.header('x-sub');
    if (sub) {
      (req as express.Request & { session?: unknown }).session = {
        sub,
        email: req.header('x-email') ?? `${sub}@example.com`,
        display_name: sub,
        provider: 'local',
        role: req.header('x-role') ?? 'admin',
      };
    }
    next();
  });
  app.use('/api/v1/admin/dev-platform', createDevPlatformRouter(deps));

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    server, baseUrl: `http://127.0.0.1:${String(port)}/api/v1/admin/dev-platform`,
    repoStore, jobStore, credentials, eventBus, finalizeCalls, probeCalls, trackerCalls, ticket,
    async close() { await new Promise<void>((r) => server.close(() => r())); },
  };
}

export function authHeaders(sub = 'alice', role = 'admin'): Record<string, string> {
  return { 'x-sub': sub, 'x-role': role };
}

export async function postJson(url: string, headers: Record<string, string>, body: unknown) {
  return fetch(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

/** Assert that `fn` throws a DevPlatformError carrying the given code. */
export function throwsCode(fn: () => void, code: string): void {
  assert.throws(fn, (err: unknown) => (err as { code?: string }).code === code, `expected code ${code}`);
}

/** Recursively flag any leaked secret: a key that names a secret, or a raw
 *  credential string under a `credential` key. A `credential` STATUS object is
 *  benign and intentionally allowed. */
export function hasLeakedSecret(v: unknown): boolean {
  const re = /token|secret|password/i;
  if (Array.isArray(v)) return v.some(hasLeakedSecret);
  if (v && typeof v === 'object') {
    return Object.entries(v).some(([k, val]) => {
      if (re.test(k)) return true;
      if (k === 'credential' && typeof val === 'string') return true;
      return hasLeakedSecret(val);
    });
  }
  return false;
}

// ---------------------------------------------------------------------------
