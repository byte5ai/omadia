import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  guardToolCommands,
  extractCommandArguments,
  type CommandPolicyProvider,
} from '../packages/harness-orchestrator/src/commandPolicyGuard.js';
import { turnContext } from '../packages/harness-orchestrator/src/turnContext.js';
import {
  defaultCommandPolicy,
  MAX_SUBSTITUTION_DEPTH,
  type CommandPolicy,
} from '../packages/harness-channel-sdk/src/commandPolicy.js';

/** Run `fn` inside a minimal turn with the given command-policy provider. */
function withPolicy<T>(
  provider: CommandPolicyProvider | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return turnContext.run(
    { turnId: 't1', turnDate: '2026-08-18', ...(provider ? { commandPolicy: provider } : {}) },
    fn,
  );
}

describe('#580 extractCommandArguments', () => {
  it('picks top-level command-shaped string fields, ignores the rest', () => {
    assert.deepEqual(extractCommandArguments({ command: 'ls' }), ['ls']);
    assert.deepEqual(extractCommandArguments({ script: 'echo hi', cmd: 'pwd' }), ['pwd', 'echo hi']);
    assert.deepEqual(extractCommandArguments({ query: 'select 1' }), []);
    assert.deepEqual(extractCommandArguments({ command: '   ' }), []); // blank ignored
    assert.deepEqual(extractCommandArguments({ command: 42 }), []); // non-string ignored
    assert.deepEqual(extractCommandArguments('rm -rf /'), []); // not an object
    assert.deepEqual(extractCommandArguments(null), []);
  });
});

describe('#580 guard is honest-inert (AC7)', () => {
  it('no provider installed → proceed (undefined), even for a floored command', async () => {
    const r = await withPolicy(undefined, () => guardToolCommands('exec', { command: 'rm -rf /' }));
    assert.equal(r, undefined);
  });

  it('provider installed but tool input carries no command → proceed', async () => {
    const r = await withPolicy(
      () => defaultCommandPolicy(),
      () => guardToolCommands('get_chat_participants', { foo: 'bar' }),
    );
    assert.equal(r, undefined);
  });

  it('provider returns undefined (opted in, nothing resolved) → proceed', async () => {
    const r = await withPolicy(
      () => undefined,
      () => guardToolCommands('exec', { command: 'rm -rf /' }),
    );
    assert.equal(r, undefined);
  });
});

describe('#580 guard enforces once a policy is installed (AC8)', () => {
  it('denies a floored command with a policy-boundary refusal', async () => {
    const r = await withPolicy(
      () => defaultCommandPolicy(),
      () => guardToolCommands('exec', { command: 'rm -rf /' }),
    );
    assert.ok(typeof r === 'string');
    assert.match(r as string, /refused by the command policy/);
    assert.match(r as string, /recursive delete/);
    assert.match(r as string, /policy boundary, not a transient failure/);
  });

  it('allows a command no rule denies', async () => {
    const r = await withPolicy(
      () => defaultCommandPolicy(),
      () => guardToolCommands('exec', { command: 'ls -la' }),
    );
    assert.equal(r, undefined);
  });

  it('require_approval fails safe to a refusal while no approval gate exists', async () => {
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
    const r = await withPolicy(
      () => policy,
      () => guardToolCommands('exec', { command: 'npm install lodash' }),
    );
    assert.ok(typeof r === 'string');
    assert.match(r as string, /requires human approval, which is not yet available/);
  });

  it('a command whose normalization truncated is refused, not cleared', async () => {
    // Nest $(…) past the depth cap so the inner (floored) command is invisible;
    // the guard must refuse on the truncated signal rather than fall through to
    // the permissive default.
    let raw = 'rm -rf /';
    for (let d = 0; d <= MAX_SUBSTITUTION_DEPTH; d += 1) raw = `$(${raw})`;
    const r = await withPolicy(
      () => defaultCommandPolicy(),
      () => guardToolCommands('exec', { command: raw }),
    );
    assert.ok(typeof r === 'string');
    assert.match(r as string, /could not be fully normalized/);
    assert.match(r as string, /policy boundary, not a transient failure/);
  });

  it('a provider that throws fails safe to a refusal', async () => {
    const r = await withPolicy(
      () => {
        throw new Error('policy store unreachable');
      },
      () => guardToolCommands('exec', { command: 'ls' }),
    );
    assert.ok(typeof r === 'string');
    assert.match(r as string, /could not be resolved/);
    assert.match(r as string, /policy store unreachable/);
  });
});
