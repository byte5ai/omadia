/**
 * The TEARDOWN half of `teamsProvisioner@1` — the primitives a failed
 * provisioning run needs in order to be undone, plus the vocabulary the
 * teardown reports itself in.
 *
 * WHY A TEARDOWN EXISTS AT ALL
 * ----------------------------
 * A run that dies in the middle leaves real objects behind: an Entra app
 * registration, an Azure bot service, a tenant catalog entry. Until now an
 * operator cleaned those up by hand in two Azure portals before they could
 * try again, and the identity row kept pointing at whichever of them had
 * survived.
 *
 * THE PURGE IS THE WHOLE POINT
 * ----------------------------
 * A deleted Entra application does not disappear. It goes to the directory's
 * recycle bin for 30 days and — this is the part that costs a month —
 * KEEPS RESERVING ITS `uniqueName` while it sits there. omadia derives that
 * name from the operator's bot slug (`omadia-teams-bot-<botSlug>`), so a
 * teardown that deletes without purging does not restore the starting
 * position: it makes the next attempt with the same slug collide with the
 * corpse of the previous one. That is byte5ai/omadia#916, and it burned a
 * slug for a month.
 *
 * So {@link TeamsProvisionerCleanupMethods.purgeDeletedAppRegistration} is
 * not an optimisation of the delete, it is the second half of it, and the
 * caller is required to treat the pair as ONE operation
 * (`services/teamsIdentityReset.ts` enforces that: it refuses to delete at
 * all when it cannot purge).
 *
 * AND THE PURGE NEEDS THE OBJECT ID, NOT THE APP ID
 * -------------------------------------------------
 * `DELETE /applications/{objectId}` and
 * `DELETE /directory/deletedItems/{objectId}` both address the DIRECTORY
 * OBJECT. `appId` — the client id — is a different identifier and the
 * deleted-items endpoint does not accept it. Once the application is in the
 * recycle bin it is gone from `/applications`, so `getAppRegistration` can no
 * longer resolve one identifier into the other: after the delete, the object
 * id is either already written down or lost, and losing it means losing the
 * slug for 30 days.
 *
 * There are therefore TWO independent bridges from the `appId` everyone still
 * has to the `objectId` the purge needs, and the teardown uses whichever it
 * can get:
 *
 *   * `app_object_id` (migration 0055) — written when the registration is
 *     created and re-written before any delete, so the id is on the row
 *     before the window where losing it hurts;
 *   * {@link TeamsProvisionerCleanupMethods.findDeletedAppRegistration} — a
 *     search of the recycle bin BY `appId`, which works after the delete and
 *     therefore rescues rows that predate the column entirely.
 *
 * Neither alone is enough: the column cannot help a row provisioned before it
 * existed, and the search cannot help against a connector too old to publish
 * it. Together they leave exactly one unrecoverable case — an application
 * deleted by hand, by someone else, before either mechanism saw it.
 *
 * VERSION SKEW, AS ALWAYS. Every method here is OPTIONAL on the accessor, each
 * with its own predicate — see the module doc of
 * `teamsProvisionerService.ts`, which re-exports everything here so consumers
 * keep their single import site.
 */

import type { DelegatedTokenSet } from './teamsDelegatedSignIn.js';

/**
 * Outcome vocabulary shared by every teardown primitive.
 *
 * `'already-absent'` IS A SUCCESS, and saying so in the type is the point:
 * a teardown is run precisely when nobody knows what still exists, so "it was
 * not there" answers the question the caller asked. Modelling it as an error
 * would make the second run of an interrupted reset fail on everything the
 * first run managed to finish — which is the opposite of resumable.
 */
export type CleanupOutcome<Done extends string> = Done | 'already-absent';

/** Input of {@link TeamsProvisionerCleanupMethods.purgeDeletedAppRegistration}. */
export interface PurgeDeletedAppRegistrationInput {
  /**
   * The DIRECTORY OBJECT id of the deleted application — NOT its `appId`.
   * See the module doc: the deleted-items endpoint knows no other name for
   * it, and after the delete there is no way left to look it up.
   */
  readonly objectId: string;
}

