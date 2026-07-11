import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import type { Express } from 'express';

import {
  createDevRunnerRouter,
  type DevRunnerJobStore,
  type DevRunnerRouterDeps,
} from '../../src/routes/devRunnerApi.js';
import type { RunnerEventInput } from '../../src/devplatform/devJobStore.js';
import type { FinalizeContext } from '../../src/devplatform/finalizeDevJob.js';
import {
  RUNNER_PROTOCOL_VERSION,
  isTerminalDevJobStatus,
  type DevJob,
  type DevJobResult,
  type DevJobStatus,
  type DevRepo,
} from '../../src/devplatform/types.js';

/**
 * Shared test harness for the `/api/v1/dev-runner` router: in-memory fakes for
 * the store, the repo lookup, the clone-credential source, and the
 * `finalizeDevJob` choke point, plus an express app on an ephemeral port.
 *
 * Extracted so `devRunnerApi.test.ts` (contract) and
 * `devRunnerApi.hostile.test.ts` (adversarial regressions) share one fake and
 * both stay under the repo's 500-line rule.
 */

export const CLONE_TOKEN = 'CLONE-SECRET-DO-NOT-LEAK';
export const VALID = 'djr_valid-token';

export function makeJob(o: Partial<DevJob> = {}): DevJob {
  const nowIso = new Date().toISOString();
  const base: DevJob = {
    id: 'job-1', repoId: 'repo-1', kind: 'implement', brief: 'implement the ticket',
    source: 'admin', sourceRef: null, baseSha: 'base0000000000000000000000000000000000sha',
    backend: 'local', agentKind: 'claude-cli', authMode: 'api_key', provision: 1,
    phase: 'implement', pipelineMode: 'gated', reviewAttempt: 0, reviewFingerprint: null,
    retryOf: null, status: 'provisioning', claimedBy: null, claimedAt: null,
    lastHeartbeatAt: null, runnerHandle: null, runnerTokenHash: null,
    branch: 'omadia/job-job-1-slug', prUrl: null, result: null, error: null,
    tokensIn: 0, tokensOut: 0, costUsd: 0, createdBy: 'op', createdAt: nowIso,
    startedAt: null, endedAt: null, updatedAt: nowIso,
  };
  return { ...base, ...o };
}

export class FakeStore implements DevRunnerJobStore {
  readonly jobs = new Map<string, DevJob>();
  readonly tokens = new Map<string, string>();
  readonly events: Array<{ jobId: string; provision: number; seq: number; type: string }> = [];
  readonly artifacts: Array<{ id: string; jobId: string; kind: string; content: string; meta?: Record<string, unknown> }> = [];
  readonly recorded: DevJobResult[] = [];
  readonly markRunningCalls: string[] = [];
  private readonly seen = new Set<string>();
  private artifactSeq = 0;

  add(job: DevJob, token = VALID): DevJob {
    this.jobs.set(job.id, job);
    this.tokens.set(job.id, token);
    return job;
  }

  async verifyRunnerToken(jobId: string, token: string): Promise<boolean> {
    return this.tokens.get(jobId) === token;
  }
  async getJob(jobId: string): Promise<DevJob | null> {
    return this.jobs.get(jobId) ?? null;
  }
  readonly touchCalls: string[] = [];
  readonly artifactOwner = new Map<string, string>();

  /** Mirrors the real store: status-guarded, so a terminal job cannot revive. */
  async touchHeartbeat(jobId: string): Promise<boolean> {
    this.touchCalls.push(jobId);
    const j = this.jobs.get(jobId);
    if (!j) return false;
    return j.status === 'provisioning' || j.status === 'running' || j.status === 'applying';
  }

  async markRunning(jobId: string): Promise<boolean> {
    this.markRunningCalls.push(jobId);
    const j = this.jobs.get(jobId);
    if (j && j.status === 'provisioning') {
      j.status = 'running';
      return true;
    }
    return false;
  }
  async appendEvents(jobId: string, provision: number, evs: RunnerEventInput[]): Promise<number> {
    let n = 0;
    for (const e of evs) {
      const k = `${jobId}#${String(provision)}#${String(e.seq)}`;
      if (this.seen.has(k)) continue;
      this.seen.add(k);
      this.events.push({ jobId, provision, seq: e.seq, type: e.type });
      n++;
    }
    return n;
  }
  /** Mirrors the real store: an artifact belongs to exactly one job. */
  async artifactBelongsToJob(jobId: string, artifactId: string): Promise<boolean> {
    return this.artifactOwner.get(artifactId) === jobId;
  }

