import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createChatDevJobOrchestratorTools } from '../../src/devplatform/chatDevJobToolWiring.js';
import {
  DEV_JOB_LIST_TOOL_NAME,
  DEV_JOB_START_TOOL_NAME,
  DEV_JOB_STATUS_TOOL_NAME,
  type KernelToolRegistration,
} from '../../src/devplatform/devJobOrchestratorTool.js';
import { isPermittedLauncher } from '../../src/routes/devPlatformShared.js';
import type {
  ChatDevJobJobStore,
  ChatDevJobRepoStore,
} from '../../src/devplatform/chatDevJobService.js';
import type { DevJob, DevRepo, NewDevJob } from '../../src/devplatform/types.js';

// ---------------------------------------------------------------------------
// Minimal fixtures + fakes. `createChatDevJobOrchestratorTools` builds the REAL
// `createChatDevJobService` internally, so these exercise the whole per-call
// path — turnContext resolution + launch envelope + isPermittedLauncher.
// ---------------------------------------------------------------------------

function makeRepo(over: Partial<DevRepo> = {}): DevRepo {
  return {
    id: 'repo-1',
    forgeKind: 'github',
    owner: 'byte5ai',
    name: 'omadia',
    cloneUrl: 'https://github.com/byte5ai/omadia.git',
    defaultBranch: 'main',
    credentialKind: 'github_app',
    credentialRef: 'repo/repo-1',
    trackerKind: null,
    trackerConfig: {},
    allowedTriggers: [],
    allowedLaunchers: [],
    egressAllowlist: [],
    runsTests: false,
    branchProtectionOk: true,
    branchProtectionCheckedAt: null,
    approverRoleKey: null,
    gateDeadlineIso: 'P7D',
    bootstrapCommand: null,
    testCommand: null,
    policyOverrides: {},
    triggerLabel: 'omadia-dev',
    webhookEnabled: true,
    webhookSenders: [],
    budgetCostUsd: null,
    dockerInJob: false,
    createdBy: 'operator-1',
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
    ...over,
  };
}

function makeJob(input: NewDevJob & { runnerTokenHash: string }): DevJob {
  return {
    id: 'job-1',
    repoId: input.repoId,
    kind: input.kind,
    brief: input.brief,
    source: input.source,
    sourceRef: input.sourceRef ?? null,
    baseSha: null,
    backend: input.backend,
    agentKind: input.agentKind ?? 'claude_code',
    authMode: input.authMode ?? 'api_key',
    provision: 0,
    phase: input.phase ?? 'analyze',
    pipelineMode: 'gated',
    reviewAttempt: 0,
    reviewFingerprint: null,
    retryOf: null,
    status: input.status ?? 'queued',
    claimedBy: null,
    claimedAt: null,
    lastHeartbeatAt: null,
    runnerHandle: null,
    runnerTokenHash: input.runnerTokenHash,
    branch: null,
    prUrl: null,
    result: null,
    error: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    budgetCostUsd: null,
    budgetTokens: null,
    usageEstimated: false,
    createdBy: input.createdBy,
    createdAt: '2026-07-11T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
    updatedAt: '2026-07-11T00:00:00.000Z',
  };
}

function makeStores(repos: DevRepo[]): {
  repoStore: ChatDevJobRepoStore;
  jobStore: ChatDevJobJobStore & { created: DevJob[] };
} {
  const byId = new Map(repos.map((r) => [r.id, r]));
  const created: DevJob[] = [];
  const jobStore: ChatDevJobJobStore & { created: DevJob[] } = {
    created,
    async createJob(input) {
      const job = makeJob(input);
      created.push(job);
      return job;
    },
    async getJob(id) {
      return created.find((j) => j.id === id) ?? null;
    },
    async listJobs(filter) {
      return created.filter((j) => !filter?.repoId || j.repoId === filter.repoId);
    },
    async listEvents() {
      return [];
    },
  };
  return {
    repoStore: {
      async getRepo(id) {
        return byId.get(id) ?? null;
      },
      async listRepos() {
        return repos;
      },
    },
    jobStore,
  };
}

function findReg(
  regs: readonly KernelToolRegistration[],
  name: string,
): KernelToolRegistration {
  const reg = regs.find((r) => r.name === name);
  assert.ok(reg, `registration ${name} present`);
  return reg;
}

