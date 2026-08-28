import type { NativeToolHandler } from '@omadia/plugin-api';

import { checkPublishAccess, type PublishSharingDeps } from './publishAccess.js';
import { createPublishHandler, resolveScopeKey, type CreatePublishHandlerOptions } from './publishTool.js';
import { createPublishRollbackHandler, type CreatePublishRollbackHandlerOptions } from './publishRollbackTool.js';

/**
 * Issue #581 P3 — grant-checked wrappers around P2's `createPublishHandler`/
 * `createPublishRollbackHandler`. Neither of those two functions is
 * modified: this module wraps them, exactly as the phase plan asks
 * ("wrapping createPublishHandler/createPublishRollbackHandler with a grant
 * check before delegating"). `plugin.ts` registers THESE when a
 * `GrantStore` is available, and falls back to the un-wrapped P2 handlers
 * (no sharing concept at all — every publish/rollback simply runs, exactly
 * as it did before P3 shipped) when no `GrantStore` is configured.
 *
 * Both wrappers resolve `appId` from the raw tool input themselves — before
 * the inner handler's own zod validation runs — so a malformed call still
 * reaches the inner handler's clearer validation error rather than a
 * confusing "no appId" message from this layer. Only a call that DOES name
 * a real `appId` gets the grant check; that is deliberate, not a bypass: a
 * caller who cannot even name a valid appId cannot publish/roll back
 * anything regardless of what this wrapper decides.
 */
export interface CreateGrantCheckedPublishHandlerOptions extends CreatePublishHandlerOptions {
  readonly sharing: PublishSharingDeps;
}

export interface CreateGrantCheckedPublishRollbackHandlerOptions extends CreatePublishRollbackHandlerOptions {
  readonly sharing: PublishSharingDeps;
}

function readAppId(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const appId = (input as Record<string, unknown>)['appId'];
  return typeof appId === 'string' && appId.length > 0 ? appId : undefined;
}

export function createGrantCheckedPublishHandler(options: CreateGrantCheckedPublishHandlerOptions): NativeToolHandler {
  const inner = createPublishHandler(options);
  return async (input) => {
    const appId = readAppId(input);
    if (appId === undefined) return inner(input);

    const callerScopeKey = resolveScopeKey();
    const decision = await checkPublishAccess(
      { store: options.store, grants: options.sharing.grants, roles: options.sharing.roles },
      { appId, callerScopeKey, capability: 'write' },
    );
    if (!decision.allowed) {
      return `Error: publish — refused: this scope does not own app '${appId}' and has no 'write' share grant for it (${decision.reason}). Ask the app's owner to share it with write access, or publish under a different appId.`;
    }
    return inner(input);
  };
}

export function createGrantCheckedPublishRollbackHandler(
  options: CreateGrantCheckedPublishRollbackHandlerOptions,
): NativeToolHandler {
  const inner = createPublishRollbackHandler(options);
  return async (input) => {
    const appId = readAppId(input);
    if (appId === undefined) return inner(input);

    const callerScopeKey = resolveScopeKey();
    const decision = await checkPublishAccess(
      { store: options.store, grants: options.sharing.grants, roles: options.sharing.roles },
      { appId, callerScopeKey, capability: 'write' },
    );
    if (!decision.allowed) {
      return `Error: publish_rollback — refused: this scope does not own app '${appId}' and has no 'write' share grant for it (${decision.reason}).`;
    }
    return inner(input);
  };
}
