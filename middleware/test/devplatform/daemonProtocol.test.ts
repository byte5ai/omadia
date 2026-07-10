import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { toJSONSchema } from 'zod/v4';

import * as mw from '../../src/devplatform/daemonProtocol.js';
import * as daemon from '../../sidecars/dev-runner-daemon/src/protocol.js';

/**
 * Epic #470 W1 — contract test for the daemon <-> middleware control-plane wire
 * protocol (spec §4). Two things are proven:
 *
 *  1. PARITY. The schema is DUPLICATED — once in the middleware
 *     (`src/devplatform/daemonProtocol.ts`) and once in the standalone daemon
 *     package (`sidecars/dev-runner-daemon/src/protocol.ts`), because the daemon
 *     must not import middleware code. This test snapshots BOTH copies to JSON
 *     Schema and deep-diffs them, so drift between the two fails CI.
 *  2. THE `POST /v1/jobs` CLAMP. The request body is EXACTLY
 *     `{ protocol, jobId, leaseTtlSec }`; a body carrying `env`, `image`,
 *     `egressAllowlist`, or `limits` is rejected by the schema itself (review
 *     finding S3). Every request carries `protocol: 1`; a mismatch is rejected
 *     naming both versions.
 */

/** Canonical, order-independent JSON-Schema snapshot of a whole schema map. */
function snapshot(schemas: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(schemas).sort()) {
    // The registry values are zod schemas; toJSONSchema is the canonical form.
    out[key] = toJSONSchema(schemas[key] as Parameters<typeof toJSONSchema>[0]);
  }
  return out;
}

describe('devplatform/daemonProtocol — dual-defined schema parity', () => {
  it('both copies version the same wire protocol', () => {
    assert.equal(mw.DAEMON_PROTOCOL_VERSION, 1);
    assert.equal(daemon.DAEMON_PROTOCOL_VERSION, mw.DAEMON_PROTOCOL_VERSION);
  });

  it('both copies expose the identical set of schema names', () => {
    assert.deepEqual(
      Object.keys(mw.DAEMON_WIRE_SCHEMAS).sort(),
      Object.keys(daemon.DAEMON_WIRE_SCHEMAS).sort(),
    );
  });

  it('every schema is byte-identical across the middleware and daemon copies', () => {
    // This is the drift gate: a field changed on one side alone fails here.
    assert.deepStrictEqual(
      snapshot(mw.DAEMON_WIRE_SCHEMAS),
      snapshot(daemon.DAEMON_WIRE_SCHEMAS),
    );
  });

  it('the CreateJobRequest snapshot pins the exact-keys clamp structurally', () => {
    const schema = toJSONSchema(mw.DAEMON_WIRE_SCHEMAS.CreateJobRequest);
    // additionalProperties:false is what makes "exactly these keys" true.
    assert.equal((schema as { additionalProperties?: unknown }).additionalProperties, false);
    assert.deepEqual(
      ((schema as { required?: string[] }).required ?? []).slice().sort(),
      ['jobId', 'leaseTtlSec', 'protocol'],
    );
    const props = (schema as { properties?: Record<string, { const?: unknown }> }).properties ?? {};
    assert.equal(props.protocol?.const, 1);
  });
});

// Run the same behavioural assertions against BOTH copies so neither can rot.
for (const [label, mod] of [
  ['middleware', mw],
  ['daemon', daemon],
] as const) {
  describe(`devplatform/daemonProtocol — POST /v1/jobs body (${label} copy)`, () => {
    const valid = { protocol: 1, jobId: 'job-abc123', leaseTtlSec: 180 };

    it('accepts exactly { protocol, jobId, leaseTtlSec }', () => {
      const parsed = mod.parseCreateJobRequest(valid);
      assert.deepEqual(parsed, valid);
      assert.equal(mod.CreateJobRequestSchema.safeParse(valid).success, true);
    });

    for (const smuggled of [
      { key: 'env', extra: { env: { SECRET: 'x' } } },
      { key: 'image', extra: { image: 'ghcr.io/evil:latest' } },
      { key: 'egressAllowlist', extra: { egressAllowlist: ['evil.example'] } },
      { key: 'limits', extra: { limits: { memory: '64g' } } },
    ]) {
      it(`rejects a body carrying \`${smuggled.key}\``, () => {
        const body = { ...valid, ...smuggled.extra };
        // Rejected by the schema itself — no handler-side filtering involved.
        assert.equal(mod.CreateJobRequestSchema.safeParse(body).success, false);
        assert.throws(() => mod.parseCreateJobRequest(body));
      });
    }

    it('rejects a missing jobId', () => {
      assert.equal(
        mod.CreateJobRequestSchema.safeParse({ protocol: 1, leaseTtlSec: 180 }).success,
        false,
      );
    });

    it('rejects a non-positive / non-integer leaseTtlSec', () => {
      assert.equal(
        mod.CreateJobRequestSchema.safeParse({ ...valid, leaseTtlSec: 0 }).success,
        false,
      );
      assert.equal(
        mod.CreateJobRequestSchema.safeParse({ ...valid, leaseTtlSec: 1.5 }).success,
        false,
      );
    });

    it('rejects a mismatched protocol version, naming BOTH versions', () => {
      let err: unknown;
      try {
        mod.parseCreateJobRequest({ ...valid, protocol: 2 });
      } catch (e) {
        err = e;
      }
      assert.ok(err instanceof mod.WireProtocolMismatchError, 'expected WireProtocolMismatchError');
      const wp = err as InstanceType<typeof mod.WireProtocolMismatchError>;
      assert.equal(wp.expected, 1);
      assert.equal(wp.received, 2);
      // The message must name both the peer's version and the request's version.
      assert.match(wp.message, /v1\b/);
      assert.match(wp.message, /v2\b/);
    });

    it('rejects a missing protocol as a mismatch (undefined named)', () => {
      assert.throws(
        () => mod.parseCreateJobRequest({ jobId: 'job-1', leaseTtlSec: 180 }),
        (e: unknown) => e instanceof mod.WireProtocolMismatchError,
      );
    });

    it('accepts a valid lease-renew body and enforces the same protocol guard', () => {
      assert.deepEqual(mod.parseRenewLeaseRequest({ protocol: 1, leaseTtlSec: 60 }), {
        protocol: 1,
        leaseTtlSec: 60,
      });
      assert.throws(
        () => mod.parseRenewLeaseRequest({ protocol: 9, leaseTtlSec: 60 }),
        (e: unknown) => e instanceof mod.WireProtocolMismatchError,
      );
    });
  });
}
