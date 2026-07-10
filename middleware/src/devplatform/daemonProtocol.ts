/**
 * Epic #470 W1 — daemon <-> middleware CONTROL-PLANE wire protocol (spec §4).
 *
 * This is the MIDDLEWARE copy of the schema. The daemon keeps a byte-parallel
 * copy at `middleware/sidecars/dev-runner-daemon/src/protocol.ts`. The two are
 * DUPLICATED on purpose: the daemon package is standalone (dockerode + zod +
 * node builtins only) and must never inherit the middleware's dependency
 * surface, so it cannot import this module. A contract test
 * (`test/devplatform/daemonProtocol.test.ts`) snapshots both copies to JSON
 * Schema and diffs them, so any drift between the two fails CI.
 *
 * DISTINCT from the phone-home protocol: `RUNNER_PROTOCOL_VERSION` in
 * `./types.ts` versions the runner<->middleware phone-home channel
 * (`/api/v1/dev-runner`). The constant below versions a different channel — the
 * middleware<->daemon control plane (`POST/DELETE /v1/jobs`, lease, list,
 * health) on daemon port 7411. The two evolve independently.
 *
 * The `POST /v1/jobs` body is EXACTLY `{ protocol, jobId, leaseTtlSec }` and
 * nothing else. The daemon derives the effective policy (env, image, egress
 * allowlist, limits) server-side from the middleware's job-policy lookup; the
 * caller names a job, never a policy (review finding S3 — "a clamp that trusts
 * caller-supplied policy is not a clamp"). `strictObject` enforces this at the
 * schema boundary: a body smuggling `env`/`image`/`egressAllowlist`/`limits` is
 * rejected before any handler runs.
 */

import { z } from 'zod';

/**
 * Daemon control-plane wire-protocol version. Every request carries it; a
 * mismatch is rejected naming BOTH versions so a skewed middleware/daemon pair
 * is diagnosable from a single log line.
 */
export const DAEMON_PROTOCOL_VERSION = 1;

/** The `protocol` field every request carries — `const: 1` in the snapshot. */
const protocolField = z.literal(DAEMON_PROTOCOL_VERSION);

// ---------------------------------------------------------------------------
// Requests (bodied endpoints).
// ---------------------------------------------------------------------------

/**
 * `POST /v1/jobs` body — start (or idempotently re-attach) a job. EXACTLY
 * `{ protocol, jobId, leaseTtlSec }`; `strictObject` rejects every extra key.
 * No `env`, `image`, `egressAllowlist`, or `limits` may ride here — the daemon
 * fetches the policy itself (spec §4, S3).
 */
export const CreateJobRequestSchema = z.strictObject({
  protocol: protocolField,
  jobId: z.string().min(1),
  leaseTtlSec: z.number().int().positive(),
});
export type CreateJobRequest = z.infer<typeof CreateJobRequestSchema>;

/** `POST /v1/jobs/:jobId/lease` body — renew a lease. jobId rides in the path. */
export const RenewLeaseRequestSchema = z.strictObject({
  protocol: protocolField,
  leaseTtlSec: z.number().int().positive(),
});
export type RenewLeaseRequest = z.infer<typeof RenewLeaseRequestSchema>;

// ---------------------------------------------------------------------------
// Responses.
// ---------------------------------------------------------------------------

/** `POST /v1/jobs` result (spec §4). Idempotent on `jobId`. */
export const CreateJobResponseSchema = z.object({
  containerId: z.string().min(1),
  networkId: z.string().min(1),
  volumeName: z.string().min(1),
  leaseExpiresAt: z.string().min(1),
  imageDigest: z.string().min(1),
});
export type CreateJobResponse = z.infer<typeof CreateJobResponseSchema>;

/** `POST /v1/jobs/:jobId/lease` result. */
export const LeaseResponseSchema = z.object({
  jobId: z.string().min(1),
  leaseExpiresAt: z.string().min(1),
});
export type LeaseResponse = z.infer<typeof LeaseResponseSchema>;

