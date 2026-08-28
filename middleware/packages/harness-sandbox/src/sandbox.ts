import type { AgentComputerProfile } from './agentComputerProfile.js';

/**
 * Issue #576 — the narrow `Sandbox` contract every backend (local Docker
 * today; Fly Sprites / Firecracker / a #746 Satellite later) implements
 * identically, so the execute tool (P2) and the scope registry (P3) never
 * import a backend directly.
 *
 * Modelled on qm's `src/sandbox/sandbox.ts` shape per the issue: a required
 * core (provision/run/read/write/list/teardown) plus OPTIONAL capabilities
 * discovered via type guards rather than declared on the interface — a
 * backend that does not support process sessions or blob staging simply
 * fails the guard, and a caller that skips the guard and calls the narrower
 * surface still gets the full core contract.
 */
export interface SandboxRunOptions {
  /** Root-relative working directory inside the sandbox. Traversal-clamped
   *  the same way as `read`/`write`/`list` (see `pathGuard.ts`). */
  readonly cwd?: string;
  /** Overrides `AgentComputerProfile.maxRunSeconds` for this one call — MUST
   *  NOT exceed it; a backend clamps down, never up. */
  readonly timeoutSeconds?: number;
  /** Extra environment variables merged over the sandbox's base env. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface SandboxRunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  /** True when stdout or stderr hit `maxOutputBytes` and was truncated. */
  readonly outputTruncated: boolean;
}

export type SandboxReadOutcome =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly reason: 'not_found' | 'is_directory' | 'path_rejected'; readonly detail: string };

export type SandboxWriteOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'path_rejected' | 'write_failed'; readonly detail: string };

export interface SandboxListEntry {
  readonly name: string;
  readonly kind: 'file' | 'dir' | 'other';
}

export type SandboxListOutcome =
  | { readonly ok: true; readonly entries: readonly SandboxListEntry[] }
  | { readonly ok: false; readonly reason: 'not_found' | 'not_a_directory' | 'path_rejected'; readonly detail: string };

/** Core contract. Every backend implements this in full — no optional core
 *  methods, so a caller never needs to guard the basics. */
export interface Sandbox {
  /** Backend-opaque identifier (a container id, a Fly machine id, …). Stable
   *  for the sandbox's lifetime; used for logging/audit correlation only —
   *  never parsed by a caller. */
  readonly id: string;
  /** The scope key this sandbox was provisioned for (see `ScopeId` in
   *  `@omadia/channel-sdk`, rendered via `formatSessionScope`). */
  readonly scopeKey: string;
  readonly profile: AgentComputerProfile;
  run(command: string, options?: SandboxRunOptions): Promise<SandboxRunResult>;
  read(relativePath: string): Promise<SandboxReadOutcome>;
  write(relativePath: string, content: string): Promise<SandboxWriteOutcome>;
  list(relativePath: string): Promise<SandboxListOutcome>;
  /** Tears the sandbox down. For a `persistent` profile this is normally only
   *  called by the P3 reaper on an orphaned scope, not by a single tool call. */
  teardown(): Promise<void>;
}

export interface SandboxBackend {
  /** Provision (or, once P3's registry exists, re-attach to) the sandbox for
   *  `scopeKey` under `profile`. Idempotent per backend instance: calling it
   *  twice for the same live `scopeKey` returns the SAME sandbox rather than
   *  provisioning a second one — durability is "one computer per scope", not
   *  "a fresh one each call". */
  provision(args: { readonly scopeKey: string; readonly profile: AgentComputerProfile }): Promise<Sandbox>;
}

// ---------------------------------------------------------------------------
// Optional capabilities — type guards, not interface fields (qm's design).
// A backend that does not implement a capability MUST make its guard return
// false for every sandbox it provisions; it must not implement the interface
// shape without actually wiring the behaviour (that is the declared-field
// trap this whole issue calls out by name).
// ---------------------------------------------------------------------------

/** A capability marker every capability interface below carries, so a type
 *  guard can discriminate without `in`-checking arbitrary methods. */
export interface SandboxCapability {
  readonly capability: string;
}

/** Long-lived interactive/background process sessions — attach/detach from a
 *  shell that outlives a single `run()` call. Not implemented by
 *  `DockerSandboxBackend` v1; the seam exists for a backend that wants it. */
export interface ProcessSessionCapableSandbox extends Sandbox, SandboxCapability {
  readonly capability: 'process-sessions';
  startSession(command: string): Promise<{ sessionId: string }>;
  attachSession(sessionId: string): Promise<{ output: AsyncIterable<string> }>;
}

export function hasProcessSessions(
  sandbox: Sandbox,
): sandbox is ProcessSessionCapableSandbox {
  return (sandbox as Partial<ProcessSessionCapableSandbox>).capability === 'process-sessions';
}

/** Point-in-time backup/restore of the sandbox's persistent state. Not
 *  implemented by `DockerSandboxBackend` v1. */
export interface BackupCapableSandbox extends Sandbox, SandboxCapability {
  readonly capability: 'backup';
  snapshot(): Promise<{ snapshotId: string }>;
  restore(snapshotId: string): Promise<void>;
}

export function hasBackup(sandbox: Sandbox): sandbox is BackupCapableSandbox {
  return (sandbox as Partial<BackupCapableSandbox>).capability === 'backup';
}

/** Bulk blob staging in/out (upload a large artifact without routing every
 *  byte through `write()`'s exec-pipe path). Not implemented by
 *  `DockerSandboxBackend` v1. */
export interface BlobStagingCapableSandbox extends Sandbox, SandboxCapability {
  readonly capability: 'blob-staging';
  stageBlobIn(relativePath: string, source: AsyncIterable<Uint8Array>): Promise<void>;
  stageBlobOut(relativePath: string): Promise<AsyncIterable<Uint8Array>>;
}

export function hasBlobStaging(
  sandbox: Sandbox,
): sandbox is BlobStagingCapableSandbox {
  return (sandbox as Partial<BlobStagingCapableSandbox>).capability === 'blob-staging';
}
