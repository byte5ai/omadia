/**
 * Epic #470 W3 — unit test for the ctx.devJobs plugin accessor (spec §2/§10).
 * Mirrors test/pluginMcpAccessor.test.ts: a stubbed 'devJobs' host service in a
 * fake service registry, exercising the fail-closed / no-existence-oracle
 * contract in `createPluginDevJobsAccessor` directly (no DB).
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type {
  DevJobCreateRequest,
  DevJobDescriptor,
  DevJobEventRecord,
  DevJobStatus,
} from '@omadia/plugin-api';

import {
  createPluginDevJobsAccessor,
  type DevJobsHostService,
} from '../src/platform/pluginContext.js';

const PLUGIN = '@omadia/integration-example';
const OTHER_PLUGIN = '@omadia/integration-other';
const REPO_GRANTED = 'repo-granted';
const REPO_UNGRANTED = 'repo-ungranted';

interface StubJob {
  descriptor: DevJobDescriptor;
  creatorPluginId: string;
  events: DevJobEventRecord[];
}

interface CreateCall {
  input: DevJobCreateRequest & { createdBy: { kind: 'plugin'; id: string } };
}

function desc(id: string, repoId: string, over: Partial<DevJobDescriptor> = {}): DevJobDescriptor {
  return {
    id,
    repoId,
    kind: 'fix_issue',
    status: 'queued',
    phase: 'analyze',
    createdAt: '2026-07-11T00:00:00.000Z',
    ...over,
  };
}

/** A stub 'devJobs' host service modelling the real grant + creator semantics
 *  the accessor relies on. */
function makeHost(opts: {
  grants: Record<string, string[]>;
  jobs?: StubJob[];
  createCalls?: CreateCall[];
  cancelled?: string[];
}): DevJobsHostService {
  const jobs = new Map<string, StubJob>((opts.jobs ?? []).map((j) => [j.descriptor.id, j]));
  return {
    async listGrantedRepoIds(pluginId) {
      return opts.grants[pluginId] ?? [];
    },
    async createJob(input) {
      opts.createCalls?.push({ input });
      const d = desc(`job-${jobs.size + 1}`, input.repoId, { kind: input.kind });
      jobs.set(d.id, { descriptor: d, creatorPluginId: input.createdBy.id, events: [] });
      return d;
    },
    async getJob(jobId) {
      return jobs.get(jobId)?.descriptor;
    },
    async listJobs(filter) {
      const scope = new Set(filter.repoIds);
      return [...jobs.values()]
        .map((j) => j.descriptor)
        .filter((d) => scope.has(d.repoId))
        .filter((d) => (filter.status ? d.status === filter.status : true));
    },
    async listJobEvents(jobId, afterId) {
      const j = jobs.get(jobId);
      if (!j) return [];
      return j.events.filter((e) => (afterId === undefined ? true : e.id > afterId));
    },
    async cancelJob(jobId, requestedByPluginId) {
      const j = jobs.get(jobId);
      if (!j) throw new Error(`dev job "${jobId}" not found`);
      if (j.creatorPluginId !== requestedByPluginId) {
        throw new Error(`dev job "${jobId}" was not created by plugin "${requestedByPluginId}"`);
      }
      opts.cancelled?.push(jobId);
    },
  };
}

function registryOf(host: DevJobsHostService): { get<T>(name: string): T | undefined } {
  return { get: <T>(name: string) => (name === 'devJobs' ? (host as T) : undefined) };
}

