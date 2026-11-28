/**
 * #2320 — admin view of the per-scope agent sandboxes (#576, ADR-0055) and
 * manual control of the idle reaper. Mounted at `/api/v1/admin/sandboxes`
 * behind `requireAuth`.
 *
 *   GET  /            → registered sandboxes (`sandbox_registry`, migration 0044)
 *   POST /reap        → `{ idleMinutes, dryRun? }`: list or tear down every
 *                       non-persistent sandbox idle longer than that
 *                       (`reapOrphanedSandboxes`); persistent ones are never reaped
 *   POST /teardown    → `{ scopeKey }`: tear down one sandbox, persistent or not
 *
 * The orchestrator plugin records its Docker containers in the registry only
 * when the graph pool exists; without it this router answers 503
 * `sandbox_admin.unavailable`. No reaper runs on a schedule — the sweep is
 * an operator action, written to the admin audit trail (`sandbox.reap`,
 * `sandbox.teardown`, ADR-0100) with scope keys only, never file content.
 *
 * Teardown is `docker rm -f <sandboxRef>` through the same spawn primitive
 * the backend uses. A ref that is not a Docker container name is refused
 * before it reaches the CLI. A container Docker no longer knows counts as
 * removed; any other failure keeps the registry row so the next sweep
 * retries it (the reaper's own rule).
 */

import { Router, type Request, type Response } from 'express';

import {
  execDockerViaSpawn,
  reapOrphanedSandboxes,
  type DockerExec,
  type SandboxRegistry,
  type SandboxRegistryEntry,
} from '@omadia/sandbox';

import { recordOperatorAudit, type AdminAuditLog } from '../auth/adminAuditLog.js';

export interface AdminSandboxesRouteDeps {
  /** Absent without a graph pool — every route then answers 503. */
  readonly registry?: SandboxRegistry;
  readonly execDocker?: DockerExec;
  readonly adminAudit?: Pick<AdminAuditLog, 'record'>;
  readonly now?: () => Date;
}

const MINUTE_MS = 60_000;
const MIN_IDLE_MINUTES = 5;
const MAX_IDLE_MINUTES = 30 * 24 * 60;
/** Suggested in the UI; the operator chooses per sweep. */
export const DEFAULT_IDLE_MINUTES = 24 * 60;
/** Docker's own container-name charset; also keeps a ref from reading as a flag. */
const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const TEARDOWN_TIMEOUT_MS = 30_000;
const TEARDOWN_MAX_OUTPUT_BYTES = 65_536;

export interface SandboxDto {
  readonly scope_key: string;
  readonly backend: string;
  readonly sandbox_ref: string;
  readonly persistent: boolean;
  readonly egress: boolean;
  readonly created_at: string;
  readonly last_used_at: string;
}

function toDto(entry: SandboxRegistryEntry): SandboxDto {
  return {
    scope_key: entry.scopeKey,
    backend: entry.backend,
    sandbox_ref: entry.sandboxRef,
    persistent: entry.profile.persistent === true,
    egress: entry.profile.egress === true,
    created_at: entry.createdAt.toISOString(),
    last_used_at: entry.lastUsedAt.toISOString(),
  };
}

/** The reaper's own selection rule, for the dry run. */
export function idleSandboxes(
  entries: readonly SandboxRegistryEntry[],
  now: Date,
  idleThresholdMs: number,
): SandboxRegistryEntry[] {
  const cutoff = now.getTime() - idleThresholdMs;
  return entries.filter((e) => !e.profile.persistent && e.lastUsedAt.getTime() < cutoff);
}

