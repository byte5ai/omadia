/**
 * Undo a Teams provisioning run — the teardown that lets an operator try
 * again after one died in the middle.
 *
 * WHAT A FAILED RUN LEAVES BEHIND
 * ------------------------------
 * The chain in `services/teamsProvisioningJob.ts` creates four things in
 * order: an Entra app registration, an Azure bot service, a tenant catalog
 * entry, and one or more installs. A run that dies at step 3 leaves the first
 * two alive, and the identity row pointing at both. Until now the way back
 * was two Azure portals and a `psql` session.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ORDER, AND WHY IT IS THIS ORDER
 * ─────────────────────────────────────────────────────────────────────────
 * The teardown runs BACKWARDS along the dependency chain — catalog entry,
 * then bot, then app registration, then the row — and the rule that produces
 * that order is: *no step may run before a step whose failure it would make
 * unrecoverable.* Concretely, three constraints, each of which independently
 * forces the same sequence:
 *
 *  1. THE CATALOG ENTRY MUST GO FIRST, AND ITS FAILURE MUST STOP EVERYTHING.
 *     `stableTeamsAppExternalId` derives the catalog `externalId` from the
 *     AGENT ID alone, so it survives any reset. The chain's step 4 asks
 *     `getCatalogApp({ externalId })` and, when it finds one, ADOPTS its
 *     `teamsAppId` without re-uploading. So a teardown that removed the app
 *     registration but left the catalog entry would produce the worst
 *     available outcome: the next run creates a NEW registration with a NEW
 *     `appId`, then adopts a catalog app whose manifest still names the OLD,
 *     deleted one. Every step reports success and the bot never answers a
 *     message. A visible failure is better than that, so a catalog entry that
 *     cannot be withdrawn aborts the teardown while everything is still
 *     intact and re-runnable.
 *
 *  2. THE BOT DEPENDS ON THE REGISTRATION, SO IT GOES BEFORE IT. The bot
 *     handle is `buildBotHandle(botSlug, appId)` — deleting the registration
 *     first would erase the only input the bot's own name is derived from,
 *     and with it the ability to find the bot again.
 *
 *  3. THE APP REGISTRATION IS THE ONE IRREVERSIBLE STEP, SO IT GOES LAST.
 *     See the delete/purge note below. Everything above it is an operation
 *     that a second attempt can simply repeat; this one is not. Putting it at
 *     the end means an abort at ANY earlier point leaves the world in exactly
 *     the state it was in before the teardown started — never a worse one.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DELETE AND PURGE ARE ONE OPERATION, NOT TWO
 * ─────────────────────────────────────────────────────────────────────────
 * A deleted Entra application spends 30 days in the directory's recycle bin
 * and KEEPS RESERVING ITS `uniqueName` the whole time. omadia derives that
 * name from the operator's bot slug, so deleting without purging does not
 * restore the starting position — it makes the next attempt with the same
 * slug collide with the corpse of the previous one. That is
 * byte5ai/omadia#916; it cost a slug for a month.
 *
 * Two consequences are implemented here rather than documented and hoped for:
 *
 *   * a connector that cannot purge is NOT allowed to delete
 *     ({@link supportsAppRegistrationPurge} gates the whole step). Refusing
 *     leaves a reusable registration; proceeding would convert it into a
 *     30-day reservation, which is strictly worse than doing nothing.
 *   * the purge needs the DIRECTORY OBJECT id, and after the delete there is
 *     no way left to look one up. So the object id is resolved and PERSISTED
 *     (migration 0055) before the delete, which is also what makes an
 *     interrupted teardown resumable: the retry still knows what to purge.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IDEMPOTENT, RESUMABLE, AND WITHOUT A CURSOR
 * ─────────────────────────────────────────────────────────────────────────
 * There is no progress cursor and no teardown state machine, on purpose.
 * Every primitive answers `'already-absent'` for something that is not there,
 * and this module treats that as success — so the correct way to resume an
 * interrupted teardown is simply to run the whole thing again. The steps that
 * already finished report `already-absent` and cost one API call each; the
 * one that did not gets its second attempt. A cursor would be a second source
 * of truth about Azure, and it would be wrong every time somebody deleted
 * something by hand.
 *
 * The ONE piece of state that is persisted mid-teardown is `app_object_id`,
 * and only because the alternative is losing it forever (see above).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PARTIAL SUCCESS IS THE NORMAL REPORT
 * ─────────────────────────────────────────────────────────────────────────
 * The result carries a per-step report, not a boolean. "Reset failed" as the
 * only signal is what makes an operator open two portals to find out what
 * actually happened. And the identity row is cleared ONLY when every step
 * above it is provably done: clearing `app_id` while the registration is
 * still alive would strand it — nothing would remember it existed, and the
 * slug would stay blocked with no way left to find out why.
 */

