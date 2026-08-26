import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { MemoryStore } from '@omadia/plugin-api';

import {
  promoteMemory,
  PROMOTION_AUDIT_PATH,
  type PromoteReceipt,
} from '../services/memoryPromote.js';

/**
 * Memory promotion — the operator-facing surface for the one explicit act
 * that moves knowledge across an agent's context boundaries (design spec
 * #870 §6, epic #860).
 *
 *   POST /:slug/memory/promotions   run a copy/move between two tiers
 *   GET  /:slug/memory/promotions   read that agent's promotion audit log
 *
 * MOUNT + GATE
 * ------------
 * Mounted at `/api/v1/operator/agents` behind `requireAuth` (cookie session
 * JWT) — the SAME gate `routes/memoryPurge.ts` documents for the Danger
 * Zone, and the prefix `routes/operatorAgents.ts` already owns for every
 * other per-agent operator action. The full URLs are therefore
 * `/api/v1/operator/agents/:slug/memory/promotions`. Like purge, this is
 * intentionally NOT on the machine-to-machine `ADMIN_TOKEN` surface in
 * `admin.ts`: the operator authenticates as a logged-in admin user via the
 * browser session.
 *
 * This is a deliberate reconciliation of the spec, which writes the path as
 * `/api/agents/:slug/memory/promotions` "gleiche Gate wie Purge" — a surface
 * that does not exist in this repo. Keeping the spec's resource shape while
 * reusing the existing `requireAuth`-gated operator prefix satisfies both
 * halves of that sentence without inventing a third top-level API surface.
 * The router is a separate module (not folded into `operatorAgents.ts`) so
 * the two can be developed and mounted independently; Express consults both
 * routers at the same prefix in mount order.
 *
 * ACTOR
 * -----
 * `PromoteRequest.actor` is "die Operator-Identität aus der Session" (§6) and
 * is written into all three audit surfaces, so it is read from the session
 * here rather than hardcoded the way `memoryPurge` writes `'admin-ui'` — an
 * audit trail that always names the UI instead of the human is worthless.
 * The `omadia_user_id ?? sub` fallback is the `uiPrefs.ts` idiom:
 * `omadia_user_id` is optional on a live session (first-login / KG-degraded
 * window), and a genuinely session-less request is the only 401.
 *
 * STORE
 * -----
 * Runs on the ROOT (undecorated) `MemoryStore` — promotion crosses exactly
 * the scopes a `ScopedMemoryStore` enforces, so it cannot run inside one.
 * Same precedent as `memoryPurge`.
 */

const PromoteSourceSchema = z.object({
  axis: z.enum(['team', 'channel', 'user']),
  ctxKey: z.string().min(1).max(256),
  path: z.string().min(1).max(1024),
});

const PromoteTargetSchema = z.object({
  tier: z.enum(['agent', 'team']),
  ctxKey: z.string().min(1).max(256).optional(),
  path: z.string().min(1).max(1024).optional(),
});

/** Body of a promotion. `agentSlug` comes from the path, `actor` from the
 *  session — neither is accepted from the client. */
const PromoteBodySchema = z.object({
  source: PromoteSourceSchema,
  target: PromoteTargetSchema,
  mode: z.enum(['copy', 'move']),
  reason: z.string().max(2000).optional(),
  overwrite: z.boolean().optional(),
});

const AuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

const DEFAULT_AUDIT_LIMIT = 100;

export interface MemoryPromoteDeps {
  /** ROOT MemoryStore — undecorated, exactly like `memoryPurge`. */
  store: MemoryStore;
  /** Injectable log sink. Defaults to `console.error`. */
  log?: (message: string) => void;
}

/** Service errors carry a machine-readable `code`; map it to a status. */
function statusForCode(code: string): number {
  switch (code) {
    case 'source_not_found':
      return 404;
    case 'target_exists':
    case 'target_is_directory':
      return 409;
    case 'invalid_agent_slug':
    case 'invalid_axis':
    case 'invalid_tier':
    case 'invalid_mode':
    case 'invalid_ctx_key':
    case 'invalid_path':
    case 'actor_required':
    case 'source_escapes_agent':
    case 'target_escapes_agent':
    case 'target_equals_source':
    case 'source_empty':
      return 400;
    default:
      return 500;
  }
}

