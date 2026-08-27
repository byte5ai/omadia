import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { KnowledgeGraph, MemoryStore } from '@omadia/plugin-api';

import {
  previewMemoryPurge,
  purgeMemory,
  type MemoryPurgeAxis,
} from '../services/memoryPurge.js';

/**
 * Danger-Zone memory purge — operator-facing admin endpoints.
 *
 * Mounted at `/api/v1/admin/memory/purge` behind `requireAuth` (cookie
 * session JWT), consistent with the other `/api/v1/admin/*` routers
 * (bulk-promote, inconsistencies, duplicates) that the admin UI calls.
 * This is intentionally NOT on the machine-to-machine `ADMIN_TOKEN`
 * surface in `admin.ts`: the Danger Zone page authenticates as a logged-in
 * admin user via the browser session, like every other admin page — there
 * is no client-side `ADMIN_TOKEN`.
 *
 * Bulk-deletes memory across both layers:
 *   - scratch (`MemoryStore`) via `previewMemoryPurge` / `purgeMemory` —
 *     including, since the chat-context memory ACL, the per-context trees under
 *     `/memories/contexts`, which is what gives the team/channel/user axes a
 *     scratch footprint at all
 *   - Knowledge-Graph `MemorableKnowledge` via `count/purgeMemorableKnowledge`
 * Type-to-confirm is enforced server-side; a single `memory_purge_audit`
 * row is written per executed purge.
 */

const PurgeAxisSchema = z.enum(['all', 'agent', 'user', 'team', 'channel']);

const PurgePreviewBodySchema = z.object({
  axis: PurgeAxisSchema,
  selector: z.string().optional(),
});

const PurgeBodySchema = z.object({
  axis: PurgeAxisSchema,
  selector: z.string().optional(),
  confirm: z.string(),
  reseed: z.boolean().optional(),
});

const CONFIRM_ALL = 'DELETE ALL MEMORY';

export interface MemoryPurgeDeps {
  store: MemoryStore;
  /** Optional — present only with a Postgres KG backend. Without it, the
   *  purge endpoints still run the scratch leg and report `kgDeleted: 0`. */
  knowledgeGraph?: KnowledgeGraph;
  /** pg Pool used for the `memory_purge_audit` row. Undefined ⇒ audit skipped
   *  (in-memory boot / DB-less tests). */
  graphPool?: Pool;
  /** Tenant the KG purge runs against. Defaults to `'default'`. */
  tenantId?: string;
}

/**
 * Warning surfaced for an axis whose Knowledge-Graph half is not modelled.
 *
 * This used to read "only scratch memory is affected", which was misleading in
 * BOTH directions: at the time a team/channel purge touched no scratch memory
 * either (the axes had no `/memories` footprint at all), so the sentence
 * promised an effect that did not happen. Now that the context trees exist the
 * scratch half is real, and the part that needs saying is the OTHER half: the
 * Knowledge-Graph is deliberately left alone. Modelling a team/channel KG
 * partition is a follow-up, not something to fake with an invented filter.
 */
function kgUnmodelledWarning(
  axis: MemoryPurgeAxis,
  past: boolean,
  scratchTargets: number,
): string {
  const kgHalf =
    `${axis}-scoped Knowledge-Graph purge is not yet modeled (no KG column), ` +
    `so the Knowledge-Graph ${past ? 'was' : 'is'} left untouched. `;
  // Never claim an effect the purge did not have: a selector that resolves to
  // zero trees is the single most likely operator mistake on this surface, and
  // reporting "the scratch trees were affected" would hide it behind a 200.
  const scratchHalf =
    scratchTargets === 0
      ? `No matching context tree ${past ? 'was found' : 'exists'} under /memories/contexts either — nothing ${past ? 'was' : 'will be'} deleted.`
      : `Only the /memories/contexts scratch trees ${past ? 'were' : 'are'} affected.`;
  return kgHalf + scratchHalf;
}

/**
 * Warning for the `user` axis, whose two halves consume the selector in
 * INCOMPATIBLE spellings: the KG matches it raw as `aclOwner`, while the purge
 * service resolves it as a `<channelType>~<id>` context key. At most one half
 * can match any given selector, and without this the operator gets a 200 and a
 * half-done purge with nothing saying which leg was a no-op.
 *
 * Deliberately a warning and not a fix: reconciling the two spellings means
 * modelling a KG context column, which design §7 puts outside this wave. What
 * is fixable here is the silence.
 */
function userAxisSplitWarning(
  scratchTargets: number,
  kgDeleted: number,
  past: boolean,
): string | undefined {
  if (scratchTargets > 0 && kgDeleted > 0) return undefined;
  if (scratchTargets === 0 && kgDeleted === 0) return undefined;
  return scratchTargets === 0
    ? `The Knowledge-Graph half matched, but no context tree under /memories/contexts ${past ? 'did' : 'does'}: the KG matches the selector raw as an ACL owner, while a context tree is named "<channelType>~<id>". The user's scratch memory ${past ? 'was' : 'will be'} NOT purged.`
    : `The context trees matched, but no Knowledge-Graph row did: the KG matches the selector raw as an ACL owner, not as a "<channelType>~<id>" context key. The user's Knowledge-Graph rows ${past ? 'were' : 'will be'} NOT purged.`;
}

/** Map a purge axis+selector to the KG MemorableKnowledge filter. Returns
 *  null for axes that have no KG column yet (team/channel) so the caller can
 *  surface a warning instead of fabricating a filter.
 *
 *  NOTE: for `user` the selector doubles as the KG `aclOwner` AND — via
 *  `memoryContextKey` inside the purge service — as the scratch context key.
 *  Reconciling those two spellings belongs to the KG team-axis follow-up; this
 *  router deliberately does not invent a mapping between them. */
