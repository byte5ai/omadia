import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { defaultCommandPolicy, type CommandPolicy } from '../../packages/harness-channel-sdk/src/commandPolicy.js';
import { resolveAgentComputerProfile } from '../../packages/harness-sandbox/src/agentComputerProfile.js';
import type { Sandbox, SandboxBackend } from '../../packages/harness-sandbox/src/sandbox.js';
import { InMemoryPublishStore } from '../../packages/harness-publish/src/publishStore.js';
import type { PublishRuntime } from '../../packages/harness-publish/src/publish.js';
import { createPublishHandler } from '../../packages/harness-orchestrator/src/tools/publishTool.js';
import { turnContext } from '../../packages/harness-orchestrator/src/turnContext.js';
import { getCommandPolicyMetrics, resetCommandPolicyMetrics } from '../../packages/harness-orchestrator/src/commandPolicyMetrics.js';

/**
 * Issue #581 P2 — `publish` tool tests, same shape as `executeTool.test.ts`
 * (#576 P2): every "refused" path proves NOTHING downstream ran (no
 * `provision`, no `runtime.deploy`) before the plumbing-works path proves it
 * did.
 */
class StubBackend implements SandboxBackend {
  readonly provisionCalls: Array<{ scopeKey: string }> = [];
  constructor(private readonly files: Record<string, string> = { 'server.js': 'listen()' }) {}

  async provision(args: { scopeKey: string }): Promise<Sandbox> {
    this.provisionCalls.push({ scopeKey: args.scopeKey });
    const files = this.files;
    return {
      id: 'stub-sandbox',
      scopeKey: args.scopeKey,
      profile: resolveAgentComputerProfile(),
      async run() {
        throw new Error('not used in this test');
      },
      async read(relativePath: string) {
        const content = files[relativePath];
        return content === undefined ? { ok: false as const, reason: 'not_found' as const, detail: 'x' } : { ok: true as const, content };
      },
      async list(relativePath: string) {
        if (relativePath !== '.' && relativePath !== '') return { ok: false as const, reason: 'not_found' as const, detail: 'x' };
        return { ok: true as const, entries: Object.keys(files).map((name) => ({ name, kind: 'file' as const })) };
      },
      async write() {
        throw new Error('not used in this test');
      },
      async teardown() {
        /* no-op */
      },
    };
  }
}

function spyRuntime(): PublishRuntime & { readonly deployCalls: unknown[] } {
  const deployCalls: unknown[] = [];
  return {
    deployCalls,
    async deploy(args) {
      deployCalls.push(args);
    },
  };
}

function runInTurn<T>(sessionScope: string | undefined, fn: () => Promise<T>): Promise<T> {
  return turnContext.run({ turnId: 'turn-1', turnDate: '2026-08-20', ...(sessionScope !== undefined ? { sessionScope } : {}) }, fn);
}

const VALID_INPUT = { appId: 'todo-app', name: 'Todo', dir: '.', entrypoint: 'server.js' };

beforeEach(() => {
  resetCommandPolicyMetrics();
});

describe('publish tool — command-policy check runs before any sandbox/deploy call', () => {
  it('denies when the policy has a matching rule for the synthetic "publish <appId>" pseudo-command', async () => {
    const backend = new StubBackend();
    const runtime = spyRuntime();
    const store = new InMemoryPublishStore();
    const policy: CommandPolicy = {
      ...defaultCommandPolicy(),
      scopeRules: [{ id: 'scope.deny-publish', decision: 'deny', reason: 'publishing is frozen', match: { kind: 'commandFlag', name: 'publish' } }],
    };
    const handler = createPublishHandler({ sandboxBackend: backend, runtime, store, resolveCommandPolicy: () => policy });
    const result = await runInTurn('personal:u1', () => handler(VALID_INPUT));
    assert.match(result, /^Error: publish — refused by the command policy/);
    assert.equal(backend.provisionCalls.length, 0);
    assert.equal(runtime.deployCalls.length, 0);
    assert.equal(getCommandPolicyMetrics().denied, 1);
  });

  it('refuses (does not silently escalate) a require_approval decision', async () => {
    const backend = new StubBackend();
    const runtime = spyRuntime();
    const store = new InMemoryPublishStore();
    const policy: CommandPolicy = {
      ...defaultCommandPolicy(),
      scopeRules: [{ id: 'scope.approve-publish', decision: 'require_approval', reason: 'needs review', match: { kind: 'commandFlag', name: 'publish' } }],
    };
    const handler = createPublishHandler({ sandboxBackend: backend, runtime, store, resolveCommandPolicy: () => policy });
    const result = await runInTurn('personal:u1', () => handler(VALID_INPUT));
    assert.match(result, /requires human approval.*not yet available/);
    assert.match(result, /It was NOT published/);
    assert.equal(backend.provisionCalls.length, 0);
    assert.equal(runtime.deployCalls.length, 0);
    assert.equal(getCommandPolicyMetrics().requireApproval, 1);
  });

  it('fails CLOSED when the command policy resolver throws', async () => {
    const backend = new StubBackend();
    const runtime = spyRuntime();
    const store = new InMemoryPublishStore();
    const handler = createPublishHandler({
      sandboxBackend: backend,
      runtime,
      store,
      resolveCommandPolicy: () => {
        throw new Error('policy backend unreachable');
      },
    });
    const result = await runInTurn('personal:u1', () => handler(VALID_INPUT));
    assert.match(result, /command policy could not be resolved; refusing to run \(fail-closed\)/);
    assert.equal(backend.provisionCalls.length, 0);
    assert.equal(getCommandPolicyMetrics().resolveFailed, 1);
  });

  it('rejects malformed input before any policy check', async () => {
    const backend = new StubBackend();
    const runtime = spyRuntime();
    const store = new InMemoryPublishStore();
    const handler = createPublishHandler({ sandboxBackend: backend, runtime, store });
    const result = await runInTurn('personal:u1', () => handler({ appId: 'Not A Valid Slug!' }));
    assert.match(result, /^Error: invalid publish input/);
    assert.equal(backend.provisionCalls.length, 0);
    assert.equal(getCommandPolicyMetrics().total, 0);
  });
});

