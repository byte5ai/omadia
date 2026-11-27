// ADR-0300 — one sync run of one directory source.
//
// Full read when no cursor is stored (or the source asks for a resync),
// incremental (Graph delta link) otherwise. Pages are applied as they come;
// the new cursor is stored only after the last page, so a broken run repeats
// from the old cursor (re-applying changes is idempotent). Only a COMPLETED
// full read deprovisions people it did not contain.

import { randomUUID } from 'node:crypto';

import type { DirectoryDeltaResult, DirectoryPersonChange, DirectorySource } from '@omadia/channel-sdk';

import type { DirectoryPerson, DirectoryStore } from './directoryStore.js';

/** Why a person is deprovisioned (audit `after.reason`). */
export type DeprovisionReason = 'removed' | 'disabled' | 'not_in_full_read';

export interface DirectorySyncDeps {
  readonly store: Pick<
    DirectoryStore,
    | 'getSyncState'
    | 'markRunStarted'
    | 'markRunCompleted'
    | 'markRunFailed'
    | 'upsert'
    | 'findByExternalId'
    | 'listUnseenActive'
    | 'countActive'
  >;
  /** Audit, token revocation, unlinking, then the status flip. */
  readonly deprovision: (person: DirectoryPerson, reason: DeprovisionReason) => Promise<void>;
  readonly log: (message: string) => void;
}

export type DirectorySyncOutcome =
  | { readonly outcome: 'completed'; readonly full: boolean; readonly applied: number; readonly deprovisioned: number }
  | { readonly outcome: 'failed'; readonly error: string };

/**
 * A completed full read that would deprovision more than this share of a
 * tenant's active people (with at least {@link MASS_DEPROVISION_MIN_ACTIVE}
 * active) is refused instead: a source that reads a partial or wrong tenant
 * must not revoke everyone's tokens. The run fails with `last_error` and
 * deprovisions nobody; removals the delta reports one by one still apply.
 */
export const MASS_DEPROVISION_MAX_SHARE = 0.5;
export const MASS_DEPROVISION_MIN_ACTIVE = 10;

/** A source that never ends its pages must not loop forever. */
export const MAX_SYNC_PAGES = 5_000;
const MAX_EXTERNAL_ID_LENGTH = 128;

async function readPage(source: DirectorySource, cursor: string | undefined): Promise<DirectoryDeltaResult> {
  try {
    return await source.delta(cursor);
  } catch (err) {
    return { outcome: 'unavailable', message: err instanceof Error ? err.message : String(err) };
  }
}

function isUsableChange(change: unknown): change is DirectoryPersonChange {
  if (change === null || typeof change !== 'object') return false;
  const id = (change as { externalId?: unknown }).externalId;
  return typeof id === 'string' && id.trim() !== '' && id.length <= MAX_EXTERNAL_ID_LENGTH;
}

interface RunState {
  full: boolean;
  runId: string | null;
  cursor: string | undefined;
  applied: number;
  deprovisioned: number;
}

export async function runDirectorySync(source: DirectorySource, deps: DirectorySyncDeps): Promise<DirectorySyncOutcome> {
  const { store } = deps;
  const kind = source.source;
  const tenantId = source.tenantId;
  const stored = await store.getSyncState(kind, tenantId);
  const startCursor = stored?.deltaCursor ?? undefined;
  const run: RunState = {
    full: startCursor === undefined,
    runId: startCursor === undefined ? randomUUID() : null,
    cursor: startCursor,
    applied: 0,
    deprovisioned: 0,
  };
  await store.markRunStarted(kind, tenantId);

  const fail = async (error: string, clearCursor = false): Promise<DirectorySyncOutcome> => {
    deps.log(`[directory-sync] ${kind}:${tenantId} failed — ${error}`);
    await store.markRunFailed(kind, tenantId, error, clearCursor);
    return { outcome: 'failed', error };
  };

  const deprovision = async (person: DirectoryPerson, reason: DeprovisionReason): Promise<void> => {
    if (person.status !== 'active') return;
    await deps.deprovision(person, reason);
    run.deprovisioned += 1;
  };

  const apply = async (change: DirectoryPersonChange): Promise<void> => {
    // Entra object ids are GUIDs; Teams states them lower-case.
    const externalId = change.externalId.trim().toLowerCase();
    if (change.removed) {
      const person = await store.findByExternalId(kind, tenantId, externalId);
      if (person) await deprovision(person, 'removed');
      return;
    }
    const { person } = await store.upsert(
      kind,
      tenantId,
      {
        externalId,
        ...(change.displayName !== undefined ? { displayName: change.displayName } : {}),
        ...(change.upn !== undefined ? { upn: change.upn } : {}),
        ...(change.mail !== undefined ? { mail: change.mail } : {}),
        ...(change.accountEnabled !== undefined ? { accountEnabled: change.accountEnabled } : {}),
      },
      run.runId,
    );
    run.applied += 1;
    if (!person.accountEnabled) await deprovision(person, 'disabled');
  };

  for (let page = 0; page < MAX_SYNC_PAGES; page += 1) {
    const result = await readPage(source, run.cursor);
    if (result.outcome === 'unavailable') return fail(result.message || 'source unavailable');
    if (result.outcome === 'resync') {
      // A full read that is itself told to resync cannot make progress.
      if (run.full) return fail('source asked for a resync during a full read', true);
      run.full = true;
      run.runId = randomUUID();
      run.cursor = undefined;
      continue;
    }
    const changes = Array.isArray(result.page?.changes) ? result.page.changes : [];
    try {
      for (const change of changes) if (isUsableChange(change)) await apply(change);
    } catch (err) {
      return fail(`applying a page failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (typeof result.page.nextCursor === 'string' && result.page.nextCursor !== '') {
      run.cursor = result.page.nextCursor;
      continue;
    }
    if (typeof result.page.deltaCursor !== 'string' || result.page.deltaCursor === '') {
      return fail('source ended a read without a cursor');
    }
    if (run.full && run.runId) {
      try {
        const unseen = await store.listUnseenActive(kind, tenantId, run.runId);
        const active = await store.countActive(kind, tenantId);
        if (active >= MASS_DEPROVISION_MIN_ACTIVE && unseen.length > active * MASS_DEPROVISION_MAX_SHARE) {
          return fail(
            `full read misses ${String(unseen.length)} of ${String(active)} active people — refusing to deprovision them`,
          );
        }
        for (const person of unseen) {
          await deprovision(person, 'not_in_full_read');
        }
      } catch (err) {
        return fail(`deprovisioning after a full read failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await store.markRunCompleted(kind, tenantId, result.page.deltaCursor, run.full);
    deps.log(
      `[directory-sync] ${kind}:${tenantId} ${run.full ? 'full' : 'delta'} read done — ${String(run.applied)} applied, ${String(run.deprovisioned)} deprovisioned`,
    );
    return { outcome: 'completed', full: run.full, applied: run.applied, deprovisioned: run.deprovisioned };
  }
  return fail(`more than ${String(MAX_SYNC_PAGES)} pages`);
}
