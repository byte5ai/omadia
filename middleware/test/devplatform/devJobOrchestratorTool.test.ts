import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type {
  DevJobDescriptor,
  DevJobEventRecord,
  DevJobStatus,
} from '@omadia/plugin-api';

import {
  createChatDevJobService,
  type ChatDevJobCaller,
  type ChatDevJobJobStore,
  type ChatDevJobRepoStore,
} from '../../src/devplatform/chatDevJobService.js';
import {
  DEV_JOB_LIST_TOOL_NAME,
  DEV_JOB_START_TOOL_NAME,
  DEV_JOB_STATUS_TOOL_NAME,
  DevJobOrchestratorTool,
  createDevJobOrchestratorTools,
  type ChatDevJobService,
  type DevJobStatusResult,
} from '../../src/devplatform/devJobOrchestratorTool.js';
import { isPermittedLauncher } from '../../src/routes/devPlatformShared.js';
import type {
  DevJob,
  DevJobEvent,
  DevRepo,
  NewDevJob,
} from '../../src/devplatform/types.js';

// ---------------------------------------------------------------------------
// Fakes.
// ---------------------------------------------------------------------------

function descriptor(over: Partial<DevJobDescriptor> = {}): DevJobDescriptor {
  return {
    id: 'job-1',
    repoId: 'repo-1',
    kind: 'fix_issue',
    status: 'queued',
    phase: 'analyze',
    createdAt: '2026-07-11T00:00:00.000Z',
    ...over,
  };
}

/** Hand-rolled ChatDevJobService for the TOOL tests. */
class FakeService implements ChatDevJobService {
  public startedWith: Array<{
    repoId: string;
    kind: string;
    brief: string;
    sourceRef?: string;
  }> = [];

  constructor(
    private readonly opts: {
      repos?: Record<string, { repoId: string; repoName: string }>;
      job?: DevJobStatusResult | null;
      list?: readonly DevJobDescriptor[];
    } = {},
  ) {}

  async resolveLaunchableRepo(
    ref: string,
  ): Promise<{ repoId: string; repoName: string } | null> {
    return this.opts.repos?.[ref] ?? null;
  }

  async startJob(input: {
    repoId: string;
    kind: DevJobDescriptor['kind'];
    brief: string;
    sourceRef?: string;
  }): Promise<DevJobDescriptor> {
    this.startedWith.push({ ...input });
    return descriptor({ repoId: input.repoId, kind: input.kind });
  }

  async getJob(_jobId: string): Promise<DevJobStatusResult | null> {
    return this.opts.job ?? null;
  }

  async listJobs(): Promise<readonly DevJobDescriptor[]> {
    return this.opts.list ?? [];
  }
}

