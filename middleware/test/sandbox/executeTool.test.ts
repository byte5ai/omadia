import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { defaultCommandPolicy, MAX_SUBSTITUTION_DEPTH, type CommandPolicy } from '../../packages/harness-channel-sdk/src/commandPolicy.js';
import { resolveAgentComputerProfile } from '../../packages/harness-sandbox/src/agentComputerProfile.js';
import type {
  Sandbox,
  SandboxBackend,
  SandboxRunOptions,
  SandboxRunResult,
} from '../../packages/harness-sandbox/src/sandbox.js';
import {
  createExecuteHandler,
  type ExecuteToolAuditEvent,
} from '../../packages/harness-orchestrator/src/tools/executeTool.js';
import { turnContext } from '../../packages/harness-orchestrator/src/turnContext.js';
import {
  getCommandPolicyMetrics,
  resetCommandPolicyMetrics,
} from '../../packages/harness-orchestrator/src/commandPolicyMetrics.js';

/**
 * #576 P2 — `execute` tool tests.
 *
 * Every test proves the SECURITY BOUNDARY property first (a denied/
 * approval-needed/unresolvable-policy command never reaches
 * `SandboxBackend.provision`), then the sandbox-plumbing property (a
 * permitted command DOES reach it, with the right scope key and run
 * options).
 */

class StubBackend implements SandboxBackend {
  readonly provisionCalls: Array<{ scopeKey: string }> = [];
  readonly runCalls: Array<{ command: string; options: SandboxRunOptions | undefined }> = [];
  runResult: SandboxRunResult = {
    exitCode: 0,
    stdout: 'ok\n',
    stderr: '',
    durationMs: 5,
    timedOut: false,
    outputTruncated: false,
  };

  async provision(args: { scopeKey: string }): Promise<Sandbox> {
    this.provisionCalls.push({ scopeKey: args.scopeKey });
    const self = this;
    return {
      id: 'stub-sandbox',
      scopeKey: args.scopeKey,
      profile: resolveAgentComputerProfile(),
      async run(command, options) {
        self.runCalls.push({ command, options });
        return self.runResult;
      },
      async read() {
        throw new Error('not used in this test');
      },
      async write() {
        throw new Error('not used in this test');
      },
      async list() {
        throw new Error('not used in this test');
      },
      async teardown() {
        /* no-op */
      },
    };
  }
}

function runInTurn<T>(sessionScope: string | undefined, fn: () => Promise<T>): Promise<T> {
  return turnContext.run({ turnId: 'turn-1', turnDate: '2026-08-20', ...(sessionScope !== undefined ? { sessionScope } : {}) }, fn);
}

beforeEach(() => {
  resetCommandPolicyMetrics();
});