describe('publish tool — permitted publishes reach the sandbox and the version store', () => {
  it('provisions the turn-scope sandbox, publishes, and returns structured JSON', async () => {
    const backend = new StubBackend({ 'server.js': 'listen()' });
    const runtime = spyRuntime();
    const store = new InMemoryPublishStore();
    const handler = createPublishHandler({ sandboxBackend: backend, runtime, store });
    const raw = await runInTurn('personal:u1', () => handler(VALID_INPUT));
    assert.equal(backend.provisionCalls.length, 1);
    assert.equal(backend.provisionCalls[0]!.scopeKey, 'personal:u1');
    assert.equal(runtime.deployCalls.length, 1);
    const parsed = JSON.parse(raw) as { appId: string; version: number; dirHash: string; createdAt: string };
    assert.equal(parsed.appId, 'todo-app');
    assert.equal(parsed.version, 1);
    assert.ok(parsed.dirHash.length > 0);
    assert.equal((await store.getPointer('todo-app'))!.currentVersion, 1);
    assert.equal(getCommandPolicyMetrics().allowed, 1);
  });

  it('a second publish creates version 2', async () => {
    const backend = new StubBackend({ 'server.js': 'v2' });
    const runtime = spyRuntime();
    const store = new InMemoryPublishStore();
    await store.createVersion({ appId: 'todo-app', name: 'Todo', entrypoint: 'server.js', dirHash: 'h1', sourceScopeKey: 'personal:u1', now: new Date() });
    const handler = createPublishHandler({ sandboxBackend: backend, runtime, store });
    const raw = await runInTurn('personal:u1', () => handler(VALID_INPUT));
    const parsed = JSON.parse(raw) as { version: number };
    assert.equal(parsed.version, 2);
  });

  it('falls back to a turn-unique scope key for an unscoped turn', async () => {
    const backend = new StubBackend();
    const runtime = spyRuntime();
    const store = new InMemoryPublishStore();
    const handler = createPublishHandler({ sandboxBackend: backend, runtime, store });
    await runInTurn(undefined, () => handler(VALID_INPUT));
    assert.match(backend.provisionCalls[0]!.scopeKey, /^unscoped:turn-1$/);
  });

  it('surfaces a missing entrypoint as a tool-result Error, not a thrown exception, and never deploys', async () => {
    const backend = new StubBackend({ 'index.html': '<html></html>' });
    const runtime = spyRuntime();
    const store = new InMemoryPublishStore();
    const handler = createPublishHandler({ sandboxBackend: backend, runtime, store });
    const result = await runInTurn('personal:u1', () => handler(VALID_INPUT));
    assert.match(result, /^Error: publish —/);
    assert.match(result, /entrypoint/);
    assert.equal(runtime.deployCalls.length, 0);
  });

  it('surfaces a sandbox provisioning failure as a tool-result Error', async () => {
    const runtime = spyRuntime();
    const store = new InMemoryPublishStore();
    const backend: SandboxBackend = {
      async provision() {
        throw new Error('docker not available');
      },
    };
    const handler = createPublishHandler({ sandboxBackend: backend, runtime, store });
    const result = await runInTurn('personal:u1', () => handler(VALID_INPUT));
    assert.match(result, /^Error: publish — docker not available/);
  });
});
