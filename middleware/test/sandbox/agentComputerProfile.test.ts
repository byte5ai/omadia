import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  DEFAULT_AGENT_COMPUTER_PROFILE,
  resolveAgentComputerProfile,
} from '../../packages/harness-sandbox/src/agentComputerProfile.js';

describe('AgentComputerProfile defaults', () => {
  it('defaults to the conservative posture: no persistence, no egress, no process sessions', () => {
    assert.equal(DEFAULT_AGENT_COMPUTER_PROFILE.persistent, false);
    assert.equal(DEFAULT_AGENT_COMPUTER_PROFILE.egress, false);
    assert.equal(DEFAULT_AGENT_COMPUTER_PROFILE.processSessions, false);
    assert.ok(DEFAULT_AGENT_COMPUTER_PROFILE.maxRunSeconds > 0);
    assert.ok(DEFAULT_AGENT_COMPUTER_PROFILE.maxOutputBytes > 0);
  });

  it('resolveAgentComputerProfile merges overrides without mutating the default', () => {
    const custom = resolveAgentComputerProfile({ egress: true, persistent: true });
    assert.equal(custom.egress, true);
    assert.equal(custom.persistent, true);
    // Untouched fields still come from the default.
    assert.equal(custom.processSessions, false);
    assert.equal(custom.maxRunSeconds, DEFAULT_AGENT_COMPUTER_PROFILE.maxRunSeconds);
    // The shared default itself was not mutated by the override call.
    assert.equal(DEFAULT_AGENT_COMPUTER_PROFILE.egress, false);
    assert.equal(DEFAULT_AGENT_COMPUTER_PROFILE.persistent, false);
  });

  it('resolveAgentComputerProfile with no overrides returns the default values', () => {
    const resolved = resolveAgentComputerProfile();
    assert.deepEqual(resolved, DEFAULT_AGENT_COMPUTER_PROFILE);
  });

  it('the shared default is frozen — a caller cannot mutate it in place', () => {
    assert.throws(() => {
      // @ts-expect-error — intentionally violating the readonly contract to
      // prove the runtime freeze, not just the type.
      DEFAULT_AGENT_COMPUTER_PROFILE.egress = true;
    }, TypeError);
  });
});