describe('createPluginDevJobsAccessor (#470 W3)', () => {
  it('listRepos returns exactly the granted repo ids', async () => {
    const host = makeHost({ grants: { [PLUGIN]: [REPO_GRANTED] } });
    const accessor = createPluginDevJobsAccessor(PLUGIN, registryOf(host));
    assert.deepEqual(await accessor.listRepos(), [REPO_GRANTED]);
  });

  it('create on a granted repo tags the job with plugin creator attribution', async () => {
    const createCalls: CreateCall[] = [];
    const host = makeHost({ grants: { [PLUGIN]: [REPO_GRANTED] }, createCalls });
    const accessor = createPluginDevJobsAccessor(PLUGIN, registryOf(host));
    const job = await accessor.create({ repoId: REPO_GRANTED, kind: 'analyze', brief: 'do the thing' });
    assert.equal(job.repoId, REPO_GRANTED);
    assert.deepEqual(createCalls[0]?.input.createdBy, { kind: 'plugin', id: PLUGIN });
  });

  it('create on an ungranted repo fails closed', async () => {
    const host = makeHost({ grants: { [PLUGIN]: [REPO_GRANTED] } });
    const accessor = createPluginDevJobsAccessor(PLUGIN, registryOf(host));
    await assert.rejects(
      accessor.create({ repoId: REPO_UNGRANTED, kind: 'fix_issue', brief: 'x'.repeat(20) }),
      /not granted/,
    );
  });

  it('get returns a job on a granted repo', async () => {
    const host = makeHost({
      grants: { [PLUGIN]: [REPO_GRANTED] },
      jobs: [{ descriptor: desc('j1', REPO_GRANTED), creatorPluginId: PLUGIN, events: [] }],
    });
    const accessor = createPluginDevJobsAccessor(PLUGIN, registryOf(host));
    assert.equal((await accessor.get('j1')).id, 'j1');
  });

  it('no existence oracle: a missing job and an out-of-scope job throw the SAME error', async () => {
    const host = makeHost({
      grants: { [PLUGIN]: [REPO_GRANTED] },
      jobs: [{ descriptor: desc('on-b', REPO_UNGRANTED), creatorPluginId: PLUGIN, events: [] }],
    });
    const accessor = createPluginDevJobsAccessor(PLUGIN, registryOf(host));
    const missingMsg = await accessor.get('does-not-exist').then(
      () => 'NO_THROW',
      (e: Error) => e.message,
    );
    const outOfScopeMsg = await accessor.get('on-b').then(
      () => 'NO_THROW',
      (e: Error) => e.message,
    );
    assert.match(missingMsg, /not accessible/);
    // No existence oracle: the message TEMPLATE must be identical whether the job
    // is missing or exists-but-ungranted — only the caller's own id (which they
    // already know) differs. Normalise the id out before comparing.
    const normalizeId = (m: string): string => m.replace(/dev job "[^"]*"/, 'dev job "<id>"');
    assert.equal(normalizeId(missingMsg), normalizeId(outOfScopeMsg));
  });

  it('list scopes to granted repos; a filter naming an ungranted repo throws', async () => {
    const host = makeHost({
      grants: { [PLUGIN]: [REPO_GRANTED] },
      jobs: [
        { descriptor: desc('g1', REPO_GRANTED), creatorPluginId: PLUGIN, events: [] },
        { descriptor: desc('u1', REPO_UNGRANTED), creatorPluginId: OTHER_PLUGIN, events: [] },
      ],
    });
    const accessor = createPluginDevJobsAccessor(PLUGIN, registryOf(host));
    const all = await accessor.list();
    assert.deepEqual(all.map((d) => d.id), ['g1']);
    await assert.rejects(accessor.list({ repoId: REPO_UNGRANTED }), /not granted/);
  });

  it('list passes a status filter through', async () => {
    const host = makeHost({
      grants: { [PLUGIN]: [REPO_GRANTED] },
      jobs: [
        { descriptor: desc('run', REPO_GRANTED, { status: 'running' }), creatorPluginId: PLUGIN, events: [] },
        { descriptor: desc('don', REPO_GRANTED, { status: 'done' }), creatorPluginId: PLUGIN, events: [] },
      ],
    });
    const accessor = createPluginDevJobsAccessor(PLUGIN, registryOf(host));
    const running = await accessor.list({ status: 'running' as DevJobStatus });
    assert.deepEqual(running.map((d) => d.id), ['run']);
  });

  it('listEvents cursor-polls with afterId over the append-only log', async () => {
    const events: DevJobEventRecord[] = [
      { id: 1, at: 't1', type: 'phase', payload: {} },
      { id: 2, at: 't2', type: 'log', payload: { line: 'a' } },
      { id: 3, at: 't3', type: 'log', payload: { line: 'b' } },
    ];
    const host = makeHost({
      grants: { [PLUGIN]: [REPO_GRANTED] },
      jobs: [{ descriptor: desc('j1', REPO_GRANTED), creatorPluginId: PLUGIN, events }],
    });
    const accessor = createPluginDevJobsAccessor(PLUGIN, registryOf(host));
    assert.deepEqual((await accessor.listEvents('j1')).map((e) => e.id), [1, 2, 3]);
    assert.deepEqual((await accessor.listEvents('j1', 2)).map((e) => e.id), [3]);
  });

  it('listEvents on an ungranted-repo job fails closed with the no-oracle error', async () => {
    const host = makeHost({
      grants: { [PLUGIN]: [REPO_GRANTED] },
      jobs: [{ descriptor: desc('u1', REPO_UNGRANTED), creatorPluginId: PLUGIN, events: [] }],
    });
    const accessor = createPluginDevJobsAccessor(PLUGIN, registryOf(host));
    await assert.rejects(accessor.listEvents('u1'), /not accessible/);
  });

  it('cancel works on a self-created job', async () => {
    const cancelled: string[] = [];
    const host = makeHost({
      grants: { [PLUGIN]: [REPO_GRANTED] },
      jobs: [{ descriptor: desc('mine', REPO_GRANTED), creatorPluginId: PLUGIN, events: [] }],
      cancelled,
    });
    const accessor = createPluginDevJobsAccessor(PLUGIN, registryOf(host));
    await accessor.cancel('mine');
    assert.deepEqual(cancelled, ['mine']);
  });

  it("cancel throws on another plugin's job (on a granted repo)", async () => {
    const host = makeHost({
      grants: { [PLUGIN]: [REPO_GRANTED] },
      jobs: [{ descriptor: desc('theirs', REPO_GRANTED), creatorPluginId: OTHER_PLUGIN, events: [] }],
    });
    const accessor = createPluginDevJobsAccessor(PLUGIN, registryOf(host));
    await assert.rejects(accessor.cancel('theirs'), /was not created by plugin/);
  });

  it('cancel on an ungranted-repo job fails closed (no oracle) before the creator check', async () => {
    const host = makeHost({
      grants: { [PLUGIN]: [REPO_GRANTED] },
      jobs: [{ descriptor: desc('u1', REPO_UNGRANTED), creatorPluginId: PLUGIN, events: [] }],
    });
    const accessor = createPluginDevJobsAccessor(PLUGIN, registryOf(host));
    await assert.rejects(accessor.cancel('u1'), /not accessible/);
  });

  it('throws a clear error when the host service is unregistered', async () => {
    const accessor = createPluginDevJobsAccessor(PLUGIN, { get: () => undefined });
    await assert.rejects(accessor.listRepos(), /host service unavailable/);
    await assert.rejects(accessor.get('x'), /host service unavailable/);
  });
});