import {
  isDelegatedSignInRequiredError,
  isDelegatedTokenExpiredError,
  type DelegatedTokenSet,
} from '../platform/teamsDelegatedSignIn.js';
import { withDelegatedTokenRefresh } from '../platform/teamsDelegatedRefresh.js';
import {
  correctedObjectIdOf,
  isDeletedObjectIdMismatchError,
  supportsAppRegistrationPurge,
  supportsCatalogRemoval,
  supportsDeletedAppRegistrationLookup,
} from '../platform/teamsProvisionerCleanup.js';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * The teardown's steps, in execution order.
 *
 * They are written to the SAME progress log as a provisioning run
 * (`agent_teams_provisioning_events`, migration 0053) so the operator watches
 * one timeline rather than learning a second screen. That table's `step`
 * column is deliberately not CHECK-constrained, which is what makes adding
 * these four a code change and not a schema change.
 */
export const TEAMS_RESET_STEPS = [
  'catalog_removed',
  'bot_deleted',
  'app_deleted',
  'identity_reset',
  'identity_deleted',
] as const;

export type TeamsResetStep = (typeof TEAMS_RESET_STEPS)[number];

/**
 * HOW FAR BACK a teardown winds the agent.
 *
 * The three Azure steps are IDENTICAL for both — same order, same refusals,
 * same partial report. Only the last step differs, and only in what it does
 * to the database row:
 *
 *   * `'run'` — the original teardown (byte5ai/omadia#951). Azure is emptied
 *     and the row returns to `pending`, KEEPING `bot_slug` and
 *     `display_name`: the two answers a human typed, so a retry is one button
 *     with the same name.
 *   * `'identity'` — the row goes too, so the agent is back to having no
 *     Teams identity at all and the operator picks a new slug and a new
 *     display name from an empty form. This is what an operator wants when
 *     the identity itself was the mistake — a slug that reads wrong, a name
 *     nobody agreed to — rather than when a run merely died in the middle.
 *
 * BOTH ARE KEPT rather than one replacing the other, because they answer
 * genuinely different questions and the wrong one is expensive in both
 * directions: `'run'` on a bad slug leaves the operator unable to change it,
 * and `'identity'` on a died-mid-chain run makes them retype two fields they
 * had already got right. What the UI owes them in exchange is that nobody
 * can mistake one for the other — see the reset panel, where the destructive
 * one is confirmed by typing the slug rather than by ticking a box.
 */
export const TEAMS_RESET_SCOPES = ['run', 'identity'] as const;

export type TeamsResetScope = (typeof TEAMS_RESET_SCOPES)[number];

/**
 * The run-level step of a teardown — the counterpart of the chain's `'run'`.
 * One `started`, exactly one terminal event, so a UI can tell "this teardown
 * died in step 2" from "no teardown ever ran".
 */
export const TEAMS_RESET_RUN_STEP = 'reset';

/**
 * What happened to one step.
 *
 * `'already-absent'` and `'skipped'` are BOTH successes and they are kept
 * apart because they answer different questions: `already-absent` means the
 * thing existed as far as the row knew and Azure says it is gone (somebody
 * else removed it, or a previous attempt did); `skipped` means the row never
 * had the identifier at all, i.e. the run never got that far. An operator
 * reading a timeline wants to know which.
 *
 * `'blocked'` is the one that is neither success nor fault: a human action is
 * missing (a tenant sign-in) or the connector cannot do it. Nothing broke and
 * nothing was destroyed — which is precisely why it must not be reported as
 * `'failed'`.
 */
export type TeamsResetOutcome =
  | 'removed'
  | 'already-absent'
  | 'skipped'
  | 'blocked'
  | 'failed';

export interface TeamsResetStepReport {
  readonly step: TeamsResetStep;
  readonly outcome: TeamsResetOutcome;
  /** Short machine-readable code the UI localizes — never prose it parses,
   *  and never an identifier, a token or a URL (migration 0053's rule). */
  readonly detail?: string;
}