describe('DevJobOrchestratorTool (built-in orchestrator tools, W3 §3)', () => {
  it('registers exactly start/status/list and NO gate-resolve tool', () => {
    const { registrations } = createDevJobOrchestratorTools(new FakeService());
    const names = registrations.map((r) => r.name).sort();
    assert.deepEqual(names, [
      DEV_JOB_LIST_TOOL_NAME,
      DEV_JOB_START_TOOL_NAME,
      DEV_JOB_STATUS_TOOL_NAME,
    ]);
    // Gate resolution is a HUMAN-session action (spec §4) — never a chat tool.
    assert.ok(!names.includes('dev_job_resolve_gate'));
    assert.ok(!names.some((n) => n.includes('gate')));
    // Full-form registration shape (mirrors requestSelfExtensionTool).
    for (const r of registrations) {
      assert.equal(typeof r.handler, 'function');
      assert.equal(r.spec.name, r.name);
      assert.equal(typeof r.promptDoc, 'string');
      assert.equal(r.spec.input_schema.type, 'object');
    }
  });

  it('dev_job_start creates a job on an authorized repo and returns the descriptor', async () => {
    const svc = new FakeService({
      repos: { 'repo-1': { repoId: 'repo-1', repoName: 'backend' } },
    });
    const { tool } = createDevJobOrchestratorTools(svc);
    const out = await tool.handleStart({
      repo: 'repo-1',
      kind: 'implement',
      brief: 'Please implement the widget',
      ticket: 'PROJ-9',
    });
    const parsed = JSON.parse(out) as {
      status: string;
      jobId: string;
      repoId: string;
      phase: string;
    };
    assert.equal(parsed.status, 'job_started');
    assert.equal(parsed.jobId, 'job-1');
    assert.equal(parsed.repoId, 'repo-1');
    assert.equal(parsed.phase, 'queued');
    // The service saw the resolved repo id + the ticket as sourceRef.
    assert.equal(svc.startedWith.length, 1);
    assert.deepEqual(svc.startedWith[0], {
      repoId: 'repo-1',
      kind: 'implement',
      brief: 'Please implement the widget',
      sourceRef: 'PROJ-9',
    });
  });

  it('dev_job_start queues a live card drained by takePendingCards', async () => {
    const svc = new FakeService({
      repos: { 'repo-1': { repoId: 'repo-1', repoName: 'backend' } },
    });
    const { tool } = createDevJobOrchestratorTools(svc);
    assert.ok(!tool.hasPendingCards());
    await tool.handleStart({ repo: 'repo-1', brief: 'do the needful please' });
    assert.ok(tool.hasPendingCards());
    const cards = tool.takePendingCards();
    assert.equal(cards.length, 1);
    assert.equal(cards[0]!.jobId, 'job-1');
    assert.equal(cards[0]!.repoName, 'backend');
    assert.equal(cards[0]!.eventsUrl, '/api/dev-platform/jobs/job-1/events');
    // Drained: a second take is empty.
    assert.deepEqual(tool.takePendingCards(), []);
  });

  it('dev_job_start refuses an unauthorized repo (no existence oracle, no card)', async () => {
    const svc = new FakeService({ repos: {} }); // nothing resolves
    const { tool } = createDevJobOrchestratorTools(svc);
    const out = await tool.handleStart({ repo: 'secret-repo', brief: 'sneaky task here' });
    assert.ok(out.startsWith('Error:'));
    assert.match(out, /not available to this agent/);
    assert.equal(svc.startedWith.length, 0);
    assert.ok(!tool.hasPendingCards());
  });

  it('dev_job_start rejects invalid input (brief too short, unknown keys)', async () => {
    const svc = new FakeService({
      repos: { 'repo-1': { repoId: 'repo-1', repoName: 'backend' } },
    });
    const tool = new DevJobOrchestratorTool(svc);
    const short = await tool.handleStart({ repo: 'repo-1', brief: 'hi' });
    assert.ok(short.startsWith('Error: invalid dev_job_start input'));
    const extra = await tool.handleStart({
      repo: 'repo-1',
      brief: 'a valid enough brief',
      bogus: true,
    });
    assert.ok(extra.startsWith('Error: invalid dev_job_start input'));
    // The service was never touched by an invalid call.
    assert.equal(svc.startedWith.length, 0);
  });

  it('dev_job_start defaults kind to fix_issue', async () => {
    const svc = new FakeService({
      repos: { 'repo-1': { repoId: 'repo-1', repoName: 'backend' } },
    });
    const tool = new DevJobOrchestratorTool(svc);
    await tool.handleStart({ repo: 'repo-1', brief: 'a valid enough brief' });
    assert.equal(svc.startedWith[0]!.kind, 'fix_issue');
  });

  it('dev_job_status returns the descriptor plus the last 5 event lines', async () => {
    const events: DevJobEventRecord[] = Array.from({ length: 7 }, (_, n) => ({
      id: n + 1,
      at: `2026-07-11T00:0${n}:00.000Z`,
      type: n % 2 === 0 ? 'log' : 'phase',
      payload: {},
    }));
    const svc = new FakeService({
      job: { descriptor: descriptor({ status: 'running', phase: 'implement' }), recentEvents: events },
    });
    const tool = new DevJobOrchestratorTool(svc);
    const out = await tool.handleStatus({ jobId: 'job-1' });
    const parsed = JSON.parse(out) as {
      jobId: string;
      status: string;
      phase: string;
      recentEvents: Array<{ at: string; type: string }>;
    };
    assert.equal(parsed.jobId, 'job-1');
    assert.equal(parsed.status, 'running');
    assert.equal(parsed.phase, 'implement');
    assert.equal(parsed.recentEvents.length, 5); // last 5 of 7
    assert.equal(parsed.recentEvents[4]!.at, '2026-07-11T00:06:00.000Z');
  });

  it('dev_job_status refuses an unknown/inaccessible job', async () => {
    const tool = new DevJobOrchestratorTool(new FakeService({ job: null }));
    const out = await tool.handleStatus({ jobId: 'nope' });
    assert.ok(out.startsWith('Error:'));
    assert.match(out, /not found or is not accessible/);
  });

  it('dev_job_status rejects invalid input', async () => {
    const tool = new DevJobOrchestratorTool(new FakeService());
    const out = await tool.handleStatus({});
    assert.ok(out.startsWith('Error: invalid dev_job_status input'));
  });

  it('dev_job_list returns the caller-visible jobs', async () => {
    const svc = new FakeService({
      list: [descriptor({ id: 'j1' }), descriptor({ id: 'j2', status: 'done' })],
    });
    const tool = new DevJobOrchestratorTool(svc);
    const out = await tool.handleList({ status: 'queued' });
    const parsed = JSON.parse(out) as { jobs: Array<{ jobId: string }> };
    assert.equal(parsed.jobs.length, 2);
    assert.deepEqual(parsed.jobs.map((j) => j.jobId), ['j1', 'j2']);
  });

  it('dev_job_list rejects an invalid status filter', async () => {
    const tool = new DevJobOrchestratorTool(new FakeService());
    const out = await tool.handleList({ status: 'not-a-status' });
    assert.ok(out.startsWith('Error: invalid dev_job_list input'));
  });
});

