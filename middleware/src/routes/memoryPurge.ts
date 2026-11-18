import { randomBytes } from 'node:crypto';

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Pool } from 'pg';
import type {
  ConversationHistoryPurgeFilter,
  KnowledgeGraph,
  MemorableKnowledgePurgeFilter,
  MemoryStore,
} from '@omadia/plugin-api';

import {
  bundledSeedEntries,
  deletePurgeTargets,
  reseedMemory,
  resolvePurgeTargets,
  type MemoryPurgeAxis,
} from '../services/memoryPurge.js';
import { auditActorFromRequest } from '../auth/adminAuditLog.js';
import {
  createMemoryPurgeAuditStore,
  type MemoryPurgeActor,
  type MemoryPurgeAuditStore,
  type MemoryPurgeCounts,
} from '../services/memoryPurgeAudit.js';

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
 * What a purge removes, per layer:
 *   - scratch (`MemoryStore`) — the targets `resolvePurgeTargets` returns,
 *     including the per-context trees under `/memories/contexts`
 *   - Knowledge-Graph `MemorableKnowledge` — `count/purgeMemorableKnowledge`
 *   - Knowledge-Graph conversation history (#1334) — Turns, Sessions, Runs,
 *     agent invocations, tool calls, plans and the Facts derived from the
 *     turns — `count/purgeConversationHistory`
 *
 * ONE plan ({@link planPurge}) feeds both endpoints, so the preview counts
 * exactly what the delete removes (#1335). Warnings travel as codes plus
 * params; the UI translates them (#1333).
 *
 * Safeguards on DELETE (#1336): type-to-confirm, a preview token from
 * `POST /preview` for the same selection, the signed-in actor, and an audit
 * row written BEFORE anything is deleted — a purge that cannot be recorded
 * does not run. Without a Postgres pool there is no audit store; the purge
 * then runs and says so in its `warnings`.
 */

const PurgeAxisSchema = z.enum(['all', 'agent', 'user', 'team', 'channel']);

const PurgePreviewBodySchema = z.object({
  axis: PurgeAxisSchema,
  selector: z.string().optional(),
  reseed: z.boolean().optional(),
});

const PurgeBodySchema = z.object({
  axis: PurgeAxisSchema,
  selector: z.string().optional(),
  confirm: z.string(),
  reseed: z.boolean().optional(),
  previewToken: z.string().optional(),
});

const CONFIRM_ALL = 'DELETE ALL MEMORY';

/** How long a preview arms a delete. Long enough to read the counts and type
 *  the confirmation, short enough that the counts are still the ones seen. */
export const PREVIEW_TOKEN_TTL_MS = 10 * 60 * 1000;

export interface MemoryPurgeDeps {
  store: MemoryStore;
  /** Optional — absent on a KG-less boot. The purge then runs the scratch leg
   *  only and reports zero Knowledge-Graph counts. */
  knowledgeGraph?: KnowledgeGraph;
  /** pg Pool for the `memory_purge_audit` row. Undefined ⇒ no audit store
   *  (in-memory boot / DB-less tests) — the response then carries an
   *  `audit_unavailable` warning. Ignored when `auditStore` is given. */
  graphPool?: Pool;
  /** Explicit audit store; defaults to one over `graphPool`. */
  auditStore?: MemoryPurgeAuditStore;
  /** Bundled seed directory (`MEMORY_SEED_DIR`). A re-seed purge resets the
   *  entries it contains and writes them back. Absent ⇒ re-seed is a no-op. */
  seedDir?: string;
  /** Tenant the KG purge runs against. Defaults to `'default'`. */
  tenantId?: string;
  /** Clock for the preview-token TTL; tests pin it. */
  now?: () => number;
}

/** A warning the UI translates: `adminDangerZone.warnings.<code>`. */
export interface PurgeWarning {
  code:
    | 'kg_not_modelled'
    | 'kg_history_unsupported'
    | 'user_axis_kg_only'
    | 'user_axis_scratch_only'
    | 'audit_unavailable'
    | 'audit_update_failed'
    | 'reseed_failed';
  params?: Record<string, string>;
}

interface PurgePlan {
  scratchTargets: string[];
  mkFilter: MemorableKnowledgePurgeFilter | null;
  conversationFilter: ConversationHistoryPurgeFilter | null;
  reseedEntries: string[];
}

/**
 * The KG filters for an axis. `null` for team/channel: no KG column models
 * that scoping yet, and a fabricated filter would delete the wrong rows.
 *
 * For `user` the selector is matched raw: as an MK `aclOwner` and as the
 * conversation nodes' `user_id`, both the omadia user id. The scratch half
 * reads the same selector as a context key unless it is a user id, which is
 * why {@link userAxisWarning} reports a half that matched nothing.
 */
function kgFilters(
  axis: MemoryPurgeAxis,
  selector: string,
  tenantId: string,
): Pick<PurgePlan, 'mkFilter' | 'conversationFilter'> {
  switch (axis) {
    case 'all':
      return { mkFilter: { tenantId }, conversationFilter: { tenantId } };
    case 'agent':
      return {
        mkFilter: { tenantId, originAgent: selector },
        conversationFilter: { tenantId, agentSlug: selector },
      };
    case 'user':
      return {
        mkFilter: { tenantId, aclOwner: selector },
        conversationFilter: { tenantId, userId: selector },
      };
    case 'team':
    case 'channel':
      return { mkFilter: null, conversationFilter: null };
  }
}

function userAxisWarning(
  scratch: number,
  kg: number,
): PurgeWarning | undefined {
  if ((scratch > 0) === (kg > 0)) return undefined;
  return { code: scratch === 0 ? 'user_axis_kg_only' : 'user_axis_scratch_only' };
}

/**
 * The service's typed error code, when it carried one. Surfacing it instead of
 * a blanket `memory_purge_failed` is what lets the Danger-Zone UI tell a
 * mistyped selector (`invalid_selector`) apart from a store failure.
 */
function errorCode(err: unknown): string | undefined {
  if (err === null || typeof err !== 'object' || !('code' in err)) return undefined;
  const code = (err as { code: unknown }).code;
  // Only the service's own snake_case codes; a driver's code (Postgres
  // `23503`, Node `ENOENT`) is not part of this API.
  return typeof code === 'string' && SERVICE_ERROR_CODE.test(code) ? code : undefined;
}

const SERVICE_ERROR_CODE = /^[a-z][a-z_]*$/;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Who is purging — from the session, never from the body; the one actor
 *  rule of `admin_audit` (C07). A session that yields neither id nor email
 *  cannot be attributed, so it cannot purge. */
function actorOf(req: Request): MemoryPurgeActor | null {
  const actor = auditActorFromRequest(req);
  return actor.id || actor.email ? actor : null;
}

/** Selection identity a preview token is bound to. */
function selectionKey(axis: MemoryPurgeAxis, selector: string, reseed: boolean): string {
  return JSON.stringify([axis, axis === 'all' ? '' : selector, axis === 'all' && reseed]);
}

/**
 * Preview tokens: proof that `POST /preview` ran for this exact selection a
 * short while ago. Process-local by design — the middleware runs as a single
 * process, and a restart between preview and delete just asks for a new
 * preview. Single use: a successful audit start consumes it.
 */
class PreviewTokens {
  private readonly tokens = new Map<string, { key: string; expiresAt: number }>();

  constructor(private readonly now: () => number) {}

  issue(key: string): { token: string; expiresAt: number } {
    const now = this.now();
    for (const [token, entry] of this.tokens) {
      if (entry.expiresAt <= now) this.tokens.delete(token);
    }
    const token = randomBytes(24).toString('base64url');
    const expiresAt = now + PREVIEW_TOKEN_TTL_MS;
    this.tokens.set(token, { key, expiresAt });
    return { token, expiresAt };
  }

  valid(token: string | undefined, key: string): boolean {
    if (!token) return false;
    const entry = this.tokens.get(token);
    return entry !== undefined && entry.key === key && entry.expiresAt > this.now();
  }

  consume(token: string): void {
    this.tokens.delete(token);
  }
}

export function createMemoryPurgeRouter(deps: MemoryPurgeDeps): Router {
  const router = Router();
  const tenantId = deps.tenantId ?? 'default';
  const auditStore =
    deps.auditStore ??
    (deps.graphPool ? createMemoryPurgeAuditStore(deps.graphPool) : undefined);
  const tokens = new PreviewTokens(deps.now ?? Date.now);

  /** The ONE selection both endpoints act on. Throws the service's typed
   *  errors (`selector_required`, `invalid_selector`). */
  async function planPurge(
    axis: MemoryPurgeAxis,
    selector: string,
    reseed: boolean,
  ): Promise<PurgePlan> {
    const reseedEntries =
      axis === 'all' && reseed && deps.seedDir ? await bundledSeedEntries(deps.seedDir) : [];
    const scratchTargets = await resolvePurgeTargets(deps.store, axis, selector, {
      reseedEntries,
    });
    return { scratchTargets, reseedEntries, ...kgFilters(axis, selector, tenantId) };
  }

  /** The KG's conversation-history primitives, when its provider has both. */
  function historyPrimitives(): Required<
    Pick<KnowledgeGraph, 'countConversationHistory' | 'purgeConversationHistory'>
  > | null {
    const kg = deps.knowledgeGraph;
    if (!kg?.countConversationHistory || !kg.purgeConversationHistory) return null;
    return {
      countConversationHistory: kg.countConversationHistory.bind(kg),
      purgeConversationHistory: kg.purgeConversationHistory.bind(kg),
    };
  }

  async function countPlan(plan: PurgePlan): Promise<MemoryPurgeCounts> {
    const kg = deps.knowledgeGraph;
    const history = historyPrimitives();
    return {
      scratch: plan.scratchTargets.length,
      kg: kg && plan.mkFilter ? (await kg.countMemorableKnowledge(plan.mkFilter)).count : 0,
      conversation:
        history && plan.conversationFilter
          ? (await history.countConversationHistory(plan.conversationFilter)).count
          : 0,
    };
  }

  /** Runs the three layers in order, filling `deleted` as each finishes, so
   *  a failure part-way still reports what is already gone. */
  async function executePlan(plan: PurgePlan, deleted: MemoryPurgeCounts): Promise<void> {
    const kg = deps.knowledgeGraph;
    const history = historyPrimitives();
    deleted.scratch = await deletePurgeTargets(deps.store, plan.scratchTargets);
    if (kg && plan.mkFilter) {
      deleted.kg = (await kg.purgeMemorableKnowledge(plan.mkFilter)).deletedNodes;
    }
    if (history && plan.conversationFilter) {
      deleted.conversation = (
        await history.purgeConversationHistory(plan.conversationFilter)
      ).deletedNodes;
    }
  }

  function planWarnings(axis: MemoryPurgeAxis, counts: MemoryPurgeCounts): PurgeWarning[] {
    const warnings: PurgeWarning[] = [];
    if (axis === 'team' || axis === 'channel') {
      warnings.push({ code: 'kg_not_modelled', params: { axis } });
    } else if (deps.knowledgeGraph && !historyPrimitives()) {
      warnings.push({ code: 'kg_history_unsupported' });
    }
    if (axis === 'user') {
      const w = userAxisWarning(counts.scratch, counts.kg + counts.conversation);
      if (w) warnings.push(w);
    }
    if (!auditStore) warnings.push({ code: 'audit_unavailable' });
    return warnings;
  }

  // Dry-run preview — counts what a purge WOULD remove without mutating
  // anything, and arms a delete of the same selection.
  router.post('/preview', async (req: Request, res: Response) => {
    const parsed = PurgePreviewBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    const { axis, reseed = false } = parsed.data;
    const selector = (parsed.data.selector ?? '').trim();
    try {
      const plan = await planPurge(axis, selector, reseed);
      const counts = await countPlan(plan);
      const { token, expiresAt } = tokens.issue(selectionKey(axis, selector, reseed));
      res.json({
        scratchCount: counts.scratch,
        kgCount: counts.kg,
        conversationCount: counts.conversation,
        reseedEntries: plan.reseedEntries,
        warnings: planWarnings(axis, counts),
        previewToken: token,
        previewExpiresAt: new Date(expiresAt).toISOString(),
      });
    } catch (err) {
      res
        .status(400)
        .json({ error: errorCode(err) ?? 'memory_purge_preview_failed', message: errorMessage(err) });
    }
  });

  // Destructive purge.
  router.delete('/', async (req: Request, res: Response) => {
    const parsed = PurgeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    const { axis, confirm, previewToken, reseed = false } = parsed.data;
    const rawSelector = parsed.data.selector ?? '';
    const selector = rawSelector.trim();

    // Server-side type-to-confirm: 'all' demands the fixed phrase; every
    // other axis demands the selector be re-typed verbatim.
    //
    // "Verbatim" means the string the OPERATOR typed, never the `ctxKey` the
    // purge service derives from it. Confirming against the derived key would
    // make the gesture unperformable (the operator cannot type a sha256 stem)
    // and would silently accept two different selectors that normalise to one
    // key — the confirmation must guard the input, not the normalisation.
    const expected = axis === 'all' ? CONFIRM_ALL : rawSelector;
    if (confirm !== expected || (axis !== 'all' && selector.length === 0)) {
      res.status(400).json({ error: 'confirmation_mismatch' });
      return;
    }

    const key = selectionKey(axis, selector, reseed);
    if (!previewToken || !tokens.valid(previewToken, key)) {
      res.status(409).json({
        error: 'preview_required',
        message: 'run a preview of this exact selection first (preview tokens expire after 10 minutes)',
      });
      return;
    }
    // Spent before the first await: two concurrent DELETEs with one token
    // must not both pass. Any later refusal asks for a fresh preview.
    tokens.consume(previewToken);

    const actor = actorOf(req);
    if (!actor) {
      res.status(401).json({ error: 'auth.required', message: 'login required' });
      return;
    }

    let plan: PurgePlan;
    let planned: MemoryPurgeCounts;
    try {
      plan = await planPurge(axis, selector, reseed);
      planned = await countPlan(plan);
    } catch (err) {
      res.status(400).json({ error: errorCode(err) ?? 'memory_purge_failed', message: errorMessage(err) });
      return;
    }

    // Audit BEFORE deleting: a purge that cannot be recorded does not run.
    let auditId: string | undefined;
    if (auditStore) {
      try {
        auditId = await auditStore.recordStart({
          actor,
          axis,
          selector: axis === 'all' ? null : selector,
          reseed: axis === 'all' && reseed,
          planned: { ...planned, reseedEntries: plan.reseedEntries },
        });
      } catch (err) {
        console.error('[memory-purge] audit write failed, purge refused:', errorMessage(err));
        res.status(500).json({ error: 'audit_write_failed', message: errorMessage(err) });
        return;
      }
    } else {
      console.warn(
        `[memory-purge] no audit store — purge axis=${axis} by ${actor.email ?? actor.id} is NOT recorded`,
      );
    }
    const deleted: MemoryPurgeCounts = { scratch: 0, kg: 0, conversation: 0 };
    try {
      await executePlan(plan, deleted);
    } catch (err) {
      if (auditStore && auditId) {
        await auditStore
          .recordOutcome(auditId, { status: 'failed', deleted, error: errorMessage(err) })
          .catch((auditErr: unknown) => {
            console.error('[memory-purge] audit outcome write failed:', errorMessage(auditErr));
          });
      }
      res.status(500).json({ error: errorCode(err) ?? 'memory_purge_failed', message: errorMessage(err) });
      return;
    }

    const warnings = planWarnings(axis, deleted);
    let reseededFiles: number | undefined;
    let reseedError: string | undefined;
    if (plan.reseedEntries.length > 0 && deps.seedDir) {
      try {
        reseededFiles = await reseedMemory(deps.store, deps.seedDir);
      } catch (err) {
        reseedError = `reseed_failed: ${errorMessage(err)}`;
        console.error('[memory-purge] re-seed failed:', errorMessage(err));
        warnings.push({ code: 'reseed_failed' });
      }
    }

    if (auditStore && auditId) {
      try {
        await auditStore.recordOutcome(auditId, {
          status: 'completed',
          deleted,
          ...(reseedError ? { error: reseedError } : {}),
        });
      } catch (err) {
        console.error('[memory-purge] audit outcome write failed:', errorMessage(err));
        warnings.push({ code: 'audit_update_failed', params: { auditId } });
      }
    }

    res.json({
      scratchDeleted: deleted.scratch,
      kgDeleted: deleted.kg,
      conversationDeleted: deleted.conversation,
      ...(reseededFiles !== undefined ? { reseededFiles } : {}),
      ...(auditId ? { auditId } : {}),
      warnings,
    });
  });

  return router;
}