function errorCode(err: unknown): string | undefined {
  if (err !== null && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** `audit_write_failed` carries the receipt of the promotion that DID run. */
function attachedReceipt(err: unknown): PromoteReceipt | undefined {
  if (err !== null && typeof err === 'object' && 'receipt' in err) {
    return (err as { receipt: PromoteReceipt }).receipt;
  }
  return undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Express 5 types `req.params` values as `string | string[]`. A wildcard
 *  cannot reach `:slug`, but narrow honestly rather than casting — an empty
 *  string falls through to the service's own `invalid_agent_slug`. */
function slugParam(req: Request): string {
  const raw = req.params.slug;
  return typeof raw === 'string' ? raw : '';
}

/** Session identity of the operator, or `null` after a 401 was sent. */
function requireActor(req: Request, res: Response): string | null {
  const actor = req.session?.omadia_user_id ?? req.session?.sub;
  if (!actor) {
    res.status(401).json({ error: 'auth.required', message: 'login required' });
    return null;
  }
  return actor;
}

interface AuditEntry {
  readonly agentSlug?: unknown;
  readonly [key: string]: unknown;
}

/**
 * Read the append-only JSONL the service writes (§6a) and return this
 * agent's entries, newest first. A malformed line is counted, never thrown
 * on: the log is the audit record of promotions that already happened, so a
 * single unparseable line must not hide the rest.
 */
async function readAuditEntries(
  store: MemoryStore,
  agentSlug: string,
  limit: number,
): Promise<{ entries: AuditEntry[]; malformed: number }> {
  if (!(await store.fileExists(PROMOTION_AUDIT_PATH))) {
    return { entries: [], malformed: 0 };
  }
  const raw = await store.readFile(PROMOTION_AUDIT_PATH);
  const entries: AuditEntry[] = [];
  let malformed = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      malformed += 1;
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      malformed += 1;
      continue;
    }
    const entry = parsed as AuditEntry;
    if (entry.agentSlug !== agentSlug) continue;
    entries.push(entry);
  }
  // The file is append-only chronological; the operator wants the latest hop
  // first, and `limit` must cut the OLDEST entries, not the newest.
  entries.reverse();
  return { entries: entries.slice(0, limit), malformed };
}

export function createMemoryPromoteRouter(deps: MemoryPromoteDeps): Router {
  const router = Router();
  const log =
    deps.log ??
    ((message: string): void => {
      console.error(message);
    });

  // Run a promotion. Every rejection happens before the first byte lands, so
  // a non-2xx response means both tiers are untouched — except
  // `audit_write_failed`, which is a completed promotion with a missing audit
  // line and is reported as such (200 + `warning`), never as a failure.
  router.post('/:slug/memory/promotions', async (req: Request, res: Response) => {
    const actor = requireActor(req, res);
    if (actor === null) return;

    const parsed = PromoteBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    const { source, target, mode, reason, overwrite } = parsed.data;
    const agentSlug = slugParam(req);

    try {
      const receipt = await promoteMemory(deps.store, {
        agentSlug,
        source,
        target,
        mode,
        actor,
        ...(reason !== undefined ? { reason } : {}),
        ...(overwrite !== undefined ? { overwrite } : {}),
      });
      res.json({ receipt });
    } catch (err) {
      const code = errorCode(err);
      const receipt = code === 'audit_write_failed' ? attachedReceipt(err) : undefined;
      if (receipt) {
        // The promotion completed — an audit gap must not mask it (same rule
        // `memoryPurge` applies to its `memory_purge_audit` row).
        log(
          `[memory-promote] audit line failed for ${receipt.sourcePath} → ${receipt.targetPath}: ${messageOf(err)}`,
        );
        res.json({
          receipt,
          warning: `The promotion was applied but its audit line could not be written to ${PROMOTION_AUDIT_PATH}.`,
        });
        return;
      }
      const status = statusForCode(code ?? 'memory_promote_failed');
      if (status >= 500) {
        log(`[memory-promote] promotion failed: ${messageOf(err)}`);
      }
      res
        .status(status)
        .json({ error: code ?? 'memory_promote_failed', message: messageOf(err) });
    }
  });

  // Read the promotion audit log for this agent (§6a).
  router.get('/:slug/memory/promotions', async (req: Request, res: Response) => {
    if (requireActor(req, res) === null) return;

    const parsed = AuditQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    const limit = parsed.data.limit ?? DEFAULT_AUDIT_LIMIT;
    const agentSlug = slugParam(req);

    try {
      const { entries, malformed } = await readAuditEntries(
        deps.store,
        agentSlug,
        limit,
      );
      if (malformed > 0) {
        log(
          `[memory-promote] ${String(malformed)} unparseable line(s) in ${PROMOTION_AUDIT_PATH}`,
        );
      }
      res.json({
        auditPath: PROMOTION_AUDIT_PATH,
        entries,
        ...(malformed > 0 ? { malformed } : {}),
      });
    } catch (err) {
      log(`[memory-promote] audit read failed: ${messageOf(err)}`);
      res
        .status(500)
        .json({ error: 'audit_read_failed', message: messageOf(err) });
    }
  });

  return router;
}