/** Detail codes. Closed vocabulary — the web UI has a message for each. */
export const TEAMS_RESET_DETAILS = {
  /** The row never carried the identifier this step removes. */
  nothingToRemove: 'nothing_to_remove',
  /** The connector publishes no `removeFromCatalog` (< 0.8.0). */
  catalogRemovalUnsupported: 'catalog_removal_unsupported',
  /** `DELETE /appCatalogs/teamsApps` is delegated-only: nobody is signed in. */
  tenantSignInRequired: 'tenant_sign_in_required',
  /**
   * Somebody IS signed in, the access token is spent, and renewing it failed.
   *
   * Its own code rather than a reuse of `tenantSignInRequired` for exactly the
   * reason the target listing had to learn the hard way: telling an operator
   * whose account is on screen to "sign in" is a sentence that cannot be
   * acted on. This one says the sign-in EXPIRED, which is a different fact
   * and points at a different cause — a revoked session, a password change, a
   * Conditional Access policy.
   *
   * `blocked`, never `failed`: nothing broke and nothing was destroyed, one
   * person has to sign in again.
   */
  tenantSignInExpired: 'tenant_sign_in_expired',
  /** The connector publishes no `purgeDeletedAppRegistration` (< 0.8.0).
   *  DELETING ANYWAY IS REFUSED — see the module doc. */
  purgeUnsupported: 'purge_unsupported',
  /**
   * The application is gone from `/applications`, no object id was ever
   * stored, AND the connector cannot search the recycle bin — so there is no
   * way left to tell a clean sweep from a tombstone still holding this
   * agent's `uniqueName`. Reported as a success with this note, because there
   * is genuinely no call left to make, but named rather than hidden behind a
   * bare `already-absent`: it is the one outcome after which retrying with
   * the same slug may still collide.
   */
  appAbsentUnpurgeable: 'app_absent_unpurgeable',
  /**
   * The application is gone AND the recycle bin was searched and is empty.
   * The strong version of `already-absent`: the `uniqueName` is provably
   * free, so the retry is safe.
   */
  appProvablyGone: 'app_provably_gone',
  /** ARM is not configured, so no bot service can ever have been created. */
  armNotConfigured: 'arm_not_configured',
  /**
   * A FULL reset refused to drop the row, because the row is the last trace
   * of an app registration nobody could prove is gone.
   *
   * Raised only for `'identity'` scope, and only after
   * {@link TEAMS_RESET_DETAILS.appAbsentUnpurgeable}: the application is not
   * in `/applications`, the connector cannot search the recycle bin, and so
   * nothing can say whether a tombstone is still holding this agent's
   * `uniqueName`. A `'run'` reset survives that uncertainty because the row
   * survives it too. Deleting the row would not.
   *
   * `app_id` is the ONLY input `findDeletedAppRegistration` takes. Drop the
   * row and a future connector that CAN search the recycle bin has nothing
   * left to search for — the tombstone becomes permanently unaddressable and
   * quietly holds the name for its thirty days. So the Azure work stands, the
   * row stays, and the operator is told to use the milder reset or upgrade
   * the connector.
   */
  appTraceRequired: 'app_trace_required',
} as const;

/** Prefixes for the failure details, mirroring the runner's convention of a
 *  `code:` prefix in front of a message. */
export const TEAMS_RESET_FAILURE_PREFIXES = {
  catalog: 'catalog_removal_failed:',
  bot: 'bot_deletion_failed:',
  appDelete: 'app_deletion_failed:',
  appPurge: 'app_purge_failed:',
  identity: 'identity_reset_failed:',
} as const;

export type TeamsIdentityResetResult =
  | {
      /**
       * Every step is done. The row is back at `pending` (`scope: 'run'`) or
       * gone entirely (`scope: 'identity'`) — {@link steps} says which, and
       * so does {@link scope}.
       */
      readonly status: 'reset';
      readonly agentId: string;
      readonly scope: TeamsResetScope;
      readonly steps: readonly TeamsResetStepReport[];
    }
  | {
      /**
       * The teardown stopped part-way. NOT a synonym for "nothing happened":
       * the steps that ran are in {@link steps} and they really did run. The
       * identity row is deliberately untouched, so a second call resumes.
       */
      readonly status: 'incomplete';
      readonly agentId: string;
      readonly scope: TeamsResetScope;
      readonly steps: readonly TeamsResetStepReport[];
      readonly stoppedAt: TeamsResetStep;
      readonly detail: string;
    };

// ---------------------------------------------------------------------------
// Ports — structural subsets, never the concrete classes
// ---------------------------------------------------------------------------

/** What the teardown needs to know about the identity it is undoing. */
export interface TeamsResetIdentityRecord {
  readonly agentId: string;
  readonly botSlug: string;
  readonly appId: string | null;
  readonly appObjectId: string | null;
  readonly teamsAppId: string | null;
}

export interface TeamsResetIdentityStore {
  getByAgentId(agentId: string): Promise<TeamsResetIdentityRecord | undefined>;
  /** Used for exactly one write before the row reset: persisting a
   *  freshly-resolved `app_object_id`. */
  update(
    agentId: string,
    patch: { readonly appObjectId?: string | null },
  ): Promise<unknown>;
  resetForRetry(agentId: string): Promise<unknown>;
  /**
   * Drop the row entirely — the last act of an `'identity'`-scope teardown.
   *
   * OPTIONAL so a mount (or a test) that only wired the milder teardown keeps
   * working unchanged. A full reset asked of a store without it is refused
   * before a single Azure object is touched, rather than half-performed: see
   * {@link resetTeamsIdentity}.
   */
  deleteForAgent?(agentId: string): Promise<unknown>;
}

/** The recorded team/chat bindings (migration 0051), when one is wired. */
export interface TeamsResetInstallStore {
  removeAllForAgent(agentId: string): Promise<number>;
}

/** Mirror of `DeleteBotResult` as this module consumes it. */
export type TeamsResetDeleteBotResult =
  | { readonly kind: 'deleted'; readonly outcome: 'deleted' | 'already-deleted' }
  | { readonly kind: 'registration-only'; readonly reason: 'arm-not-configured' };

