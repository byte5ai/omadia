/**
 * #1790 — the daily purge of soft-deleted, published Builder drafts.
 *
 * `DraftStore.purgePublished` existed with no caller, so deleted drafts and
 * their vault namespaces stayed forever. The purge removes the rows past the
 * store's grace period and drops each draft's test credentials
 * (`PreviewSecretBuffer`) with them. Unpublished deleted drafts are never
 * purged automatically (losing in-flight work to a timer); the operator
 * removes those with "delete permanently".
 */

import type { DraftStore } from './draftStore.js';
import type { PreviewSecretBuffer } from './previewSecretBuffer.js';

export const DRAFT_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface DraftPurgeDeps {
  readonly draftStore: Pick<DraftStore, 'purgePublished'>;
  readonly previewSecretBuffer: Pick<PreviewSecretBuffer, 'drop'>;
  readonly log?: (line: string) => void;
}

/** One purge pass. Returns the number of drafts removed. */
export async function purgeDeletedDrafts(deps: DraftPurgeDeps, now = Date.now()): Promise<number> {
  const purged = await deps.draftStore.purgePublished(now);
  for (const d of purged) {
    try {
      await deps.previewSecretBuffer.drop(d.userEmail, d.id);
    } catch (err) {
      deps.log?.(
        `[builder] draft purge: test credentials of ${d.id} not dropped: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  if (purged.length > 0) deps.log?.(`[builder] draft purge: removed ${String(purged.length)} draft(s)`);
  return purged.length;
}

/** Runs a pass now and then daily; the timer never keeps the process alive. */
export function startDraftPurge(deps: DraftPurgeDeps, intervalMs = DRAFT_PURGE_INTERVAL_MS): () => void {
  const run = (): void => {
    void purgeDeletedDrafts(deps).catch((err: unknown) => {
      deps.log?.(`[builder] draft purge failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
