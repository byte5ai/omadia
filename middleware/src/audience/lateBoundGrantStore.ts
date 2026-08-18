/**
 * #575 phase 2 — a {@link GrantStore} that resolves its backing store later.
 *
 * ## Why this indirection has to exist
 *
 * The orchestrator plugin reads the services it consumes at **activation**, and
 * `index.ts` publishes those before `toolPluginRuntime.activateAllInstalled()`
 * for exactly that reason. But `graphPool` is published BY a plugin — the
 * knowledge-graph one — during that same activation pass, and is only readable
 * afterwards. So at the moment the grant store must be published, the pool it
 * needs does not exist yet.
 *
 * The codebase already solves this shape with a forward reference (see
 * `conductorTemplateRegistrarRef` in `index.ts`): publish something now, point
 * it at a holder, fill the holder in once the dependency resolves.
 *
 * ## Not-yet-hydrated must THROW, not return an empty list
 *
 * This is the whole reason the file has a header rather than being three lines
 * inline. `GrantStore`'s contract says a store that cannot answer must throw,
 * and `resolveCapabilities` turns that throw into an `unresolved` audience
 * member — which closes the floor **with a reason an operator can act on**.
 *
 * Returning `[]` instead would be catastrophic in a way that looks harmless:
 * an empty capability list is a perfectly well-formed answer, so the floor
 * would intersect it into a smaller set and refuse things silently. The room
 * would behave as though an operator had decided to forbid everything, and the
 * actual cause — the store was consulted before it was ready — would leave no
 * trace anywhere.
 *
 * Between "closed, and here is why" and "closed, cause unknown", only the first
 * is a system anyone can operate.
 */

import type { Capability, GrantStore, Principal } from '@omadia/channel-sdk';
import type {
  AttachmentBindingStore,
  AttachmentScopeBinding,
} from '@omadia/orchestrator';

export class GrantStoreNotReadyError extends Error {
  constructor() {
    super(
      'audience grant store is not hydrated yet — the audience floor was consulted before Postgres resolved. ' +
        'The floor is closed until the store is available; this is not a policy decision.',
    );
    this.name = 'GrantStoreNotReadyError';
  }
}

/**
 * Wrap a holder that is filled in later.
 *
 * @param resolve returns the real store, or `undefined` while still unhydrated.
 */
export function createLateBoundGrantStore(
  resolve: () => GrantStore | undefined,
): GrantStore {
  const target = (): GrantStore => {
    const store = resolve();
    if (!store) throw new GrantStoreNotReadyError();
    return store;
  };

  return {
    async directGrants(principal: Principal): Promise<readonly Capability[]> {
      return target().directGrants(principal);
    },
    async roleGrants(roleKey: string): Promise<readonly Capability[]> {
      return target().roleGrants(roleKey);
    },
  };
}

/**
 * The same forward reference for #575's handle→room bindings, which the
 * orchestrator plugin also consumes at activation.
 *
 * Unhydrated throws here too, and the consequence is the mirror image of the
 * grant case: the reader wrapper turns a throwing binding store into a
 * **refusal**, so a handle is withheld rather than read. Reporting "no binding"
 * instead would silently unbind every handle in the deployment for as long as
 * the store stayed unresolved.
 */
export function createLateBoundAttachmentBindingStore(
  resolve: () => AttachmentBindingStore | undefined,
): AttachmentBindingStore {
  const target = (): AttachmentBindingStore => {
    const store = resolve();
    if (!store) throw new GrantStoreNotReadyError();
    return store;
  };

  return {
    async get(storageKey: string): Promise<AttachmentScopeBinding | undefined> {
      return target().get(storageKey);
    },
    async bindIfAbsent(storageKey: string, binding: AttachmentScopeBinding): Promise<void> {
      return target().bindIfAbsent(storageKey, binding);
    },
  };
}
