import {
  makePrincipal,
  parseSessionScope,
  resolveCapabilities,
  type Capability,
  type GrantStore,
  type Principal,
  type RoleSourceRegistry,
} from '@omadia/channel-sdk';
import type { PublishStore } from '@omadia/publish';

/**
 * Issue #581 P3 — publish sharing = a grant over `GrantStore` (#575), same
 * posture `skillSharing.ts` (#577) documents: this module never touches
 * `grants.ts`'s body, only its exported `GrantStore`/`resolveCapabilities`
 * contract. Two access kinds, matching the issue text exactly: `read` = use
 * a shared app (resolve/serve it), `write` = redeploy/rollback it.
 *
 * ## Ownership needs no grant lookup at all
 *
 * An app's OWNER is the scope key that published its version 1 —
 * `PublishVersionRecord.sourceScopeKey`, already recorded by P1, nothing
 * new to store. Checking ownership is therefore plain scope-key equality,
 * with two consequences that make the design simpler, not just cheaper:
 *
 *  - the owner's own apps are always usable/redeployable/rollback-able by
 *    the owner, EVEN IF the owner's scope can't be turned into a `Principal`
 *    at all (see below) — sharing cannot lock out the owner, by
 *    construction, not by a special-cased bypass.
 *  - an app that has never been published yet has no owner: the very first
 *    `publish` call for a fresh `appId` is what ESTABLISHES ownership, so
 *    it is allowed unconditionally (`reason: 'unpublished'`) rather than
 *    requiring a grant for a resource that does not exist yet.
 *
 * ## Fail CLOSED, unlike `skillSharing.ts`'s fail-open default
 *
 * `resolveSharedSkillIds`/`toSharedSkillIdsSet` deliberately default to "no
 * visible shares" on a grants-backend hiccup, because that can only ever
 * HIDE a skill that would have been visible. Here the failure direction is
 * the opposite: an unresolved grant lookup that read as "granted" would let
 * an unrelated scope redeploy or roll back someone else's app. So a
 * `Principal` that cannot be derived, or a `resolveCapabilities` outcome of
 * `undefined` ("unresolved" — a partial role lookup or a throwing store),
 * both deny. Same posture `executeTool.ts` takes for its command-policy
 * resolver: "throwing is FAIL-CLOSED".
 *
 * ## Principal resolution is scope-derived, not roster-derived — a known v1 gap
 *
 * `audienceFloorProvider.ts` resolves a `Principal` per chat participant via
 * a knowledge-graph join (`resolveOrCreateChannelIdentity`). Publish tools
 * have no roster — they run against a single calling turn's session scope.
 * A `personal:<userId>` scope's `userId` IS the same omadia-user-id space
 * `resolveOrCreateChannelIdentity` returns (#575/#333), so it is safe to
 * build a `Principal` directly from it (`makePrincipal('user', userId)`)
 * without a roster join. Every OTHER scope kind (`conversation`, `group`,
 * `org`, `system`, `unscoped`) has no single owning individual to resolve —
 * a non-owner caller on one of those scopes cannot hold a publish grant in
 * this version, full stop (denied, not silently treated as ungranted-but-
 * maybe-fine). Widening this to resolve a `Principal` for those scope kinds
 * too is future work, not a gap this module hides.
 */

export type PublishCapabilityKind = 'read' | 'write';

const PUBLISH_CAPABILITY_PREFIX: Readonly<Record<PublishCapabilityKind, string>> = {
  read: 'publish:read:',
  write: 'publish:write:',
};

/** The `Capability` string a grant records to share `appId` with its holder. */
export function publishCapability(kind: PublishCapabilityKind, appId: string): Capability {
  return `${PUBLISH_CAPABILITY_PREFIX[kind]}${appId}`;
}

export interface PublishSharingDeps {
  readonly grants: GrantStore;
  readonly roles: RoleSourceRegistry;
}

export interface CheckPublishAccessArgs {
  readonly appId: string;
  /** The calling turn's session scope key (e.g. `personal:u1`), the same
   *  string `execute`/`publish`'s `resolveScopeKey()` provisions a sandbox
   *  under. */
  readonly callerScopeKey: string;
  readonly capability: PublishCapabilityKind;
}

