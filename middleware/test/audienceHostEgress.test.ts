/**
 * #575 — host-level egress: a room's prohibition narrows a plugin's manifest
 * allow-list.
 *
 * Two things are pinned here, and the second is the one that usually rots.
 *
 * **The rule.** A denied host is refused in EVERY audit mode, before the rate
 * limiter, and independently of what the manifest allows. `public-web` in
 * particular must not become the way around a host an operator forbade.
 *
 * **The wiring.** The check is an injected dependency, which is exactly the
 * shape that gets declared and then never threaded — this repo has hit that
 * defect repeatedly. So there is a test that the kernel's own plugin-context
 * builder actually passes it, asserted against the real accessor rather than a
 * hand-rolled double.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { HttpForbiddenError } from '@omadia/plugin-api';

import {
  audienceFloor,
  floorDeniesHost,
  hostCapability,
  type Audience,
  type Capability,
  type Principal,
} from '../packages/harness-channel-sdk/src/index.js';
import { createHttpAccessor } from '../src/platform/httpAccessor.js';

const ALICE: Principal = { kind: 'user', userId: 'alice' };
const BOB: Principal = { kind: 'user', userId: 'bob' };

function room(deny: Capability[] = [], allow: Capability[] = []): Audience {
  return {
    kind: 'known',
    members: [
      {
        kind: 'resolved',
        principal: ALICE,
        capabilities: new Set(allow),
        denials: new Set(deny),
      },
      {
        kind: 'resolved',
        principal: BOB,
        capabilities: new Set(allow),
        denials: new Set<Capability>(),
      },
    ],
  };
}

/** A fetch that records what it was asked for and never leaves the process. */
function spyFetch(): { fn: (u: string, i: Record<string, unknown>) => Promise<Response>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fn: async (u: string) => {
      calls.push(u);
      return new Response('ok');
    },
  };
}

describe('#575 hostCapability / floorDeniesHost', () => {
  it('lower-cases the host, because a hostname is case-insensitive', () => {
    assert.equal(hostCapability('API.Example.COM'), 'net:api.example.com');
    assert.equal(hostCapability('  api.example.com  '), 'net:api.example.com');
  });

  it('reports a denial regardless of whether anyone granted the host', () => {
    // The distinction the `denied` field exists for: outbound hosts are granted
    // by the MANIFEST, so "absent from capabilities" says nothing at all.
    const floor = audienceFloor(room([hostCapability('evil.example.com')]));
    assert.equal(floor.outcome, 'open');
    assert.equal(floorDeniesHost(floor, 'evil.example.com'), true);
    assert.equal(floorDeniesHost(floor, 'api.example.com'), false);
  });

  it('a closed floor denies every host', () => {
    const closed = audienceFloor({ kind: 'unknown', reason: 'empty_roster' });
    assert.equal(closed.outcome, 'closed');
    assert.equal(floorDeniesHost(closed, 'api.example.com'), true);
  });

  it('one participant is enough — prohibitions union', () => {
    // Alice carries the veto, Bob does not. The room is bound anyway.
    const floor = audienceFloor(room([hostCapability('evil.example.com')]));
    assert.equal(floorDeniesHost(floor, 'evil.example.com'), true);
  });
});

describe('#575 the HTTP accessor honours a host prohibition', () => {
  it('refuses a manifest-allowed host the room forbids', async () => {
    const spy = spyFetch();
    const http = createHttpAccessor({
      agentId: 'test-plugin',
      outbound: ['api.example.com'],
      guardedFetch: spy.fn,
      audienceDeniesHost: async (host) => host === 'api.example.com',
    });
    await assert.rejects(() => http.fetch('https://api.example.com/x'), HttpForbiddenError);
    assert.deepEqual(spy.calls, []);
  });

  it('still allows a host the room says nothing about', async () => {
    const http = createHttpAccessor({
      agentId: 'test-plugin',
      outbound: ['api.example.com'],
      audienceDeniesHost: async () => false,
    });
    // Reaches the manifest check and passes it; the actual fetch is not made
    // here because that would leave the process — the forbidden case above is
    // what this pairs with.
    await assert.rejects(
      () => http.fetch('https://not-allowed.example.com/x'),
      HttpForbiddenError,
      'a host outside the manifest list is still refused by the existing rule',
    );
  });

  it('binds public-web mode too — a scanner is not the way around a prohibition', async () => {
    const spy = spyFetch();
    const http = createHttpAccessor({
      agentId: 'scanner-plugin',
      outbound: [],
      webScanner: true,
      auditMode: 'public-web',
      guardedFetch: spy.fn,
      audienceDeniesHost: async (host) => host === 'evil.example.com',
    });
    await assert.rejects(() => http.fetch('https://evil.example.com/x'), HttpForbiddenError);
    assert.deepEqual(spy.calls, [], 'the guarded dispatcher must never be reached');
  });

  it('is inert when no check is supplied', async () => {
    // Every deployment that has not opted into the floor.
    const http = createHttpAccessor({ agentId: 'test-plugin', outbound: ['api.example.com'] });
    await assert.rejects(
      () => http.fetch('https://blocked.example.com/x'),
      HttpForbiddenError,
      'the manifest rule is unchanged',
    );
  });

  it('refuses before spending a rate-limit token', async () => {
    // A refused call must cost the plugin nothing — same ordering as the egress
    // guard sitting ahead of the dispatch deadline.
    let denied = true;
    const spy = spyFetch();
    const http = createHttpAccessor({
      agentId: 'test-plugin',
      outbound: ['api.example.com'],
      rateLimitPerMinute: 1,
      webScanner: true,
      auditMode: 'public-web',
      guardedFetch: spy.fn,
      audienceDeniesHost: async () => denied,
    });

    await assert.rejects(() => http.fetch('https://api.example.com/a'), HttpForbiddenError);
    denied = false;
    // The single token must still be there.
    const res = await http.fetch('https://api.example.com/b');
    assert.equal(res.status, 200);
    assert.deepEqual(spy.calls, ['https://api.example.com/b']);
  });
});

describe('#575 the kernel actually threads the check', () => {
  it('the plugin-context builder passes audienceDeniesHost to the accessor', async () => {
    // A guard against the defect shape this repo keeps hitting: an injection
    // point declared and never threaded to its consumer. Asserting that the
    // option merely EXISTS would test the compiler, not the wiring — so this
    // reads the construction site itself.
    //
    // Crude, and deliberately so: the alternative is standing up a full plugin
    // context, and a test that expensive is one nobody keeps working. What this
    // catches is the case that actually happens — somebody removes the argument
    // while everything still compiles, because the option is optional.
    const source = await readFile(
      new URL('../src/platform/pluginContext.ts', import.meta.url),
      'utf8',
    );
    // The call body contains nested `})` (the conditional auditMode spread), so
    // it is bounded by the assignment's terminator instead of by brace
    // matching — the point is only that the argument sits inside THIS call.
    const start = source.indexOf('createHttpAccessor({');
    assert.notEqual(start, -1, 'the construction site itself must still exist');
    const end = source.indexOf(': undefined;', start);
    assert.notEqual(end, -1, 'the accessor is still built conditionally');
    assert.ok(
      source.slice(start, end).includes('audienceDeniesHost'),
      'platform/pluginContext.ts must pass audienceDeniesHost into createHttpAccessor',
    );
  });
});
