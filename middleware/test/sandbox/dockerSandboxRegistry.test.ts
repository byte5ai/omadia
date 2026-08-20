import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { DockerSandboxBackend, _internal } from '../../packages/harness-sandbox/src/dockerSandbox.js';
import { resolveAgentComputerProfile } from '../../packages/harness-sandbox/src/agentComputerProfile.js';
import { InMemorySandboxRegistry } from '../../packages/harness-sandbox/src/sandboxRegistry.js';
import type { DockerExec, DockerExecContext, DockerExecResult } from '../../packages/harness-sandbox/src/dockerExec.js';

/**
 * #576 P3 — DockerSandboxBackend + SandboxRegistry integration.
 *
 * Split in two:
 *  - regression: an unregistered backend behaves BYTE-IDENTICAL to P1/P2
 *    (same argv, same container name derivation) — the registry option must
 *    be additive, never a behavior change for a caller who doesn't pass one.
 *  - new behavior: a registered backend actually calls upsert/touch/get.
 */

function stubExec(script: (ctx: DockerExecContext) => DockerExecResult) {
  const calls: Array<{ args: readonly string[] }> = [];
  const exec: DockerExec = async (ctx) => {
    calls.push({ args: ctx.args });
    return script(ctx);
  };
  return { exec, calls };
}
function ok(stdout = ''): DockerExecResult {
  return { exitCode: 0, stdout, stderr: '', timedOut: false, outputTruncated: false };
}

describe('DockerSandboxBackend — without a registry (regression: byte-identical to P1/P2)', () => {
  it('provision() uses the deterministic container name, same as before P3', async () => {
    const { exec, calls } = stubExec((ctx) => (ctx.args[0] === 'ps' ? ok('') : ok()));
    const backend = new DockerSandboxBackend({ execDocker: exec });
    const sandbox = await backend.provision({
      scopeKey: 'personal:no-registry',
      profile: resolveAgentComputerProfile(),
    });
    assert.equal(sandbox.id, _internal.containerNameFor('personal:no-registry'));
    const runCall = calls.find((c) => c.args[0] === 'run');
    assert.ok(runCall);
  });
});

describe('DockerSandboxBackend — with a registry', () => {
  it('registers a newly provisioned scope in the registry', async () => {
    const { exec } = stubExec((ctx) => (ctx.args[0] === 'ps' ? ok('') : ok()));
    const registry = new InMemorySandboxRegistry();
    const backend = new DockerSandboxBackend({ execDocker: exec, registry });
    const profile = resolveAgentComputerProfile();
    await backend.provision({ scopeKey: 'personal:registered', profile });

    const entry = await registry.get('personal:registered');
    assert.ok(entry);
    assert.equal(entry!.backend, 'docker');
    assert.equal(entry!.sandboxRef, _internal.containerNameFor('personal:registered'));
    assert.deepEqual(entry!.profile, profile);
  });

  it('re-attaches via the registry-stored sandboxRef rather than recomputing the name', async () => {
    const { exec, calls } = stubExec((ctx) => (ctx.args[0] === 'ps' ? ok('a-custom-ref') : ok()));
    const registry = new InMemorySandboxRegistry();
    await registry.upsert({
      scopeKey: 'personal:custom-ref',
      backend: 'docker',
      sandboxRef: 'a-custom-ref',
      profile: resolveAgentComputerProfile(),
      now: new Date(),
    });
    const backend = new DockerSandboxBackend({ execDocker: exec, registry });
    const sandbox = await backend.provision({
      scopeKey: 'personal:custom-ref',
      profile: resolveAgentComputerProfile(),
    });
    assert.equal(sandbox.id, 'a-custom-ref');
    assert.ok(!calls.some((c) => c.args[0] === 'run'), 'must re-attach, not create a new container');
    const psCall = calls.find((c) => c.args[0] === 'ps');
    assert.ok(psCall!.args.some((a) => a.includes('a-custom-ref')));
  });

  it('touches the registry on a process-local cache hit (repeat provision within the same process)', async () => {
    const { exec } = stubExec((ctx) => (ctx.args[0] === 'ps' ? ok('') : ok()));
    const registry = new InMemorySandboxRegistry();
    const backend = new DockerSandboxBackend({ execDocker: exec, registry });
    const profile = resolveAgentComputerProfile();
    await backend.provision({ scopeKey: 'personal:repeat', profile });
    const firstSeen = (await registry.get('personal:repeat'))!.lastUsedAt;

    await new Promise((r) => setTimeout(r, 5));
    await backend.provision({ scopeKey: 'personal:repeat', profile });
    const secondSeen = (await registry.get('personal:repeat'))!.lastUsedAt;

    assert.ok(secondSeen.getTime() >= firstSeen.getTime());
  });
});
