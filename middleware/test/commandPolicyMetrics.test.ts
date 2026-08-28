import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  getCommandPolicyMetrics,
  recordCommandPolicyOutcome,
  resetCommandPolicyMetrics,
} from '../packages/harness-orchestrator/src/commandPolicyMetrics.js';
import { guardToolCommands } from '../packages/harness-orchestrator/src/commandPolicyGuard.js';
import { turnContext } from '../packages/harness-orchestrator/src/turnContext.js';
import { defaultCommandPolicy, type CommandPolicy } from '../packages/harness-channel-sdk/src/commandPolicy.js';

/**
 * #576 P2 — "count, don't just log" (#749/#750 pattern) applied to the
 * command policy gate. Two tiers:
 *  - the counter module itself (pure, no turn context needed)
 *  - `guardToolCommands` actually calling it on every real decision branch
 */

beforeEach(() => {
  resetCommandPolicyMetrics();
});

describe('commandPolicyMetrics — counter module', () => {
  it('starts at zero', () => {
    const m = getCommandPolicyMetrics();
    assert.deepEqual(m, {
      total: 0,
      allowed: 0,
      denied: 0,
      requireApproval: 0,
      truncated: 0,
      resolveFailed: 0,
      byRuleId: {},
    });
  });

  it('tallies each outcome kind independently and totals them', () => {
    recordCommandPolicyOutcome('allowed');
    recordCommandPolicyOutcome('denied', 'floor.rm-recursive');
    recordCommandPolicyOutcome('denied', 'floor.rm-recursive');
    recordCommandPolicyOutcome('require_approval', 'scope.approve-npm');
    recordCommandPolicyOutcome('truncated');
    recordCommandPolicyOutcome('resolve_failed');
    const m = getCommandPolicyMetrics();
    assert.equal(m.total, 6);
    assert.equal(m.allowed, 1);
    assert.equal(m.denied, 2);
    assert.equal(m.requireApproval, 1);
    assert.equal(m.truncated, 1);
    assert.equal(m.resolveFailed, 1);
    assert.deepEqual(m.byRuleId, { 'floor.rm-recursive': 2, 'scope.approve-npm': 1 });
  });

  it('a snapshot is a copy — mutating it does not affect the live counters', () => {
    recordCommandPolicyOutcome('denied', 'floor.rm-recursive');
    const snapshot = getCommandPolicyMetrics();
    // @ts-expect-error — intentionally violating readonly to prove isolation.
    snapshot.byRuleId['floor.rm-recursive'] = 999;
    assert.equal(getCommandPolicyMetrics().byRuleId['floor.rm-recursive'], 1);
  });
});

describe('commandPolicyGuard — wired to the metrics module', () => {
  function withPolicy<T>(provider: (() => CommandPolicy | undefined) | undefined, fn: () => Promise<T>): Promise<T> {
    return turnContext.run(
      { turnId: 't1', turnDate: '2026-08-20', ...(provider ? { commandPolicy: provider } : {}) },
      fn,
    );
  }

  it('records "denied" when guardToolCommands refuses a floored command', async () => {
    await withPolicy(() => defaultCommandPolicy(), () => guardToolCommands('exec', { command: 'rm -rf /' }));
    const m = getCommandPolicyMetrics();
    assert.equal(m.denied, 1);
    assert.equal(m.byRuleId['floor.rm-recursive'], 1);
  });

  it('records "allowed" when a command clears the policy', async () => {
    await withPolicy(() => defaultCommandPolicy(), () => guardToolCommands('exec', { command: 'ls -la' }));
    assert.equal(getCommandPolicyMetrics().allowed, 1);
  });

  it('records "resolve_failed" when the provider throws', async () => {
    await withPolicy(
      () => {
        throw new Error('boom');
      },
      () => guardToolCommands('exec', { command: 'ls -la' }),
    );
    assert.equal(getCommandPolicyMetrics().resolveFailed, 1);
  });

  it('records nothing when no provider is installed (honest-inert stays honest-inert)', async () => {
    await withPolicy(undefined, () => guardToolCommands('exec', { command: 'rm -rf /' }));
    assert.equal(getCommandPolicyMetrics().total, 0);
  });

  it('records nothing when the tool input carries no command-shaped field', async () => {
    await withPolicy(() => defaultCommandPolicy(), () => guardToolCommands('get_chat_participants', { foo: 'bar' }));
    assert.equal(getCommandPolicyMetrics().total, 0);
  });
});
