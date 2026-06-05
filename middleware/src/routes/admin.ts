import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { KnowledgeGraph, MemoryStore } from '@omadia/plugin-api';

import {
  previewMemoryPurge,
  purgeMemory,
  type MemoryPurgeAxis,
} from '../services/memoryPurge.js';

const PutBodySchema = z.object({
  path: z.string().min(1).startsWith('/memories'),
  content: z.string(),
  mode: z.enum(['create', 'overwrite']).default('overwrite'),
});

const DeleteBodySchema = z.object({
  path: z.string().min(1).startsWith('/memories'),
});

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

interface AdminDeps {
  store: MemoryStore;
  token: string;
  /** Optional — present only with a Postgres KG backend. Without it, the
   *  purge endpoints still run the scratch leg and report `kgDeleted: 0`. */
  knowledgeGraph?: KnowledgeGraph;
  /** pg Pool used for the `memory_purge_audit` row. Undefined ⇒ audit skipped
   *  (in-memory boot / DB-less tests). */
  graphPool?: Pool;
  /** Tenant the KG purge runs against. Defaults to `'default'`. */
  tenantId?: string;
}

/** Map a purge axis+selector to the KG MemorableKnowledge filter. Returns
 *  null for axes that have no KG column yet (team/channel) so the caller can
 *  surface a warning instead of fabricating a filter. */
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

/**
 * Admin endpoints for priming and inspecting memory from outside the orchestrator.
 * Auth: `Authorization: Bearer <ADMIN_TOKEN>`. Mounted only when ADMIN_TOKEN is set.
 */
export function createAdminRouter(deps: AdminDeps): Router {
  const router = Router();

  router.use((req: Request, res: Response, next: NextFunction) => {
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const supplied = header.slice('Bearer '.length).trim();
    if (!constantTimeEqual(supplied, deps.token)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  router.put('/memory', async (req: Request, res: Response) => {
    const parsed = PutBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    const { path: virtualPath, content, mode } = parsed.data;
    try {
      if (mode === 'create') {
        await deps.store.createFile(virtualPath, content);
      } else {
        await deps.store.writeFile(virtualPath, content);
      }
      res.json({ ok: true, path: virtualPath, mode });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: 'memory_write_failed', message });
    }
  });

  router.get('/memory/*path', async (req: Request, res: Response) => {
    const raw = req.params['path'];
    const segments = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
    const virtualPath = '/memories/' + segments.join('/');
    try {
      if (await deps.store.fileExists(virtualPath)) {
        const content = await deps.store.readFile(virtualPath);
        res.type('text/plain').send(content);
        return;
      }
      if (await deps.store.directoryExists(virtualPath)) {
        const entries = await deps.store.list(virtualPath);
        res.json({ path: virtualPath, entries });
        return;
      }
      res.status(404).json({ error: 'not_found', path: virtualPath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: 'memory_read_failed', message });
    }
  });

  router.delete('/memory', async (req: Request, res: Response) => {
    const parsed = DeleteBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    try {
      await deps.store.delete(parsed.data.path);
      res.json({ ok: true, path: parsed.data.path });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: 'memory_delete_failed', message });
    }
  });

  const tenantId = deps.tenantId ?? 'default';

  // Danger-Zone purge — dry-run preview. Counts what a purge WOULD remove
  // across both layers without mutating anything.
  router.post('/memory/purge/preview', async (req: Request, res: Response) => {
    const parsed = PurgePreviewBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    const { axis, selector } = parsed.data;
    try {
      const scratchCount = await previewMemoryPurge(deps.store, axis, selector);
      let kgCount = 0;
      let warning: string | undefined;
      const filter = axisToKgFilter(axis, selector, tenantId);
      if (filter === null) {
        warning = `${axis}-scoped Knowledge-Graph purge is not yet modeled (no KG column); only scratch memory is affected.`;
      } else if (deps.knowledgeGraph) {
        kgCount = (await deps.knowledgeGraph.countMemorableKnowledge(filter)).count;
      }
      res.json({ scratchCount, kgCount, ...(warning ? { warning } : {}) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: 'memory_purge_preview_failed', message });
    }
  });

  // Danger-Zone purge — destructive. Type-to-confirm enforced server-side.
  router.delete('/memory/purge', async (req: Request, res: Response) => {
    const parsed = PurgeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    const { axis, selector, confirm, reseed } = parsed.data;

    // Server-side type-to-confirm: 'all' demands the fixed phrase; every
    // other axis demands the selector be re-typed verbatim.
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
        warning = `${axis}-scoped Knowledge-Graph purge is not yet modeled (no KG column); only scratch memory was affected.`;
      } else if (deps.knowledgeGraph) {
        kgDeleted = (await deps.knowledgeGraph.purgeMemorableKnowledge(filter)).deletedNodes;
      }

      if (deps.graphPool) {
        try {
          await writePurgeAudit(deps.graphPool, {
            actor: 'admin-token',
            axis,
            selector: selector ?? null,
            scratchDeleted,
            kgDeleted,
          });
        } catch (auditErr) {
          // Audit failure must not mask a completed purge — log and continue.
          const m = auditErr instanceof Error ? auditErr.message : String(auditErr);
          console.error('[admin] memory_purge_audit write failed:', m);
        }
      }

      res.json({ scratchDeleted, kgDeleted, ...(warning ? { warning } : {}) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: 'memory_purge_failed', message });
    }
  });

  return router;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
