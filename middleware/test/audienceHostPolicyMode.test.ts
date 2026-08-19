/**
 * #575 — the host-policy MODE switch actually switches something.
 *
 * `audienceHostPolicy.audienceDeniesHost` reads two flags and picks between two
 * readings of the same floor:
 *
 *  - prohibitions only (the default): a host is refused when explicitly denied;
 *  - allow-list: a host is refused unless the room was granted it.
 *
 * A flag that is declared, documented and never consulted is a defect this repo
 * has shipped before, and here it would be invisible in the worst direction —
 * an operator switching the allow-list on would believe egress is now bounded
 * while every manifest host stayed reachable. So the switch is exercised
 * end-to-end rather than assumed.
 *
 * ## Two traps this file walked into first, worth recording
 *
 * 1. **`turnContext` must be imported the way the module under test imports
 *    it.** `audienceHostPolicy` resolves `@omadia/orchestrator` (the built
 *    package); a test importing `../packages/harness-orchestrator/src/…` gets a
 *    DIFFERENT AsyncLocalStorage instance, so the provider it installs is
 *    invisible to the code under test and every verdict silently becomes "no
 *    provider ⇒ not enforced". The tests still pass wherever `false` is the
 *    expected answer, which is exactly how this stays hidden.
 *
 * 2. **`config` is parsed once at import**, so setting `process.env` before a
 *    cache-busted re-import does not change it — the second import gets fresh
 *    module code and the same cached config. The flags are therefore set on the
 *    config object itself, which is what `allowlistMode()` actually reads.
 */

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import { turnContext } from '@omadia/orchestrator';

import {
  audienceFloor,
  hostCapability,
  type Audience,
  type AudienceFloor,
  type Capability,
  type Principal,
} from '../packages/harness-channel-sdk/src/index.js';
import { config } from '../src/config.js';
import { audienceDeniesHost } from '../src/platform/audienceHostPolicy.js';

const ALICE: Principal = { kind: 'user', userId: 'alice' };

const original = {
  floor: config.AUDIENCE_FLOOR_ENABLED,
  allowlist: config.AUDIENCE_HOST_ALLOWLIST_ENABLED,
};

afterEach(() => {
  setFlags(original.floor, original.allowlist);
});

function setFlags(floor: boolean, allowlist: boolean): void {
  (config as { AUDIENCE_FLOOR_ENABLED: boolean }).AUDIENCE_FLOOR_ENABLED = floor;
  (config as { AUDIENCE_HOST_ALLOWLIST_ENABLED: boolean }).AUDIENCE_HOST_ALLOWLIST_ENABLED =
    allowlist;
}

function floorWith(allow: Capability[], deny: Capability[]): AudienceFloor {
  const audience: Audience = {
    kind: 'known',
    members: [
      {
        kind: 'resolved',
        principal: ALICE,
        capabilities: new Set(allow),
        denials: new Set(deny),
      },
    ],
  };
  return audienceFloor(audience);
}

async function ask(floor: AudienceFloor, host: string): Promise<boolean> {
  return turnContext.run(
    { turnId: 't', turnDate: '2026-08-19', audienceFloor: async () => floor },
    () => audienceDeniesHost(host),
  );
}

describe('#575 host-policy mode switch', () => {
  it('prohibitions-only: an ungranted host is reachable', async () => {
    // The manifest decides. This is the shipped default, and it is what keeps
    // #740 from changing any existing deployment.
    setFlags(true, false);
    assert.equal(await ask(floorWith([], []), 'api.example.com'), false);
  });

  it('prohibitions-only: an explicitly denied host is refused', async () => {
    setFlags(true, false);
    assert.equal(
      await ask(floorWith([], [hostCapability('api.example.com')]), 'api.example.com'),
      true,
    );
  });

  it('allow-list: the same ungranted host is refused', async () => {
    // Same floor, same host, opposite verdict — the whole point of the flag,
    // and what a declared-but-unread flag would fail to produce.
    setFlags(true, true);
    assert.equal(await ask(floorWith([], []), 'api.example.com'), true);
  });

  it('allow-list: a granted host is reachable again', async () => {
    setFlags(true, true);
    assert.equal(
      await ask(floorWith([hostCapability('api.example.com')], []), 'api.example.com'),
      false,
    );
  });

  it('the allow-list flag alone does nothing without the floor', async () => {
    // Honouring it on its own would refuse every outbound call in a deployment
    // that never opted into audience control at all.
    setFlags(false, true);
    assert.equal(await ask(floorWith([], []), 'api.example.com'), false);
  });

  it('no provider installed ⇒ not enforced, in either mode', async () => {
    setFlags(true, true);
    const verdict = await turnContext.run({ turnId: 't', turnDate: '2026-08-19' }, () =>
      audienceDeniesHost('api.example.com'),
    );
    assert.equal(verdict, false);
  });

  it('a throwing provider refuses — the deployment opted in', async () => {
    setFlags(true, false);
    const verdict = await turnContext.run(
      {
        turnId: 't',
        turnDate: '2026-08-19',
        audienceFloor: async () => {
          throw new Error('directory down');
        },
      },
      () => audienceDeniesHost('api.example.com'),
    );
    assert.equal(verdict, true);
  });
});
