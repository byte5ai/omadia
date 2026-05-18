import type { DraftStore } from './draftStore.js';

/**
 * Builder audit-log helper (issue #56).
 *
 * Fire-and-forget logging surface for mutating Builder tools. Every
 * write is wrapped in a try/catch so a logging failure can never break
 * the calling tool — the operator's persona / quality / spec edit still
 * lands; only the audit row is lost. Errors are swallowed silently
 * (intentional — there is no actionable signal for the operator).
 *
 * Schema lives in `draftStore.ts` (v1 → v2 migration, `builder_audit`
 * table). The API surface is in `routes/builderAudit.ts`.
 */

export interface AuditLogger {
  /**
   * Append an audit event for a draft mutation. Fire-and-forget:
   * resolves to void regardless of underlying DB success.
   */
  log(
    draftId: string,
    userEmail: string,
    action: string,
    details?: Readonly<Record<string, unknown>>,
  ): Promise<void>;
}

export interface AuditEvent {
  id: number;
  draftId: string;
  userEmail: string;
  action: string;
  details: Readonly<Record<string, unknown>>;
  createdAt: number;
}

export interface AuditListOptions {
  limit?: number;
  offset?: number;
}

/**
 * Build an AuditLogger backed by `DraftStore`'s SQLite handle. The
 * store exposes `appendAudit()` and `listAudit()` (added in v2);
 * this thin wrapper isolates the rest of the codebase from the
 * DraftStore surface so future log sinks (file, syslog, OTel) can
 * swap in cleanly.
 */
export function createAuditLogger(store: DraftStore): AuditLogger {
  return {
    async log(draftId, userEmail, action, details) {
      try {
        await store.appendAudit({
          draftId,
          userEmail,
          action,
          details: details ?? {},
        });
      } catch {
        // Fire-and-forget — never throw on audit failure. The operator
        // mutation already landed; losing the audit row is preferable
        // to bubbling a logging error back up to the tool result.
      }
    },
  };
}

/**
 * No-op logger for tests / harnesses that don't care about audit rows.
 * Existing BuilderToolHarness tests can plug this in without touching
 * the SQLite store, which keeps the test suite fast.
 */
export const noopAuditLogger: AuditLogger = {
  async log() {
    /* discard */
  },
};
