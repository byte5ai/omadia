import {
  RoleHolderRegistry,
  type AggregateHolderLookup,
  type HolderLookup,
  type RoleHolderSource,
} from '@omadia/channel-sdk';

import type { ConductorRoleStore } from './roleStore.js';

/**
 * #333 Phase 3 — wires Conductor's role→holder resolution onto the pluggable
 * registry that `roleStore.ts:22` has been calling "a follow-up" since US5.
 *
 * The local assignment table is registered as an ordinary `RoleHolderSource`
 * rather than being special-cased ahead of the others. That is deliberate: with
 * one code path, the local store gets the same throw-becomes-`unavailable`
 * handling as any remote directory, and there is no second merge routine that
 * could drift from the first.
 *
 * ## The id is load-bearing for the operator gate
 *
 * `'conductor-local'` is reserved for this source. An external source claiming
 * that id would collide at registration (the registry throws) rather than
 * silently shadowing the assignment table — which would be a way to substitute
 * one's own approver list.
 */
export const LOCAL_ROLE_HOLDER_SOURCE_ID = 'conductor-local';

/**
 * The `conductor_role_assignments` table as a holder source.
 *
 * A database error surfaces as `unavailable`, NOT as "no holders". Before this
 * the distinction did not exist: `roleStore.resolve()` rejected, and the
 * rejection propagated. Now the caller sees a partial result and can refuse to
 * conclude from it — which is the entire point of the phase.
 */
export function localRoleHolderSource(roleStore: ConductorRoleStore): RoleHolderSource {
  return {
    id: LOCAL_ROLE_HOLDER_SOURCE_ID,
    displayName: 'Conductor role assignments',
    async holdersFor(roleKey: string): Promise<HolderLookup> {
      const holders = await roleStore.resolve(roleKey);
      return { outcome: 'resolved', holders };
    },
  };
}

/**
 * Builds the registry Conductor resolves through: the local table plus whatever
 * external sources the operator activated.
 *
 * Passing no external sources reproduces today's behaviour exactly — one
 * source, never partial — so introducing this seam changes nothing until a
 * deployment opts in.
 */
export function buildRoleHolderRegistry(
  roleStore: ConductorRoleStore,
  externals: readonly RoleHolderSource[] = [],
): RoleHolderRegistry {
  const registry = new RoleHolderRegistry();
  registry.register(localRoleHolderSource(roleStore));
  for (const source of externals) registry.register(source);
  return registry;
}

/** The resolver shape Conductor's executor and workers consume. */
export type RoleHolderResolver = (roleKey: string) => Promise<AggregateHolderLookup>;

/**
 * Adapter for the call sites that legitimately only need a list — the operator
 * inbox and the reminder nudger. Both degrade gracefully on a partial result:
 * they show or nudge whoever is known, and showing fewer people is not a
 * correctness failure the way completing a quorum with fewer people is.
 *
 * Deliberately NOT used by `RunExecutor`. Its two decisions
 * (`quorum='all'` completeness and "no holder → take the fallback") fail OPEN on
 * a shrunken list, so they must see `partial` and are typed to receive it.
 */
export function holdersOnly(resolver: RoleHolderResolver): (roleKey: string) => Promise<string[]> {
  return async (roleKey) => [...(await resolver(roleKey)).holders];
}