/**
 * The provisioner surface a teardown uses — a structural subset of
 * `TeamsProvisionerAccessor`, exactly like `TeamsProvisionerPort` in the job
 * runner. The two optional methods are optional HERE too, so feature
 * detection reads the same object the call would go to.
 */
export interface TeamsResetProvisionerPort {
  readonly tenantMode: 'customer' | 'home';
  /**
   * Renew a spent delegated access token (connector >= 0.6.0). Optional like
   * every mirrored member; without it the teardown simply does not refresh
   * and reports a spent token as blocked, exactly as it did before.
   */
  refreshDelegatedToken?(input: {
    readonly tokens: DelegatedTokenSet;
  }): Promise<DelegatedTokenSet>;
  getAppRegistration(
    appId: string,
    tenantMode: 'customer' | 'home',
  ): Promise<{ readonly objectId: string } | undefined>;
  deleteAppRegistration(input: {
    readonly appId: string;
  }): Promise<{ readonly outcome: string }>;
  deleteBot(botName: string): Promise<TeamsResetDeleteBotResult>;
  purgeDeletedAppRegistration?(input: {
    readonly objectId: string;
  }): Promise<{ readonly outcome: string }>;
  findDeletedAppRegistration?(input: { readonly appId: string }): Promise<
    { readonly found: true; readonly objectId: string } | { readonly found: false }
  >;
  removeFromCatalog?(input: {
    readonly teamsAppId: string;
    readonly tokens: DelegatedTokenSet;
  }): Promise<{ readonly outcome: string }>;
}

/**
 * Where a teardown writes its progress notes — the SAME sink and the same
 * table a provisioning run writes to (`agent_teams_provisioning_events`,
 * migration 0053), so the operator watches one timeline instead of learning a
 * second screen.
 *
 * Structural, and optional on the options: a mount without Postgres runs the
 * teardown identically and simply leaves no timeline behind.
 */
export interface TeamsResetEventSink {
  record(input: {
    readonly agentId: string;
    readonly step: string;
    readonly status: 'started' | 'succeeded' | 'failed';
    readonly detail?: string | null;
  }): Promise<unknown>;
  clearForAgent(agentId: string): Promise<unknown>;
}

export type TeamsResetEmit = (
  step: TeamsResetStep | typeof TEAMS_RESET_RUN_STEP,
  status: 'started' | 'succeeded' | 'failed',
  detail?: string,
) => Promise<void>;

export interface TeamsIdentityResetOptions {
  readonly store: TeamsResetIdentityStore;
  readonly getProvisioner: () => TeamsResetProvisionerPort;
  /**
   * Injected rather than imported, to keep this module free of a cycle back
   * into `teamsProvisioningJob.ts` — which calls INTO here. It must be the
   * same `buildBotHandle` the chain used, or the teardown would look for a
   * bot under a name that was never created.
   */
  readonly buildBotHandle: (botSlug: string, appId: string) => string;
  readonly installs?: TeamsResetInstallStore;
  /**
   * The tenant sign-in the catalog removal rides on (#924/#949).
   *
   * `write` is optional and its absence is load-bearing — see
   * `platform/teamsDelegatedRefresh.ts`. Without somewhere to persist a
   * rotation the teardown must not refresh: spending the refresh token
   * without recording the replacement signs the whole tenant out, which is a
   * far worse outcome than the one blocked step it would have avoided.
   */
  readonly delegatedTokens?: {
    read(): Promise<DelegatedTokenSet | undefined>;
    write?(tokens: DelegatedTokenSet): Promise<void>;
  };
  /** Progress log. Absent = the teardown runs identically, silently. */
  readonly events?: TeamsResetEventSink;
  /** Wall clock, injectable — read only to decide whether the delegated
   *  access token is spent before the catalog removal spends a call on it. */
  readonly now?: () => Date;
  readonly log?: (msg: string) => void;
}

/** No identity row for this agent — the caller (a route) turns it into 404. */
export class TeamsIdentityResetNotFoundError extends Error {
  public readonly code = 'teams_identity_not_found';

  constructor(agentId: string) {
    super(`no teams identity row for agent '${agentId}'`);
    this.name = 'TeamsIdentityResetNotFoundError';
  }
}

/**
 * A FULL reset was asked of a store that cannot drop a row — the caller (a
 * route) turns it into 501, like every other unwired capability.
 *
 * Raised before the first Azure call on purpose. See {@link resetTeamsIdentity}.
 */
export class TeamsIdentityResetUnsupportedError extends Error {
  public readonly code = 'teams_reset_unsupported';