function parseIdleMinutes(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  if (value < MIN_IDLE_MINUTES || value > MAX_IDLE_MINUTES) return undefined;
  return value;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export function createAdminSandboxesRouter(deps: AdminSandboxesRouteDeps): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());
  const execDocker = deps.execDocker ?? execDockerViaSpawn;

  async function teardown(sandboxRef: string): Promise<void> {
    if (!CONTAINER_NAME_RE.test(sandboxRef)) {
      throw new Error('sandbox ref is not a container name');
    }
    const result = await execDocker({
      args: ['rm', '-f', sandboxRef],
      timeoutMs: TEARDOWN_TIMEOUT_MS,
      maxOutputBytes: TEARDOWN_MAX_OUTPUT_BYTES,
    });
    if (result.exitCode === 0) return;
    if (/no such container/i.test(result.stderr)) return;
    throw new Error(`docker rm failed (exit ${String(result.exitCode)})`);
  }

  function requireRegistry(res: Response): SandboxRegistry | null {
    if (deps.registry) return deps.registry;
    res.status(503).json({
      code: 'sandbox_admin.unavailable',
      message: 'the sandbox registry needs the Postgres database',
    });
    return null;
  }

  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    const registry = requireRegistry(res);
    if (!registry) return;
    try {
      const entries = await registry.listAll();
      const sorted = [...entries].sort((a, b) => b.lastUsedAt.getTime() - a.lastUsedAt.getTime());
      res.json({
        sandboxes: sorted.map(toDto),
        reaper: {
          default_idle_minutes: DEFAULT_IDLE_MINUTES,
          min_idle_minutes: MIN_IDLE_MINUTES,
          max_idle_minutes: MAX_IDLE_MINUTES,
        },
      });
    } catch (err) {
      console.error('[admin-sandboxes] list failed:', err);
      res.status(500).json({ code: 'sandbox_admin.list_failed', message: 'could not list sandboxes' });
    }
  });

  router.post('/reap', async (req: Request, res: Response): Promise<void> => {
    const registry = requireRegistry(res);
    if (!registry) return;
    const body = asObject(req.body);
    const idleMinutes = parseIdleMinutes(body.idleMinutes);
    if (idleMinutes === undefined) {
      res.status(400).json({
        code: 'sandbox_admin.invalid_idle',
        message: `idleMinutes must be an integer from ${String(MIN_IDLE_MINUTES)} to ${String(MAX_IDLE_MINUTES)}`,
      });
      return;
    }
    const idleThresholdMs = idleMinutes * MINUTE_MS;
    const at = now();
    try {
      if (body.dryRun === true) {
        const candidates = idleSandboxes(await registry.listAll(), at, idleThresholdMs);
        res.json({ dry_run: true, candidates: candidates.map((e) => e.scopeKey) });
        return;
      }
      const result = await reapOrphanedSandboxes({ registry, teardown, now: at, idleThresholdMs });
      await recordOperatorAudit(deps.adminAudit, req, {
        action: 'sandbox.reap',
        target: 'sandbox-registry',
        after: { idleMinutes, reaped: result.reapedScopeKeys, failed: result.failedScopeKeys },
      });
      res.json({ dry_run: false, reaped: result.reapedScopeKeys, failed: result.failedScopeKeys });
    } catch (err) {
      console.error('[admin-sandboxes] reap failed:', err);
      res.status(500).json({ code: 'sandbox_admin.reap_failed', message: 'the sweep failed' });
    }
  });

  router.post('/teardown', async (req: Request, res: Response): Promise<void> => {
    const registry = requireRegistry(res);
    if (!registry) return;
    const scopeKey = asObject(req.body).scopeKey;
    if (typeof scopeKey !== 'string' || scopeKey.length === 0) {
      res.status(400).json({ code: 'sandbox_admin.invalid_scope', message: 'scopeKey is required' });
      return;
    }
    try {
      const entry = await registry.get(scopeKey);
      if (!entry) {
        res.status(404).json({ code: 'sandbox_admin.not_found', message: 'no sandbox for that scope' });
        return;
      }
      try {
        await teardown(entry.sandboxRef);
      } catch (err) {
        console.error('[admin-sandboxes] teardown failed:', err);
        res.status(502).json({
          code: 'sandbox_admin.teardown_failed',
          message: 'the container could not be removed; the sandbox stays registered',
        });
        return;
      }
      await registry.delete(scopeKey);
      await recordOperatorAudit(deps.adminAudit, req, {
        action: 'sandbox.teardown',
        target: `sandbox:${scopeKey}`,
        before: { backend: entry.backend, persistent: entry.profile.persistent === true },
      });
      res.json({ ok: true });
    } catch (err) {
      console.error('[admin-sandboxes] teardown failed:', err);
      res.status(500).json({ code: 'sandbox_admin.teardown_failed', message: 'the teardown failed' });
    }
  });

  return router;
}