export type PublishAccessDecision =
  | { readonly allowed: true; readonly reason: 'owner' | 'unpublished' | 'granted' }
  | {
      readonly allowed: false;
      readonly reason: 'no_grant' | 'denied' | 'principal_unresolvable' | 'grant_lookup_unresolved';
    };

export async function checkPublishAccess(
  deps: { readonly store: Pick<PublishStore, 'getVersion'> } & PublishSharingDeps,
  args: CheckPublishAccessArgs,
): Promise<PublishAccessDecision> {
  const v1 = await deps.store.getVersion(args.appId, 1);
  if (!v1) return { allowed: true, reason: 'unpublished' };
  if (v1.sourceScopeKey === args.callerScopeKey) return { allowed: true, reason: 'owner' };

  const principal = principalForScope(args.callerScopeKey);
  if (!principal) return { allowed: false, reason: 'principal_unresolvable' };

  const resolved = await resolveCapabilities(principal, deps.roles, deps.grants);
  if (!resolved) return { allowed: false, reason: 'grant_lookup_unresolved' };

  const capability = publishCapability(args.capability, args.appId);
  // Denials win — same rule `audienceFloor.ts`/`skillSharing.ts` apply: a
  // capability granted AND denied is denied.
  if (resolved.denials.has(capability)) return { allowed: false, reason: 'denied' };
  if (resolved.capabilities.has(capability)) return { allowed: true, reason: 'granted' };
  return { allowed: false, reason: 'no_grant' };
}

function principalForScope(scopeKey: string): Principal | undefined {
  const scope = parseSessionScope(scopeKey);
  if (scope.kind !== 'personal') return undefined;
  return makePrincipal('user', scope.userId);
}

/**
 * Issue #581 P3 — `read`-gated `PublishGateway.resolveTarget` (the `read` =
 * "use a shared app" half of the issue's sharing model). NOT wired into a
 * live server anywhere in this PR: `PublishGateway` (P1) is an anonymous,
 * origin-isolated HTTP proxy by design — it strips `Cookie`/`Authorization`
 * before ever reaching an app backend, which means a raw request hitting it
 * carries no caller identity for THIS function to check. `callerScopeKey`
 * therefore has to come from whoever DOES have an authenticated identity
 * for the request — an authenticated preview/iframe route is the obvious
 * future caller, and that route's construction is #778's job, not this
 * library's. This factory is the read-side counterpart `checkPublishAccess`
 * makes possible, exercised end-to-end in `publishAccess.test.ts` against a
 * fake `portFor`, so it is ready the moment an authenticated caller exists —
 * publishing it here rather than leaving the read-share model half-built.
 */
export interface PortResolvableRuntime {
  portFor(appId: string, version: number): Promise<number | undefined>;
}

export interface PublishGatewayResolveTargetDeps extends PublishSharingDeps {
  readonly store: Pick<PublishStore, 'getVersion' | 'getPointer'>;
  readonly runtime: PortResolvableRuntime;
  /** Where a resolved container is reachable — `DockerPublishRuntime` binds
   *  its published port to `127.0.0.1` only (see P1's `dockerPublishRuntime.ts`),
   *  so this defaults to that; overridable for a future non-local backend. */
  readonly runtimeHost?: string;
}

/**
 * Builds a `(appSlug) => Promise<{host, port} | undefined>` compatible with
 * `PublishGatewayOptions.resolveTarget`, gated on `callerScopeKey` holding
 * `read` access (ownership OR a `publish:read:<appId>` grant) to the app.
 * A denied or nonexistent app both resolve to `undefined` — deliberately
 * indistinguishable from "no such app", so a probing caller cannot use this
 * to enumerate which app ids exist versus which merely aren't shared with
 * them.
 */
export function createGrantCheckedResolveTarget(
  deps: PublishGatewayResolveTargetDeps,
  callerScopeKey: string,
): (appSlug: string) => Promise<{ readonly host: string; readonly port: number } | undefined> {
  const runtimeHost = deps.runtimeHost ?? '127.0.0.1';
  return async (appSlug) => {
    const decision = await checkPublishAccess(deps, { appId: appSlug, callerScopeKey, capability: 'read' });
    if (!decision.allowed) return undefined;

    const pointer = await deps.store.getPointer(appSlug);
    if (!pointer) return undefined;
    const port = await deps.runtime.portFor(appSlug, pointer.currentVersion);
    if (!port) return undefined;
    return { host: runtimeHost, port };
  };
}