  constructor(agentId: string) {
    super(
      `the identity store cannot delete rows, so agent '${agentId}' cannot be reset to no identity at all`,
    );
    this.name = 'TeamsIdentityResetUnsupportedError';
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * THE choke point for the teardown's progress log — the single place a sink
 * failure is swallowed.
 *
 * Same policy and same reasoning as the provisioning runner's `emit`: nothing
 * reads this log to decide anything, so a teardown that failed because its
 * diary entry did not write would be an outage manufactured by an
 * observability feature. Awaited rather than fire-and-forget so the timeline
 * keeps insertion order.
 */
function createEmitter(
  opts: TeamsIdentityResetOptions,
  agentId: string,
): TeamsResetEmit {
  return async (step, status, detail): Promise<void> => {
    const sink = opts.events;
    if (!sink) return;
    try {
      await sink.record({
        agentId,
        step,
        status,
        ...(detail === undefined ? {} : { detail }),
      });
    } catch (err) {
      opts.log?.(
        `[teams-reset] progress event (${step}/${status}) for ${agentId} was not recorded: ${errorMessage(err)}`,
      );
    }
  };
}

// ---------------------------------------------------------------------------
// The teardown
// ---------------------------------------------------------------------------

/**
 * Run the teardown for one agent. Never throws for an Azure-side failure —
 * those are reported as steps; it throws only for a missing identity row,
 * which is a caller error.
 *
 * See the module doc for the order and for why each step is allowed (or not
 * allowed) to stop the ones after it.
 */
export async function resetTeamsIdentity(
  opts: TeamsIdentityResetOptions,
  agentId: string,
  scope: TeamsResetScope = 'run',
): Promise<TeamsIdentityResetResult> {
  const emit = createEmitter(opts, agentId);
  const row = await opts.store.getByAgentId(agentId);
  if (!row) throw new TeamsIdentityResetNotFoundError(agentId);

  // REFUSED BEFORE ANYTHING IS TOUCHED, not half-performed. A store that
  // cannot drop a row would otherwise let a full reset delete every Azure
  // object and then leave the identity behind — the operator would be told
  // the slug is free, find the form still filled in, and have no way to tell
  // which of the two they are looking at. Throwing here is a caller error in
  // the same family as a missing row: the route gates on this and answers
  // 501, exactly as it already does for `resetForRetry`.
  if (scope === 'identity' && typeof opts.store.deleteForAgent !== 'function') {
    throw new TeamsIdentityResetUnsupportedError(agentId);
  }

  // Open a fresh timeline, exactly as a provisioning run does: the log
  // describes ONE operation, and an operator watching a teardown is not
  // asking about the run that failed before it. Best-effort, like every
  // other write to this sink.
  try {
    await opts.events?.clearForAgent(agentId);
  } catch (err) {
    opts.log?.(
      `[teams-reset] could not clear the previous progress log of ${agentId}: ${errorMessage(err)}`,
    );
  }
  await emit(TEAMS_RESET_RUN_STEP, 'started');
  const steps: TeamsResetStepReport[] = [];

  /** Record a step, mirror it into the timeline, and say whether to go on. */
  const finish = async (report: TeamsResetStepReport): Promise<boolean> => {
    steps.push(report);
    const ok = report.outcome !== 'failed' && report.outcome !== 'blocked';
    await emit(report.step, ok ? 'succeeded' : 'failed', report.detail);
    return ok;
  };

  const halt = async (
    stoppedAt: TeamsResetStep,
    detail: string,
  ): Promise<TeamsIdentityResetResult> => {
    await emit(TEAMS_RESET_RUN_STEP, 'failed', stoppedAt);
    return { status: 'incomplete', agentId, scope, steps, stoppedAt, detail };
  };

  const provisioner = opts.getProvisioner();

  // ── Step 1 — the tenant catalog entry ───────────────────────────────────
  await emit('catalog_removed', 'started');
  const catalog = await removeCatalogEntry(opts, provisioner, row);
  if (!(await finish(catalog))) {
    return halt('catalog_removed', catalog.detail ?? 'catalog_removal_failed');
  }

  // ── Step 2 — the Azure bot service ──────────────────────────────────────
  await emit('bot_deleted', 'started');
  const bot = await deleteBotService(opts, provisioner, row);
  if (!(await finish(bot))) {
    return halt('bot_deleted', bot.detail ?? 'bot_deletion_failed');
  }

  // ── Step 3 — the Entra app registration, delete AND purge ───────────────
  await emit('app_deleted', 'started');
  const app = await deleteAndPurgeRegistration(opts, provisioner, row);
  if (!(await finish(app))) {
    return halt('app_deleted', app.detail ?? 'app_deletion_failed');
  }

  // ── Step 4 — the row and the recorded bindings ──────────────────────────
  //
  // The ONLY step the two scopes disagree about. Everything above ran
  // identically, which is the point: a full reset is the same teardown with a
  // different last line, not a second teardown with its own order to get
  // wrong.
  const rowStep: TeamsResetStep =
    scope === 'identity' ? 'identity_deleted' : 'identity_reset';

  // THE GUARD THAT KEEPS THE ROW ALIVE, and it applies to the destructive
  // scope only.
  //
  // `app_absent_unpurgeable` is reported as a SUCCESS above, and correctly
  // so — there is genuinely no call left to make. But it is the one success
  // that means "I could not look", not "it is gone": the application is out
  // of `/applications` and the connector cannot search the recycle bin, so a
  // tombstone may still be holding this agent's `uniqueName` for thirty days.
  //
  // The row is what would find it again. `app_id` is the only input
  // `findDeletedAppRegistration` takes, so deleting the row converts a
  // recoverable uncertainty into a permanent one — a leftover in Azure with
  // nothing left pointing at it. A `'run'` reset can live with the doubt
  // because it keeps the row; this one cannot, so it stops with everything
  // else already cleaned up and says exactly why.
  if (scope === 'identity' && outcomeOf(steps, 'app_deleted')?.detail ===
      TEAMS_RESET_DETAILS.appAbsentUnpurgeable) {
    await emit(rowStep, 'started');
    await finish({
      step: rowStep,
      outcome: 'blocked',
      detail: TEAMS_RESET_DETAILS.appTraceRequired,
    });
    return halt(rowStep, TEAMS_RESET_DETAILS.appTraceRequired);
  }

  await emit(rowStep, 'started');
  try {
    // Bindings first: they are a read model OF the row, and a row already
    // back at `pending` while its installs still list three teams is a
    // screen that contradicts itself. If this throws, nothing above it is
    // undone and the retry repeats it — `DELETE` of an empty set is a no-op.
    //
    // Redundant under `'identity'` — migration 0051's foreign key cascades
    // them away with the row — and done anyway, because a mount whose
    // installs store is wired against a different backing table would
    // otherwise keep them. Deleting an empty set costs one statement.
    if (opts.installs) await opts.installs.removeAllForAgent(agentId);
    if (scope === 'identity') {
      await (
        opts.store.deleteForAgent as NonNullable<
          TeamsResetIdentityStore['deleteForAgent']
        >
      ).call(opts.store, agentId);
    } else {
      await opts.store.resetForRetry(agentId);
    }
  } catch (err) {
    const detail = `${TEAMS_RESET_FAILURE_PREFIXES.identity}${errorMessage(err)}`;
    await finish({ step: rowStep, outcome: 'failed', detail });
    return halt(rowStep, detail);
  }

  if (scope === 'identity') {
    // THE TIMELINE WENT WITH THE ROW. `agent_teams_provisioning_events`
    // cascades on `agent_id` (migration 0053), so the log these events would
    // be written to no longer exists — and writing them would only produce a
    // swallowed foreign-key violation on every single full reset.
    //
    // Nothing is lost that anybody can still reach: after this there is no
    // identity for a timeline to be about, the operator lands on the empty
    // create form, and the per-step report in the HTTP response is the record
    // of what happened.
    steps.push({ step: rowStep, outcome: 'removed' });
    return { status: 'reset', agentId, scope, steps };
  }

  await finish({ step: rowStep, outcome: 'removed' });
  await emit(TEAMS_RESET_RUN_STEP, 'succeeded');
  return { status: 'reset', agentId, scope, steps };
}

/** The report recorded for one step, or `undefined` when it never ran. */
function outcomeOf(
  steps: readonly TeamsResetStepReport[],
  step: TeamsResetStep,
): TeamsResetStepReport | undefined {
  return steps.find((entry) => entry.step === step);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function removeCatalogEntry(
  opts: TeamsIdentityResetOptions,
  provisioner: TeamsResetProvisionerPort,
  row: TeamsResetIdentityRecord,
): Promise<TeamsResetStepReport> {
  const step = 'catalog_removed' as const;
  if (row.teamsAppId === null) {
    return { step, outcome: 'skipped', detail: TEAMS_RESET_DETAILS.nothingToRemove };
  }
  if (!supportsCatalogRemoval(provisioner)) {
    // BLOCKING, and this is the decision the module doc argues for at length:
    // the `externalId` is stable, so an abandoned catalog entry is adopted by
    // the next run and silently pairs the new bot with the old app id.
    return {
      step,
      outcome: 'blocked',
      detail: TEAMS_RESET_DETAILS.catalogRemovalUnsupported,
    };
  }
  const tokens = await opts.delegatedTokens?.read();
  if (tokens === undefined) {
    // Not a fault: `DELETE /appCatalogs/teamsApps` is delegated-only at
    // Microsoft, exactly like the upload (#924). Nobody has signed in yet.
    //
    // And nobody needs to sign in AGAIN: the delete is covered by the
    // `AppCatalog.ReadWrite.All` the provisioning sign-in already asked for,
    // so any tenant that could be provisioned can be torn down by whoever is
    // signed in today. That is why this reports a plain sign-in requirement
    // and never a re-consent — unlike chat enumeration, which does need one.
    return {
      step,
      outcome: 'blocked',
      detail: TEAMS_RESET_DETAILS.tenantSignInRequired,
    };
  }
  const teamsAppId = row.teamsAppId;
  const remove = provisioner.removeFromCatalog as NonNullable<
    TeamsResetProvisionerPort['removeFromCatalog']
  >;
  const call = (set: DelegatedTokenSet): Promise<{ readonly outcome: string }> =>
    remove.call(provisioner, { teamsAppId, tokens: set });

  const write = opts.delegatedTokens?.write;
  try {
    // A SPENT ACCESS TOKEN IS NOT A REASON TO ABANDON A TEARDOWN. Before this
    // the expiry surfaced as `catalog_removal_failed: <whatever Graph said>`,
    // which stopped the whole teardown — catalogue first, and its failure
    // stops everything — over a condition that needs no human at all.
    //
    // The refresh is the SHARED one (`platform/teamsDelegatedRefresh.ts`), for
    // the same reason the target listing uses it: this is the third caller to
    // need the arithmetic and the second to have got it wrong on its own.
    // No `write` port, no refresh — see that module.
    const res =
      write === undefined
        ? await call(tokens)
        : await withDelegatedTokenRefresh(
            {
              provisioner,
              custody: { write: (set) => write.call(opts.delegatedTokens, set) },
              ...(opts.now ? { now: opts.now } : {}),
              ...(opts.log ? { log: opts.log } : {}),
            },
            tokens,
            call,
          );
    return {
      step,
      outcome: res.outcome === 'already-absent' ? 'already-absent' : 'removed',
    };
  } catch (err) {
    // `blocked`, not `failed`: an expiry that survived the refresh is a
    // missing human action, exactly like the missing sign-in above it, and
    // reporting it as a fault would send an operator looking for a broken
    // Graph call that never happened. Its own detail, though — "sign in
    // again because yours expired" is a different sentence from "nobody has
    // signed in", and the operator is entitled to know which one they are in.
    if (isDelegatedTokenExpiredError(err)) {
      return { step, outcome: 'blocked', detail: TEAMS_RESET_DETAILS.tenantSignInExpired };
    }
    if (isDelegatedSignInRequiredError(err)) {
      return { step, outcome: 'blocked', detail: TEAMS_RESET_DETAILS.tenantSignInRequired };
    }
    return {
      step,
      outcome: 'failed',
      detail: `${TEAMS_RESET_FAILURE_PREFIXES.catalog}${errorMessage(err)}`,
    };
  }
}

async function deleteBotService(
  opts: TeamsIdentityResetOptions,
  provisioner: TeamsResetProvisionerPort,
  row: TeamsResetIdentityRecord,
): Promise<TeamsResetStepReport> {
  const step = 'bot_deleted' as const;
  if (row.appId === null) {
    // The handle is derived from the app id, so without one there is no name
    // to delete under — and no run ever got far enough to create a bot.
    return { step, outcome: 'skipped', detail: TEAMS_RESET_DETAILS.nothingToRemove };
  }
  try {
    const res = await provisioner.deleteBot(
      opts.buildBotHandle(row.botSlug, row.appId),
    );
    if (res.kind === 'registration-only') {
      // ARM was never configured, so the chain can only ever have reached
      // `app_registered` and no bot service exists to remove. Success.
      return { step, outcome: 'skipped', detail: TEAMS_RESET_DETAILS.armNotConfigured };
    }
    return {
      step,
      outcome: res.outcome === 'already-deleted' ? 'already-absent' : 'removed',
    };
  } catch (err) {
    return {
      step,
      outcome: 'failed',
      detail: `${TEAMS_RESET_FAILURE_PREFIXES.bot}${errorMessage(err)}`,
    };
  }
}

/**
 * The registration, as ONE step: resolve the object id, persist it, delete,
 * purge.
 *
 * Splitting it into two reportable steps was considered and rejected — a
 * delete that reads as a success while its purge is still owed is exactly the
 * state that looks "done" and burns the slug for 30 days.
 *
 * THE OBJECT ID IS RESOLVED FROM THREE PLACES, IN THIS ORDER, AND THE ORDER
 * IS THE RESUMABILITY STORY:
 *
 *   1. `app_object_id` on the row (migration 0055). Free, and always right
 *      for an identity provisioned since the column exists.
 *   2. `getAppRegistration(appId)` — works while the application is still
 *      live, which is the FIRST run's normal path.
 *   3. `findDeletedAppRegistration({ appId })` — searches the recycle bin,
 *      and is the only one of the three that still works AFTER a delete. It
 *      is what makes a teardown interrupted between the delete and the purge
 *      recoverable at all, including for rows that predate the column.
 *
 * Whatever is learned is PERSISTED immediately, so the next attempt starts at
 * (1) even if this one dies on the next line.
 */
async function deleteAndPurgeRegistration(
  opts: TeamsIdentityResetOptions,
  provisioner: TeamsResetProvisionerPort,
  row: TeamsResetIdentityRecord,
): Promise<TeamsResetStepReport> {
  const step = 'app_deleted' as const;
  if (row.appId === null) {
    return { step, outcome: 'skipped', detail: TEAMS_RESET_DETAILS.nothingToRemove };
  }
  const appId = row.appId;

  /** Ask the recycle bin. `null` = could not look; `undefined` = looked, empty. */
  const searchRecycleBin = async (): Promise<string | null | undefined> => {
    if (!supportsDeletedAppRegistrationLookup(provisioner)) return null;
    const found = await (
      provisioner.findDeletedAppRegistration as NonNullable<
        TeamsResetProvisionerPort['findDeletedAppRegistration']
      >
    ).call(provisioner, { appId });
    return found.found ? found.objectId : undefined;
  };

  const remember = async (objectId: string): Promise<void> => {
    // Persisted the moment it is known, never held only in a local: had the
    // process died between the delete below and a later write, the
    // recycle-bin entry holding this agent's `uniqueName` would have become
    // unaddressable for any connector that cannot search.
    await opts.store.update(row.agentId, { appObjectId: objectId });
  };

  let objectId = row.appObjectId;
  /** Did the recycle bin answer "empty" rather than "cannot look"? */
  let provablyGone = false;
  if (objectId === null) {
    try {
      const live = await provisioner.getAppRegistration(appId, provisioner.tenantMode);
      if (live !== undefined) {
        objectId = live.objectId;
        await remember(objectId);
      } else {
        // Not live. Either somebody already deleted it (a tombstone) or it is
        // fully gone. Only the recycle bin can tell those two apart.
        const deletedObjectId = await searchRecycleBin();
        if (typeof deletedObjectId === 'string') {
          objectId = deletedObjectId;
          await remember(objectId);
        } else if (deletedObjectId === undefined) {
          provablyGone = true;
        }
      }
    } catch (err) {
      return {
        step,
        outcome: 'failed',
        detail: `${TEAMS_RESET_FAILURE_PREFIXES.appDelete}${errorMessage(err)}`,
      };
    }
  }

  if (objectId === null) {
    // Nothing left to call: the application is not in `/applications`, and
    // either the recycle bin is empty (`provablyGone`) or we cannot see into
    // it. Both are reported as done; only the second carries a warning,
    // because only the second can still be holding the slug.
    return {
      step,
      outcome: 'already-absent',
      detail: provablyGone
        ? TEAMS_RESET_DETAILS.appProvablyGone
        : TEAMS_RESET_DETAILS.appAbsentUnpurgeable,
    };
  }

  if (!supportsAppRegistrationPurge(provisioner)) {
    // THE REFUSAL. Deleting here would be actively harmful: it converts a
    // registration this agent can still adopt into a 30-day reservation on
    // its own `uniqueName`. Doing nothing is strictly better, so nothing is
    // what happens — loudly.
    return { step, outcome: 'blocked', detail: TEAMS_RESET_DETAILS.purgeUnsupported };
  }

  let deleted: { readonly outcome: string };
  try {
    deleted = await provisioner.deleteAppRegistration({ appId });
  } catch (err) {
    return {
      step,
      outcome: 'failed',
      detail: `${TEAMS_RESET_FAILURE_PREFIXES.appDelete}${errorMessage(err)}`,
    };
  }

  const purge = async (id: string): Promise<void> => {
    await (
      provisioner.purgeDeletedAppRegistration as NonNullable<
        TeamsResetProvisionerPort['purgeDeletedAppRegistration']
      >
    ).call(provisioner, { objectId: id });
  };

  try {
    await purge(objectId);
  } catch (err) {
    // ONE retry, and only for the one error a retry can fix: the connector
    // says we handed it an `appId` where a directory object id belongs. A
    // stored `app_object_id` can be wrong that way — an older write, a
    // hand-edited row — and both identifiers are GUIDs, so nothing upstream
    // would have caught it.
    //
    // The connector resolves the right id WHILE refusing and ships it on the
    // error, so the retry uses that value and only falls back to searching
    // the recycle bin when the error came without one. Every other failure is
    // reported as it is — and note what is deliberately NOT special-cased
    // here: a 404. Graph answers "resource not found" both for an id that was
    // already purged and for an id of the wrong kind, so reading one as proof
    // of a clean recycle bin is exactly the mistake
    // `DeletedObjectIdMismatchError` exists to prevent.
    if (!isDeletedObjectIdMismatchError(err)) {
      return {
        step,
        outcome: 'failed',
        detail: `${TEAMS_RESET_FAILURE_PREFIXES.appPurge}${errorMessage(err)}`,
      };
    }
    try {
      const corrected = correctedObjectIdOf(err) ?? (await searchRecycleBin());
      if (typeof corrected !== 'string') throw err;
      await remember(corrected);
      await purge(corrected);
    } catch (retryErr) {
      // The dangerous half-state, and the row is deliberately left ALONE: it
      // still carries `app_id`, which is what lets a second call search the
      // recycle bin and finish the purge. Clearing it here would be #916 with
      // extra steps.
      return {
        step,
        outcome: 'failed',
        detail: `${TEAMS_RESET_FAILURE_PREFIXES.appPurge}${errorMessage(retryErr)}`,
      };
    }
  }

  return {
    step,
    outcome:
      deleted.outcome === 'already-deleted' || deleted.outcome === 'already-absent'
        ? 'already-absent'
        : 'removed',
  };
}