  /** Simulate a re-provision: only the server bumps a job's provision. */
  setProvision(jobId: string, provision: number): void {
    const j = this.jobs.get(jobId);
    if (j) this.jobs.set(jobId, { ...j, provision });
  }

  async addArtifact(
    jobId: string,
    kind: string,
    content: string,
    meta?: Record<string, unknown>,
  ): Promise<string> {
    const id = `art-${String(++this.artifactSeq)}`;
    this.artifacts.push({ id, jobId, kind, content, meta });
    this.artifactOwner.set(id, jobId);
    return id;
  }
  async getLatestArtifact(jobId: string, kind: string): Promise<{ content: string } | null> {
    const matches = this.artifacts.filter((a) => a.jobId === jobId && a.kind === kind);
    const last = matches[matches.length - 1];
    return last ? { content: last.content } : null;
  }

  async recordResult(jobId: string, result: DevJobResult): Promise<void> {
    this.recorded.push(result);
    const j = this.jobs.get(jobId);
    if (j && result.outcome === 'diff_ready' && !isTerminalDevJobStatus(j.status)) {
      j.status = 'applying';
    }
  }
}

export interface Harness {
  server: Server;
  baseUrl: string;
  store: FakeStore;
  finalizeCalls: Array<{ jobId: string; status: DevJobStatus; ctx?: FinalizeContext }>;
  repoRunsTests: { value: boolean };
  repoBootstrap: { value: string | null };
  cloneToken: { value: string | undefined };
  close(): Promise<void>;
}

export const FIXED_NOW = Date.parse('2026-07-09T12:00:00.000Z');

export async function makeHarness(overrides: Partial<DevRunnerRouterDeps> = {}): Promise<Harness> {
  const store = new FakeStore();
  const finalizeCalls: Harness['finalizeCalls'] = [];
  const repoRunsTests = { value: false };
  const cloneToken: { value: string | undefined } = { value: CLONE_TOKEN };

  const repoBootstrap: { value: string | null } = { value: null };
  const repos = {
    getRepo: async (): Promise<Pick<DevRepo, 'cloneUrl' | 'defaultBranch' | 'runsTests' | 'bootstrapCommand' | 'testCommand'> | null> => ({
      cloneUrl: 'https://github.com/o/r.git', defaultBranch: 'main', runsTests: repoRunsTests.value,
      bootstrapCommand: repoBootstrap.value, testCommand: null,
    }),
  };
  const scmTokens = { resolve: async (): Promise<string | undefined> => cloneToken.value };
  const finalizeDevJob = async (
    jobId: string,
    status: DevJobStatus,
    ctx?: FinalizeContext,
  ): Promise<DevJob | null> => {
    finalizeCalls.push({ jobId, status, ctx });
    const j = store.jobs.get(jobId);
    if (j) j.status = status;
    return j ?? null;
  };

  const app: Express = express();
  app.use(
    '/api/v1/dev-runner',
    createDevRunnerRouter({
      store,
      repos,
      scmTokens,
      finalizeDevJob,
      now: () => FIXED_NOW,
      ...overrides,
    }),
  );

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    baseUrl: `http://127.0.0.1:${String(port)}/api/v1/dev-runner`,
    store,
    finalizeCalls,
    repoRunsTests,
    repoBootstrap,
    cloneToken,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function auth(token = VALID): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** Recursively look for any key that smells like a credential. */
export function hasCredentialKey(v: unknown): boolean {
  const re = /token|secret|credential|password/i;
  if (Array.isArray(v)) return v.some(hasCredentialKey);
  if (v && typeof v === 'object') {
    return Object.entries(v).some(([k, val]) => re.test(k) || hasCredentialKey(val));
  }
  return false;
}