/** One live job in the `GET /v1/jobs` list — the middleware `reap()` join source. */
export const JobSummarySchema = z.object({
  jobId: z.string().min(1),
  containerId: z.string().min(1),
  networkId: z.string().min(1),
  volumeName: z.string().min(1),
  imageDigest: z.string().min(1),
  leaseExpiresAt: z.string().min(1),
});
export type JobSummary = z.infer<typeof JobSummarySchema>;

/** `GET /v1/jobs` result — the live-job set reconciled against `dev_jobs`. */
export const ListJobsResponseSchema = z.object({
  jobs: z.array(JobSummarySchema),
});
export type ListJobsResponse = z.infer<typeof ListJobsResponseSchema>;

/** `GET /v1/health` result (spec §4): dind reachability, engine version,
 *  warmed digests, warm flag, live job count. */
export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  dindReachable: z.boolean(),
  engineApiVersion: z.string(),
  warmedDigests: z.array(z.string()),
  imageWarm: z.boolean(),
  liveJobs: z.number().int().nonnegative(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

// ---------------------------------------------------------------------------
// Parity registry — the single map the contract test snapshots and diffs.
// ---------------------------------------------------------------------------

/**
 * The full wire surface keyed by a stable name. The contract test converts this
 * map to JSON Schema on BOTH copies and deep-diffs them, so a field changed on
 * one side alone fails CI, and adding/removing a schema on one side alone
 * changes the key set and also fails.
 */
export const DAEMON_WIRE_SCHEMAS = {
  CreateJobRequest: CreateJobRequestSchema,
  RenewLeaseRequest: RenewLeaseRequestSchema,
  CreateJobResponse: CreateJobResponseSchema,
  LeaseResponse: LeaseResponseSchema,
  JobSummary: JobSummarySchema,
  ListJobsResponse: ListJobsResponseSchema,
  HealthResponse: HealthResponseSchema,
} as const;

// ---------------------------------------------------------------------------
// Runtime protocol guard.
// ---------------------------------------------------------------------------

/**
 * Thrown when a request declares a wire-protocol version the peer cannot speak.
 * The message names BOTH the version this peer speaks and the one the request
 * declared, so a skew is diagnosable from a single log line.
 */
export class WireProtocolMismatchError extends Error {
  readonly expected: number;
  readonly received: unknown;
  constructor(expected: number, received: unknown) {
    super(
      `dev-runner daemon wire protocol mismatch: this peer speaks v${expected}, ` +
        `the request declared v${describeVersion(received)}`,
    );
    this.name = 'WireProtocolMismatchError';
    this.expected = expected;
    this.received = received;
  }
}

function describeVersion(received: unknown): string {
  if (typeof received === 'number') return String(received);
  if (received === undefined) return 'undefined';
  return JSON.stringify(received) ?? String(received);
}

function assertProtocol(input: unknown): void {
  const received =
    typeof input === 'object' && input !== null
      ? (input as { protocol?: unknown }).protocol
      : undefined;
  if (received !== DAEMON_PROTOCOL_VERSION) {
    throw new WireProtocolMismatchError(DAEMON_PROTOCOL_VERSION, received);
  }
}

/**
 * Parse a `POST /v1/jobs` body. Checks the protocol version FIRST, so a skewed
 * pair fails with a version-named `WireProtocolMismatchError` rather than an
 * opaque literal error, then enforces the exact `{ protocol, jobId,
 * leaseTtlSec }` shape (any extra key rejected). Throws `z.ZodError` on any
 * other malformed field.
 */
export function parseCreateJobRequest(input: unknown): CreateJobRequest {
  assertProtocol(input);
  return CreateJobRequestSchema.parse(input);
}

/** Parse a `POST /v1/jobs/:jobId/lease` body with the same version-first guard. */
export function parseRenewLeaseRequest(input: unknown): RenewLeaseRequest {
  assertProtocol(input);
  return RenewLeaseRequestSchema.parse(input);
}