// ---------------------------------------------------------------------------
// createChatDevJobService — authorization composition over in-memory stores
// (deterministic, no Postgres). Proves source='chat', createdBy=caller.sub, and
// the fail-closed isPermittedLauncher ∩ allowedRepoIds gate.
// ---------------------------------------------------------------------------

function repo(over: Partial<DevRepo> & { id: string; name: string }): DevRepo {
  return {
    forgeKind: 'github',
    owner: 'acme',
    cloneUrl: 'https://example.com/x/y.git',
    defaultBranch: 'main',
    credentialKind: 'pat',
    credentialRef: 'repo/x',
    trackerKind: null,
    trackerConfig: {},
    allowedTriggers: [],
    allowedLaunchers: [],
    egressAllowlist: [],
    runsTests: false,
    branchProtectionOk: null,
    branchProtectionCheckedAt: null,
    approverRoleKey: null,
    gateDeadlineIso: '',
    bootstrapCommand: null,
    testCommand: null,
    policyOverrides: {},
    createdBy: 'someone',
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
    ...over,
  } as DevRepo;
}

class FakeRepoStore implements ChatDevJobRepoStore {
  constructor(private readonly repos: DevRepo[]) {}
  async getRepo(id: string): Promise<DevRepo | null> {
    return this.repos.find((r) => r.id === id) ?? null;
  }
  async listRepos(): Promise<DevRepo[]> {
    return [...this.repos];
  }
}

class FakeJobStore implements ChatDevJobJobStore {
  public created: Array<NewDevJob & { runnerTokenHash: string }> = [];
  private jobs: DevJob[] = [];
  async createJob(input: NewDevJob & { runnerTokenHash: string }): Promise<DevJob> {
    this.created.push(input);
    const job = {
      id: `job-${this.created.length}`,
      repoId: input.repoId,
      kind: input.kind,
      brief: input.brief,
      source: input.source,
      sourceRef: input.sourceRef ?? null,
      backend: input.backend,
      authMode: input.authMode ?? 'api_key',
      phase: input.phase ?? 'analyze',
      status: 'queued' as DevJobStatus,
      branch: null,
      prUrl: null,
      createdBy: input.createdBy,
      createdAt: '2026-07-11T00:00:00.000Z',
    } as unknown as DevJob;
    this.jobs.push(job);
    return job;
  }
  async getJob(id: string): Promise<DevJob | null> {
    return this.jobs.find((j) => j.id === id) ?? null;
  }
  async listJobs(filter?: { status?: DevJobStatus }): Promise<DevJob[]> {
    return this.jobs.filter((j) => !filter?.status || j.status === filter.status);
  }
  async listEvents(): Promise<DevJobEvent[]> {
    return [];
  }
}