describe('chatDevJobToolWiring (W3 boot wire — turnContext caller resolution)', () => {
  it('resolves the caller from the turnContext seam and launches on a repo the operator created', async () => {
    let userId: string | undefined = 'operator-1';
    const { repoStore, jobStore } = makeStores([makeRepo({ createdBy: 'operator-1' })]);
    const { registrations } = createChatDevJobOrchestratorTools({
      repoStore,
      jobStore,
      isPermittedLauncher,
      defaultBackend: 'docker',
      getCallerUserId: () => userId,
    });
    const start = findReg(registrations, DEV_JOB_START_TOOL_NAME);

    const out = await start.handler({
      repo: 'repo-1',
      kind: 'implement',
      brief: 'implement the widget end to end',
    });
    const parsed = JSON.parse(out) as { status: string; jobId: string; repoId: string };
    assert.equal(parsed.status, 'job_started');
    assert.equal(parsed.repoId, 'repo-1');
    // The job was created attributed to the turnContext operator, source 'chat'.
    assert.equal(jobStore.created.length, 1);
    assert.equal(jobStore.created[0]!.createdBy, 'operator-1');
    assert.equal(jobStore.created[0]!.source, 'chat');
    assert.equal(jobStore.created[0]!.backend, 'docker');
    assert.equal(jobStore.created[0]!.authMode, 'api_key');
  });

  it('refuses ALL tools when no userId is on the turn (fail closed)', async () => {
    const { repoStore, jobStore } = makeStores([makeRepo({ createdBy: 'operator-1' })]);
    const { registrations } = createChatDevJobOrchestratorTools({
      repoStore,
      jobStore,
      isPermittedLauncher,
      defaultBackend: 'docker',
      getCallerUserId: () => undefined, // no human turn
    });

    const startOut = await findReg(registrations, DEV_JOB_START_TOOL_NAME).handler({
      repo: 'repo-1',
      brief: 'do the needful for me please',
    });
    assert.ok(startOut.startsWith('Error:'), 'start refuses with an Error string');
    assert.equal(jobStore.created.length, 0, 'no job created without an operator');

    const statusOut = await findReg(registrations, DEV_JOB_STATUS_TOOL_NAME).handler({
      jobId: 'job-1',
    });
    assert.ok(statusOut.startsWith('Error:'), 'status refuses (no oracle)');

    const listOut = await findReg(registrations, DEV_JOB_LIST_TOOL_NAME).handler({});
    assert.deepEqual(JSON.parse(listOut), { jobs: [] }, 'list is empty without an operator');
  });

  it('refuses a repo the operator did not create (role branch inert without a session role)', async () => {
    // Repo created by someone else, allowed_launchers set to a role the caller
    // would need — but turnContext carries no role, so the caller is
    // { sub: operator-2, role: '' } and only creator-launch is admissible.
    const { repoStore, jobStore } = makeStores([
      makeRepo({ createdBy: 'operator-1', allowedLaunchers: ['dev-leads'] }),
    ]);
    const { registrations } = createChatDevJobOrchestratorTools({
      repoStore,
      jobStore,
      isPermittedLauncher,
      defaultBackend: 'docker',
      getCallerUserId: () => 'operator-2',
    });

    const out = await findReg(registrations, DEV_JOB_START_TOOL_NAME).handler({
      repo: 'repo-1',
      brief: 'try to launch on someone elses repo',
    });
    assert.ok(out.startsWith('Error:'), 'non-creator launch refused');
    assert.match(out, /not available to this agent/);
    assert.equal(jobStore.created.length, 0);
  });

  it('lists only the operator-launchable jobs for the resolved caller', async () => {
    const { repoStore, jobStore } = makeStores([makeRepo({ createdBy: 'operator-1' })]);
    const tools = createChatDevJobOrchestratorTools({
      repoStore,
      jobStore,
      isPermittedLauncher,
      defaultBackend: 'docker',
      getCallerUserId: () => 'operator-1',
    });
    // Seed a job by launching.
    await findReg(tools.registrations, DEV_JOB_START_TOOL_NAME).handler({
      repo: 'repo-1',
      brief: 'a launched job for the list',
    });
    const listOut = await findReg(tools.registrations, DEV_JOB_LIST_TOOL_NAME).handler({});
    const parsed = JSON.parse(listOut) as { jobs: Array<{ jobId: string; repoId: string }> };
    assert.equal(parsed.jobs.length, 1);
    assert.equal(parsed.jobs[0]!.repoId, 'repo-1');
  });
});