function axisToKgFilter(
  axis: MemoryPurgeAxis,
  selector: string | undefined,
  tenantId: string,
): { tenantId: string; originAgent?: string; aclOwner?: string } | null {
  switch (axis) {
    case 'all':
      return { tenantId };
    case 'agent':
      return { tenantId, originAgent: selector };
    case 'user':
      return { tenantId, aclOwner: selector };
    case 'team':
    case 'channel':
      // No KG column models team/channel scoping yet — do NOT fabricate one.
      return null;
  }
}

/**
 * The service's typed error code, when it carried one. Surfacing it instead of
 * a blanket `memory_purge_failed` is what lets the Danger-Zone UI tell a
 * mistyped selector (`invalid_selector`) apart from a store failure.
 */
function errorCode(err: unknown): string | undefined {
  if (err === null || typeof err !== 'object' || !('code' in err)) return undefined;
  const code = (err as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

let auditTableReady: Promise<void> | null = null;

/** Lazily create the `memory_purge_audit` table on first use. Idempotent. */
async function ensureAuditTable(pool: Pool): Promise<void> {
  if (!auditTableReady) {
    auditTableReady = pool
      .query(
        `CREATE TABLE IF NOT EXISTS memory_purge_audit (
           id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
           actor           text NOT NULL,
           axis            text NOT NULL,
           selector        text,
           scratch_deleted integer NOT NULL,
           kg_deleted      integer NOT NULL,
           created_at      timestamptz NOT NULL DEFAULT now()
         )`,
      )
      .then(() => undefined)
      .catch((err: unknown) => {
        // Reset so a transient failure (e.g. missing pgcrypto) can retry.
        auditTableReady = null;
        throw err;
      });
  }
  return auditTableReady;
}

async function writePurgeAudit(
  pool: Pool,
  row: {
    actor: string;
    axis: string;
    selector: string | null;
    scratchDeleted: number;
    kgDeleted: number;
  },
): Promise<void> {
  await ensureAuditTable(pool);
  await pool.query(
    `INSERT INTO memory_purge_audit
       (actor, axis, selector, scratch_deleted, kg_deleted)
     VALUES ($1, $2, $3, $4, $5)`,
    [row.actor, row.axis, row.selector, row.scratchDeleted, row.kgDeleted],
  );
}

export function createMemoryPurgeRouter(deps: MemoryPurgeDeps): Router {
  const router = Router();
  const tenantId = deps.tenantId ?? 'default';

  // Dry-run preview — counts what a purge WOULD remove across both layers
  // without mutating anything.
  router.post('/preview', async (req: Request, res: Response) => {
    const parsed = PurgePreviewBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    const { axis, selector } = parsed.data;
    try {
      const scratchCount = await previewMemoryPurge(deps.store, axis, selector);
      let kgCount = 0;
      let warning: string | undefined;
      const filter = axisToKgFilter(axis, selector, tenantId);
      if (filter === null) {
        warning = kgUnmodelledWarning(axis, false, scratchCount);
      } else if (deps.knowledgeGraph) {
        kgCount = (await deps.knowledgeGraph.countMemorableKnowledge(filter))
          .count;
      }
      if (axis === 'user') {
        warning = userAxisSplitWarning(scratchCount, kgCount, false) ?? warning;
      }
      res.json({ scratchCount, kgCount, ...(warning ? { warning } : {}) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = errorCode(err) ?? 'memory_purge_preview_failed';
      res.status(400).json({ error: code, message });
    }
  });

  // Destructive purge. Type-to-confirm enforced server-side.
  router.delete('/', async (req: Request, res: Response) => {
    const parsed = PurgeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    const { axis, selector, confirm, reseed } = parsed.data;

    // Server-side type-to-confirm: 'all' demands the fixed phrase; every
    // other axis demands the selector be re-typed verbatim.
    //
    // "Verbatim" means the string the OPERATOR typed, never the `ctxKey` the
    // purge service derives from it. Confirming against the derived key would
    // make the gesture unperformable (the operator cannot type a sha256 stem)
    // and would silently accept two different selectors that normalise to one
    // key — the confirmation must guard the input, not the normalisation.
    const expected = axis === 'all' ? CONFIRM_ALL : (selector ?? '');
    if (confirm !== expected || (axis !== 'all' && expected.length === 0)) {
      res.status(400).json({ error: 'confirmation_mismatch' });
      return;
    }

    try {
      const scratchDeleted = await purgeMemory(deps.store, axis, selector, {
        ...(reseed !== undefined ? { reseed } : {}),
      });

      let kgDeleted = 0;
      let warning: string | undefined;
      const filter = axisToKgFilter(axis, selector, tenantId);
      if (filter === null) {
        warning = kgUnmodelledWarning(axis, true, scratchDeleted);
      } else if (deps.knowledgeGraph) {
        kgDeleted = (await deps.knowledgeGraph.purgeMemorableKnowledge(filter))
          .deletedNodes;
      }
      if (axis === 'user') {
        warning = userAxisSplitWarning(scratchDeleted, kgDeleted, true) ?? warning;
      }

      if (deps.graphPool) {
        try {
          await writePurgeAudit(deps.graphPool, {
            actor: 'admin-ui',
            axis,
            selector: selector ?? null,
            scratchDeleted,
            kgDeleted,
          });
        } catch (auditErr) {
          // Audit failure must not mask a completed purge — log and continue.
          const m =
            auditErr instanceof Error ? auditErr.message : String(auditErr);
          console.error('[memory-purge] memory_purge_audit write failed:', m);
        }
      }

      res.json({ scratchDeleted, kgDeleted, ...(warning ? { warning } : {}) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = errorCode(err) ?? 'memory_purge_failed';
      res.status(400).json({ error: code, message });
    }
  });

  return router;
}