describe('execute tool — org-floor policy check runs before any sandbox call', () => {
  it('denies a floored command (rm -rf) without ever calling provision', async () => {
    const backend = new StubBackend();
    const events: ExecuteToolAuditEvent[] = [];
    const handler = createExecuteHandler({ backend, auditSink: (e) => events.push(e) });
    const result = await runInTurn('personal:u1', () => handler({ command: 'rm -rf /' }));
    assert.match(result, /^Error: execute — refused by the command policy/);
    assert.match(result, /recursive delete/);
    assert.equal(backend.provisionCalls.length, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, 'denied');
    assert.equal(getCommandPolicyMetrics().denied, 1);
  });

  it('denies a force-push without calling provision', async () => {
    const backend = new StubBackend();
    const handler = createExecuteHandler({ backend });
    const result = await runInTurn('personal:u1', () => handler({ command: 'git push --force origin main' }));
    assert.match(result, /force-pushing/);
    assert.equal(backend.provisionCalls.length, 0);
  });

  it('refuses (does not silently escalate) a require_approval decision', async () => {
    const backend = new StubBackend();
    const policy: CommandPolicy = {
      ...defaultCommandPolicy(),
      scopeRules: [
        {
          id: 'scope.approve-npm',
          decision: 'require_approval',
          reason: 'npm needs review',
          match: { kind: 'commandFlag', name: 'npm' },
        },
      ],
    };
    const handler = createExecuteHandler({ backend, resolveCommandPolicy: () => policy });
    const result = await runInTurn('personal:u1', () => handler({ command: 'npm install lodash' }));
    assert.match(result, /requires human approval.*not yet available/);
    assert.match(result, /It was NOT run/);
    assert.equal(backend.provisionCalls.length, 0);
    assert.equal(getCommandPolicyMetrics().requireApproval, 1);
  });

  it('refuses a command whose normalization truncated, without calling provision', async () => {
    const backend = new StubBackend();
    let raw = 'echo x';
    for (let d = 0; d <= MAX_SUBSTITUTION_DEPTH; d += 1) raw = `$(${raw})`;
    const handler = createExecuteHandler({ backend });
    const result = await runInTurn('personal:u1', () => handler({ command: raw }));
    assert.match(result, /could not be fully normalized/);
    assert.equal(backend.provisionCalls.length, 0);
    assert.equal(getCommandPolicyMetrics().truncated, 1);
  });

  it('fails CLOSED when the command policy resolver throws — refuses, does not run', async () => {
    const backend = new StubBackend();
    const handler = createExecuteHandler({
      backend,
      resolveCommandPolicy: () => {
        throw new Error('policy backend unreachable');
      },
    });
    const result = await runInTurn('personal:u1', () => handler({ command: 'ls -la' }));
    assert.match(result, /command policy could not be resolved; refusing to run \(fail-closed\)/);
    assert.match(result, /policy backend unreachable/);
    assert.equal(backend.provisionCalls.length, 0);
    assert.equal(getCommandPolicyMetrics().resolveFailed, 1);
  });

  it('rejects malformed input before any policy check', async () => {
    const backend = new StubBackend();
    const handler = createExecuteHandler({ backend });
    const result = await runInTurn('personal:u1', () => handler({}));
    assert.match(result, /^Error: invalid execute input/);
    assert.equal(backend.provisionCalls.length, 0);
    assert.equal(getCommandPolicyMetrics().total, 0);
  });
});

describe('execute tool — permitted commands reach the sandbox', () => {
  it('provisions the scope sandbox and runs the command, returning structured JSON', async () => {
    const backend = new StubBackend();
    const handler = createExecuteHandler({ backend });
    const raw = await runInTurn('personal:u1', () => handler({ command: 'echo hello', cwd: 'proj', timeoutSeconds: 30 }));
    assert.equal(backend.provisionCalls.length, 1);
    assert.equal(backend.provisionCalls[0]!.scopeKey, 'personal:u1');
    assert.equal(backend.runCalls.length, 1);
    assert.equal(backend.runCalls[0]!.command, 'echo hello');
    assert.deepEqual(backend.runCalls[0]!.options, { cwd: 'proj', timeoutSeconds: 30 });
    const parsed = JSON.parse(raw) as { exitCode: number; stdout: string };
    assert.equal(parsed.exitCode, 0);
    assert.equal(parsed.stdout, 'ok\n');
    assert.equal(getCommandPolicyMetrics().allowed, 1);
  });

  it('falls back to a turn-unique scope key for an unscoped turn (does not share a bucket)', async () => {
    const backend = new StubBackend();
    const handler = createExecuteHandler({ backend });
    await runInTurn(undefined, () => handler({ command: 'echo hi' }));
    assert.equal(backend.provisionCalls.length, 1);
    assert.match(backend.provisionCalls[0]!.scopeKey, /^unscoped:turn-1$/);
  });

  it('surfaces a sandbox provisioning failure as a tool-result Error, not a thrown exception', async () => {
    const backend: SandboxBackend = {
      async provision() {
        throw new Error('docker not available');
      },
    };
    const handler = createExecuteHandler({ backend });
    const result = await runInTurn('personal:u1', () => handler({ command: 'echo hi' }));
    assert.match(result, /^Error: execute — sandbox failure: docker not available/);
  });
});