export interface PurgeDeletedAppRegistrationResult {
  readonly outcome: CleanupOutcome<'purged'>;
}

/** Input of {@link TeamsProvisionerCleanupMethods.findDeletedAppRegistration}. */
export interface FindDeletedAppRegistrationInput {
  /**
   * The application's CLIENT id — the identifier that survives in the row
   * (`agent_teams_identities.app_id`) and in the Teams manifest, and the only
   * one anybody still has once the delete has landed.
   */
  readonly appId: string;
}

/**
 * `found: false` is the good news: no tombstone, so the `uniqueName` is free
 * and there is nothing left to purge. It is deliberately NOT the same answer
 * as "we could not look" — a connector too old to search reports its absence
 * through {@link supportsDeletedAppRegistrationLookup}, so the caller can
 * tell "provably gone" from "no idea".
 */
export type FindDeletedAppRegistrationResult =
  | { readonly found: true; readonly objectId: string }
  | { readonly found: false };

/**
 * The purge was handed an `appId` where a DIRECTORY OBJECT id belongs
 * (connector >= 0.8.0).
 *
 * Worth a typed error rather than a 404 because the two identifiers are both
 * GUIDs: the mistake is invisible in a log line, and Graph's own answer
 * ("Resource not found") points at the wrong problem entirely — it reads as
 * "already purged" when in fact the tombstone is sitting right there holding
 * the agent's `uniqueName`. THAT is the misreading this error exists to stop,
 * and it is why nothing in this codebase may treat a 404 from the purge as
 * proof of a clean recycle bin.
 *
 * The connector resolves the correct id while it is refusing, and ships it on
 * {@link objectId} — so the recovery is one retry with the value the error
 * itself carries, not a second search.
 *
 * Duck-typed on `name`, like every other connector error guard: the class
 * identity belongs to the plugin, not to us.
 */
export interface DeletedObjectIdMismatchLike extends Error {
  readonly name: 'DeletedObjectIdMismatchError';
  /** The directory object id the call SHOULD have been given. */
  readonly objectId?: string;
}

export function isDeletedObjectIdMismatchError(
  err: unknown,
): err is DeletedObjectIdMismatchLike {
  return err instanceof Error && err.name === 'DeletedObjectIdMismatchError';
}

/** The corrected object id a {@link DeletedObjectIdMismatchLike} carries, when
 *  it carries one. A connector that refuses without naming the right id is
 *  still handled — the caller falls back to searching the recycle bin. */
export function correctedObjectIdOf(err: unknown): string | undefined {
  if (!isDeletedObjectIdMismatchError(err)) return undefined;
  const { objectId } = err;
  return typeof objectId === 'string' && objectId !== '' ? objectId : undefined;
}

/** Input of {@link TeamsProvisionerCleanupMethods.removeFromCatalog}. */
export interface RemoveFromCatalogInput {
  /** Catalog id (`CatalogTeamsApp.teamsAppId`) — NOT the external id. */
  readonly teamsAppId: string;
  /**
   * REQUIRED, unlike everywhere else the delegated token set appears.
   * `DELETE /appCatalogs/teamsApps/{id}` is delegated-only at Microsoft for
   * the same reason the upload is (#924): Application permissions are
   * documented as "Not supported". A teardown therefore cannot remove the
   * catalog entry of a tenant nobody has signed into, and the honest answer
   * is to report that step as blocked rather than to try app-only and
   * classify the 403 afterwards.
   *
   * NO NEW CONSENT, though: the existing delegated `AppCatalog.ReadWrite.All`
   * already covers the delete, so a tenant that can be provisioned can also
   * be torn down. Whoever is signed in today is enough — unlike chat
   * enumeration, which does need a fresh sign-in
   * (`platform/teamsTargetDirectory.ts`).
   */
  readonly tokens: DelegatedTokenSet;
}

export interface RemoveFromCatalogResult {
  readonly outcome: CleanupOutcome<'removed'>;
}

