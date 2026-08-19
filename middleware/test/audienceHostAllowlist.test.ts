/**
 * #575 — the allow-list half of host egress.
 *
 * `floorDeniesHost` (#740) narrows a plugin's manifest list by prohibitions.
 * This is the other direction: when a deployment opts in, a host must ALSO be
 * granted through the floor, and the grants intersect across the room.
 *
 * The cases worth pinning are the ones where an intuitive implementation is
 * wrong in a way nobody notices:
 *
 *  - **a prohibition must beat `net:*`.** The unrestricted grant is a
 *    convenience so operators need not enumerate hosts; if it also overrode an
 *    explicit veto, the veto would be worth nothing — and `net:*` is exactly
 *    the grant a broad role is most likely to carry.
 *  - **`net:*` must intersect like any other capability.** One host-restricted
 *    participant restricts the room. Special-casing it as "somebody is
 *    unrestricted, so the room is" inverts the floor.
 *  - **a room where nobody holds host grants reaches nothing** once the
 *    allow-list is on. That is correct and it is also the reason the mode is
 *    off by default.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  UNRESTRICTED_HOST_CAPABILITY,
  audienceFloor,
  floorAllowsHost,
  floorDeniesHost,
  hostCapability,
  type Audience,
  type Capability,
  type Principal,
} from '../packages/harness-channel-sdk/src/index.js';

const ALICE: Principal = { kind: 'user', userId: 'alice' };
const BOB: Principal = { kind: 'user', userId: 'bob' };

function room(
  alice: { allow?: Capability[]; deny?: Capability[] },
  bob: { allow?: Capability[]; deny?: Capability[] } = {},
): Audience {
  const mk = (principal: Principal, spec: { allow?: Capability[]; deny?: Capability[] }) => ({
    kind: 'resolved' as const,
    principal,
    capabilities: new Set(spec.allow ?? []),
    denials: new Set(spec.deny ?? []),
  });
  return { kind: 'known', members: [mk(ALICE, alice), mk(BOB, bob)] };
}

const API = hostCapability('api.example.com');
const OTHER = hostCapability('other.example.com');

describe('#575 floorAllowsHost — the intersection reading', () => {
  it('allows a host both participants were granted', () => {
    const floor = audienceFloor(room({ allow: [API] }, { allow: [API] }));
    assert.equal(floorAllowsHost(floor, 'api.example.com'), true);
  });

  it('refuses a host only one participant was granted', () => {
    const floor = audienceFloor(room({ allow: [API] }, { allow: [OTHER] }));
    assert.equal(floorAllowsHost(floor, 'api.example.com'), false);
    assert.equal(floorAllowsHost(floor, 'other.example.com'), false);
  });

  it('refuses everything when nobody holds host grants', () => {
    // Correct under the intersection, and precisely why the mode is opt-in:
    // switching it on without seeding grants bounds every room to nothing.
    const floor = audienceFloor(room({}, {}));
    assert.equal(floorAllowsHost(floor, 'api.example.com'), false);
  });

  it('lower-cases the host, matching hostCapability', () => {
    const floor = audienceFloor(room({ allow: [API] }, { allow: [API] }));
    assert.equal(floorAllowsHost(floor, 'API.Example.COM'), true);
  });

  it('a closed floor allows nothing', () => {
    const closed = audienceFloor({ kind: 'unknown', reason: 'no_provider' });
    assert.equal(floorAllowsHost(closed, 'api.example.com'), false);
  });
});

describe('#575 net:* — the escape hatch, and its limits', () => {
  it('allows any host when EVERY participant is unrestricted', () => {
    const floor = audienceFloor(
      room({ allow: [UNRESTRICTED_HOST_CAPABILITY] }, { allow: [UNRESTRICTED_HOST_CAPABILITY] }),
    );
    assert.equal(floorAllowsHost(floor, 'anything.example.com'), true);
  });

  it('does NOT allow when only one participant is unrestricted', () => {
    // net:* is an ordinary capability and intersects like one. Treating it as
    // "somebody is unrestricted, so the room is" would invert the floor.
    const floor = audienceFloor(room({ allow: [UNRESTRICTED_HOST_CAPABILITY] }, { allow: [API] }));
    assert.equal(floorAllowsHost(floor, 'anything.example.com'), false);
    // …and the named host Bob holds is not rescued either: Alice does not
    // carry it, so the intersection drops it.
    assert.equal(floorAllowsHost(floor, 'api.example.com'), false);
  });

  it('a prohibition beats net:*', () => {
    // The one thing a veto must survive. net:* is what a broad role is most
    // likely to carry, so if it overrode prohibitions the veto would be
    // worthless exactly where it matters.
    const floor = audienceFloor(
      room(
        { allow: [UNRESTRICTED_HOST_CAPABILITY], deny: [API] },
        { allow: [UNRESTRICTED_HOST_CAPABILITY] },
      ),
    );
    assert.equal(floorAllowsHost(floor, 'other.example.com'), true);
    assert.equal(floorAllowsHost(floor, 'api.example.com'), false);
  });
});

describe('#575 the two readings stay distinct', () => {
  it('a host nobody granted is NOT denied — it is merely not allowed', () => {
    // The distinction #740 introduced `denied` for. Under prohibitions-only
    // this host is reachable (the manifest decides); under the allow-list it is
    // not. Collapsing the two readings would silently change every deployment.
    const floor = audienceFloor(room({}, {}));
    assert.equal(floorDeniesHost(floor, 'api.example.com'), false, 'not forbidden');
    assert.equal(floorAllowsHost(floor, 'api.example.com'), false, 'but not granted either');
  });
});