const CALLER: ChatDevJobCaller = { sub: 'op-42', email: 'op@acme.test', role: 'dev' };

describe('createChatDevJobService (authorization, fake stores)', () => {
  it('starts a source=chat job attributed to the operator on a granted, launchable repo', async () => {
    const r = repo({ id: 'r1', name: 'backend', createdBy: 'op-42' }); // caller is creator ⇒ launcher
    const repoStore = new FakeRepoStore([r]);
    const jobStore = new FakeJobStore();
    const svc = createChatDevJobService({
      repoStore,
      jobStore,
      caller: CALLER,
      allowedRepoIds: ['r1'],
      isPermittedLauncher,
      resolveJobPlacement: () => ({ backend: 'local' }),
      mintRunnerToken: () => ({ hash: 'h'.repeat(64) }),
    });

    const resolved = await svc.resolveLaunchableRepo('backend'); // resolve by name
    assert.deepEqual(resolved, { repoId: 'r1', repoName: 'backend' });

    const d = await svc.startJob({ repoId: 'r1', kind: 'fix_issue', brief: 'x' });
    assert.equal(d.repoId, 'r1');
    assert.equal(jobStore.created.length, 1);
    assert.equal(jobStore.created[0]!.source, 'chat');
    assert.equal(jobStore.created[0]!.createdBy, 'op-42');
    assert.equal(jobStore.created[0]!.authMode, 'api_key');
  });

  it('refuses a repo the operator is not a permitted launcher of (no oracle)', async () => {
    // Repo exists and is granted, but the caller neither created it nor holds a
    // launcher role ⇒ isPermittedLauncher is false ⇒ resolve is null.
    const r = repo({ id: 'r1', name: 'backend', createdBy: 'someone-else', allowedLaunchers: ['admins'] });
    const svc = createChatDevJobService({
      repoStore: new FakeRepoStore([r]),
      jobStore: new FakeJobStore(),
      caller: CALLER,
      allowedRepoIds: ['r1'],
      isPermittedLauncher,
      resolveJobPlacement: () => ({ backend: 'local' }),
    });
    assert.equal(await svc.resolveLaunchableRepo('r1'), null);
    assert.equal(await svc.resolveLaunchableRepo('backend'), null);
    await assert.rejects(() => svc.startJob({ repoId: 'r1', kind: 'analyze', brief: 'x' }));
  });

  it('refuses a repo outside the agent grant even when launchable', async () => {
    const r = repo({ id: 'r1', name: 'backend', createdBy: 'op-42' }); // launchable
    const svc = createChatDevJobService({
      repoStore: new FakeRepoStore([r]),
      jobStore: new FakeJobStore(),
      caller: CALLER,
      allowedRepoIds: [], // empty grant ⇒ nothing authorized
      isPermittedLauncher,
      resolveJobPlacement: () => ({ backend: 'local' }),
    });
    assert.equal(await svc.resolveLaunchableRepo('r1'), null);
    assert.deepEqual(await svc.listJobs({}), []);
  });

  it('scopes status + list to authorized repos', async () => {
    const granted = repo({ id: 'r1', name: 'backend', createdBy: 'op-42' });
    const other = repo({ id: 'r2', name: 'secret', createdBy: 'someone-else' });
    const repoStore = new FakeRepoStore([granted, other]);
    const jobStore = new FakeJobStore();
    const svc = createChatDevJobService({
      repoStore,
      jobStore,
      caller: CALLER,
      allowedRepoIds: ['r1'],
      isPermittedLauncher,
      resolveJobPlacement: () => ({ backend: 'local' }),
      mintRunnerToken: () => ({ hash: 'h'.repeat(64) }),
    });
    const d = await svc.startJob({ repoId: 'r1', kind: 'fix_issue', brief: 'x' });

    const status = await svc.getJob(d.id);
    assert.ok(status);
    assert.equal(status!.descriptor.repoId, 'r1');

    const list = await svc.listJobs({});
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, d.id);

    // A repoId filter outside the grant returns nothing.
    assert.deepEqual(await svc.listJobs({ repoId: 'r2' }), []);
  });
});