/**
 * The teardown methods, as an interface of its own so the accessor can
 * mix it in with `Partial<…>` (same construction as
 * `TeamsDelegatedProvisionerMethods` and `TeamsTargetDirectoryMethods`).
 *
 * The other two primitives a reset needs — `deleteAppRegistration` and
 * `deleteBot` — are NOT here: they have been on the mandatory surface of
 * `TeamsProvisionerAccessor` since the first wave, and duplicating them into
 * an optional mixin would make two shipped methods look like they might be
 * missing.
 */
export interface TeamsProvisionerCleanupMethods {
  /** Empty the recycle bin of ONE deleted application — the half of the
   *  delete that gives the `uniqueName` back. */
  purgeDeletedAppRegistration(
    input: PurgeDeletedAppRegistrationInput,
  ): Promise<PurgeDeletedAppRegistrationResult>;
  /**
   * Look up a deleted application in the directory's recycle bin BY ITS
   * CLIENT ID, and answer with the object id the purge needs.
   *
   * THIS IS WHAT MAKES AN INTERRUPTED TEARDOWN SURVIVABLE. Without it the
   * only bridge from the identifier everyone still has (`appId`) to the one
   * the purge requires (`objectId`) is `getAppRegistration` — which stops
   * working the instant the delete lands, i.e. exactly in the window where an
   * interruption hurts. A teardown that died between the delete and the purge
   * could then never find its own tombstone again, and the agent's
   * `uniqueName` stayed reserved for 30 days (byte5ai/omadia#916).
   *
   * With this method the recovery is mechanical: the row still carries
   * `app_id` (the teardown clears it only after the purge is confirmed), so a
   * second call searches, finds, and finishes.
   */
  findDeletedAppRegistration(
    input: FindDeletedAppRegistrationInput,
  ): Promise<FindDeletedAppRegistrationResult>;
  /** Withdraw the agent's app from the tenant app catalog. */
  removeFromCatalog(input: RemoveFromCatalogInput): Promise<RemoveFromCatalogResult>;
}

/** Method names of this half, as data — so a forwarder cannot drift from the
 *  interface above. */
export const CLEANUP_METHOD_NAMES = [
  'purgeDeletedAppRegistration',
  'findDeletedAppRegistration',
  'removeFromCatalog',
] as const satisfies readonly (keyof TeamsProvisionerCleanupMethods)[];

/**
 * Does the CURRENTLY INSTALLED connector publish the recycle-bin purge?
 *
 * THE MOST CONSEQUENTIAL GUARD IN THIS FILE. A `false` here does not degrade
 * the teardown, it FORBIDS the app-registration step entirely: deleting
 * without purging is strictly worse than not deleting, because it converts a
 * reusable registration into a 30-day reservation on the operator's own slug.
 * `services/teamsIdentityReset.ts` is where that refusal lives.
 */
export function supportsAppRegistrationPurge(
  provisioner: { readonly purgeDeletedAppRegistration?: unknown } | undefined,
): boolean {
  return typeof provisioner?.purgeDeletedAppRegistration === 'function';
}

/**
 * Does it publish the recycle-bin lookup?
 *
 * Its absence is not fatal — a stored `app_object_id` (migration 0055) covers
 * the same ground for every identity provisioned since — but it IS the
 * difference between "provably no tombstone" and "no way to tell". A teardown
 * that cannot look must report an unresolvable application as a warning
 * rather than as a clean sweep.
 */
export function supportsDeletedAppRegistrationLookup(
  provisioner: { readonly findDeletedAppRegistration?: unknown } | undefined,
): boolean {
  return typeof provisioner?.findDeletedAppRegistration === 'function';
}

/** Does it publish catalog removal? Absent means the tenant catalog entry
 *  stays and the reset reports that step as unsupported — an orphan, not a
 *  blocker: the next run adopts the same `externalId`. */
export function supportsCatalogRemoval(
  provisioner: { readonly removeFromCatalog?: unknown } | undefined,
): boolean {
  return typeof provisioner?.removeFromCatalog === 'function';
}
