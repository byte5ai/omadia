/**
 * #575 — durable handle→room bindings (migration 0036).
 *
 * The contract lives in `harness-orchestrator/src/attachmentBinding.ts`; this
 * is the Postgres side, built the same way as `PostgresGrantStore` and for the
 * same reasons:
 *
 *  - **It does not own the pool.** Injected, never closed. Issue #665 was one
 *    subsystem calling `close()` on a pool ~40 others shared.
 *  - **It is allowed to throw.** The caller turns a failure into a refusal.
 *    Swallowing a database error and reporting "no binding" would silently
 *    unbind every handle in the deployment, and the failure would be
 *    indistinguishable from the ordinary un-bound case — the same trap the
 *    grant store's header describes.
 *
 * ## `bindIfAbsent` must not overwrite
 *
 * The write is `ON CONFLICT DO NOTHING`, and that single clause is the security
 * property. An `UPSERT` would let a wider room re-bind a handle to itself and
 * then read it — the exact leak the binding exists to prevent, reintroduced by
 * a one-word change. It is also what makes a concurrent first sighting safe:
 * two turns racing on the same key leave exactly one row, and the loser's room
 * is compared against the winner's rather than replacing it.
 */

import type { Pool } from 'pg';

import type {
  AttachmentBindingStore,
  AttachmentScopeBinding,
} from '@omadia/orchestrator';

export class PostgresAttachmentBindingStore implements AttachmentBindingStore {
  constructor(private readonly pool: Pool) {}

  async get(storageKey: string): Promise<AttachmentScopeBinding | undefined> {
    const result = await this.pool.query<{ scope_kind: string; scope_ref: string }>(
      `SELECT scope_kind, scope_ref FROM attachment_scope_bindings WHERE storage_key = $1`,
      [storageKey],
    );
    const row = result.rows[0];
    return row ? { scopeKind: row.scope_kind, scopeRef: row.scope_ref } : undefined;
  }

  async bindIfAbsent(storageKey: string, binding: AttachmentScopeBinding): Promise<void> {
    await this.pool.query(
      `INSERT INTO attachment_scope_bindings (storage_key, scope_kind, scope_ref)
       VALUES ($1, $2, $3)
       ON CONFLICT (storage_key) DO NOTHING`,
      [storageKey, binding.scopeKind, binding.scopeRef],
    );
  }
}
