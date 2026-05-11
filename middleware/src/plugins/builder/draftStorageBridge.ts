import type { LiveProfileStorageService } from '../../profileStorage/liveProfileStorageService.js';
import type { DraftStoreOptions } from './draftStore.js';
import { specToAgentMd } from './specToAgentMd.js';

/**
 * Builds the `onUpdated` hook that mirrors builder draft saves into
 * Phase-2.1.5 `profile_agent_md` (OB-83 bridge). Wired into the
 * `DraftStore` constructor in `index.ts`; the store calls the hook
 * after every successful `update()` whose patch touched `spec` or
 * `name` (i.e. fields the rendered agent.md depends on).
 *
 * The hook itself never throws — the store wraps it with a try/catch
 * and logs failures, because the primary draft state has already been
 * committed to SQLite. A mirror failure leaves `profile_agent_md` one
 * save behind; the next mirror-relevant update reconciles it.
 *
 * Architecture invariant: `draft_id == profile_id`. Snapshots / Rollback
 * / Diff (Phase 2.2) all key on the same id, so no mapping table is
 * needed.
 *
 * Pass-through: when `liveProfileStorage` is undefined (in-memory test
 * mode, or boot before storage is wired), this builder returns
 * `undefined` so the store stays hook-less.
 */
export function buildDraftStorageMirrorHook(deps: {
  liveProfileStorage?: LiveProfileStorageService;
  log?: (msg: string) => void;
}): DraftStoreOptions['onUpdated'] | undefined {
  const storage = deps.liveProfileStorage;
  if (!storage) return undefined;
  return async ({ draft, userEmail }) => {
    const bytes = specToAgentMd({
      draftId: draft.id,
      draftName: draft.name,
      spec: draft.spec,
    });
    const actor = userEmail.length > 0 ? userEmail : 'builder';
    await storage.setAgentMd(draft.id, bytes, actor);
  };
}
