/**
 * #860 / W2a — the client-side view of a Teams provisioning identity.
 *
 * This is the boundary module for `GET /api/v1/operator/agents/:slug/teams-identity`
 * (`middleware/src/routes/operatorAgents.ts`): it validates the snake_case
 * envelope, projects it into a camelCase view model, and carries the two
 * things the operator screen needs beyond the raw fields — a readable label
 * per provisioning state, and the `teams_bots` config block to paste into
 * channel-teams.
 *
 * THREE CONTRACTS ARE MIRRORED HERE, and each one is pinned by a test:
 *
 *   1. THE STATE VOCABULARY. {@link TEAMS_PROVISIONING_STATES} is
 *      `TEAMS_PROVISIONING_STATES` in
 *      `middleware/src/platform/agentTeamsIdentityStore.ts`, which is in turn
 *      the CHECK constraint of migration 0049, verbatim. An unknown state is
 *      rejected rather than rendered — a state with no label is a state with
 *      no meaning to the operator.
 *
 *   2. THE `teams_bot` ENTRY SHAPE. Emitted verbatim as a `parseTeamsBotsConfig`
 *      entry (channel-teams `src/teamsBotsConfig.ts`): camelCase
 *      botSlug/displayName/appId/appType/tenantId/appPasswordSecretRef, wrapped
 *      in a JSON array because the plugin's `teams_bots` setup field is a
 *      string field that is `JSON.parse`d. Reordering or renaming a key here
 *      produces a block that the plugin rejects on paste.
 *
 *   3. NO SECRET EVER REACHES THIS TABLE. `appPasswordSecretRef` is the opaque
 *      ref `teams_bot_password:<appId>` — the NAME of a secret in the M365
 *      connector's vault, never the password (migration 0049 header; the
 *      channel-teams parser rejects an inline `appPassword` outright). The
 *      real guarantee is server-side; {@link isTeamsBotSecretRef} is a
 *      belt-and-braces shape check so a value that is not ref-shaped drops the
 *      whole block instead of being rendered into a copy-paste box.
 *
 * SINCE #910 THE PASTE IS A FALLBACK, NOT THE PATH. Provisioning writes this
 * entry into the channel-teams config itself and reloads the plugin. The block
 * stays — for operators who configure explicitly, and for every case where the
 * automatic write could not land (plugin not installed, a value the sync
 * refuses to overwrite, a failed write). Which of the two applies is not
 * guessed here: the route reports the LIVE state as `teams_bots_sync`, and
 * {@link teamsBotConfigMessages} turns it into copy that either says "already
 * applied" or says why the operator still has to paste.
 */

import {
  parseTeamsBotsSync,
  type TeamsBotsSyncDto,
  type TeamsBotsSyncState,
  type TeamsIdentityLastErrorDetailDto,
} from './agents';

/**
 * An i18n key plus its ICU arguments. Every user-facing string this module and
 * this module produces is one of these — a key relative
 * to the `operatorAgents.teamsIdentity` namespace, never a sentence.
 */
export interface LocalizedMessage {
  readonly key: string;
  readonly values?: Readonly<Record<string, string | number>>;
}

// ---------------------------------------------------------------------------
// State vocabulary — mirrors middleware/src/platform/agentTeamsIdentityStore.ts
// ---------------------------------------------------------------------------

export const TEAMS_PROVISIONING_STATES = [
  'pending',
  'app_registered',
  'bot_created',
  'package_built',
  'catalog_uploaded',
  'installed',
  'failed',
] as const;

export type TeamsProvisioningState = (typeof TEAMS_PROVISIONING_STATES)[number];

export function isTeamsProvisioningState(
  value: unknown,
): value is TeamsProvisioningState {
  return (
    typeof value === 'string' &&
    (TEAMS_PROVISIONING_STATES as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// The `teams_bots` entry — channel-teams `parseTeamsBotsConfig`, verbatim
// ---------------------------------------------------------------------------

/** Mirrors `TeamsBotAppType` in channel-teams `src/teamsBotIdentity.ts`. */
export const TEAMS_BOT_APP_TYPES = [
  'SingleTenant',
  'MultiTenant',
  'UserAssignedMSI',
] as const;

export type TeamsBotAppType = (typeof TEAMS_BOT_APP_TYPES)[number];

export interface TeamsBotConfigEntry {
  readonly botSlug: string;
  readonly displayName: string;
  readonly appId: string;
  readonly appType: TeamsBotAppType;
  readonly tenantId: string;
  /** Opaque vault ref — see the module header. NEVER secret material. */
  readonly appPasswordSecretRef: string;
}

/** The custody convention the middleware derives: `teams_bot_password:<appId>`. */
export const TEAMS_BOT_SECRET_REF_PREFIX = 'teams_bot_password:';

/**
 * Is this a secret REFERENCE rather than a secret?
 *
 * A ref is a `<namespace>:<name>` handle with no whitespace. The check is
 * deliberately shape-only: the deployment may override the derivation
 * (`clientSecretRef` on the route's dependencies), so pinning the default
 * prefix would drop a legitimate custom ref. What it does buy is that a value
 * which is not a handle at all never lands in a copy-paste box.
 */
export function isTeamsBotSecretRef(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 256 &&
    !/\s/.test(value) &&
    value.includes(':')
  );
}

// ---------------------------------------------------------------------------
// The GET envelope → view model
// ---------------------------------------------------------------------------

export interface TeamsIdentityView {
  readonly agentSlug: string;
  readonly state: TeamsProvisioningState;
  /** A provisioning run is in flight for this agent right now. */
  readonly running: boolean;
  /** The M365 connector providing `teamsProvisioner@1` is installed. */
  readonly provisionerInstalled: boolean;
  readonly botSlug: string | null;
  readonly displayName: string | null;
  readonly appId: string | null;
  readonly tenantId: string | null;
  readonly teamsAppId: string | null;
  readonly teamsAppExternalId: string | null;
  /** Free-form sentence — classify it with `classifyTeamsIdentityError`. */
  readonly lastError: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  /** `null` until the Entra app exists, or when the ref is not ref-shaped. */
  readonly teamsBot: TeamsBotConfigEntry | null;
  /** #910 — whether {@link teamsBot} is actually configured in the plugin. */
  readonly botsSync: TeamsBotsSyncDto;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Non-empty string, else `null` — the route sends `null` for unset columns. */
function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseTeamsBot(value: unknown): TeamsBotConfigEntry | null {
  if (!isRecord(value)) return null;

  const botSlug = optionalString(value.botSlug);
  const displayName = optionalString(value.displayName);
  const appId = optionalString(value.appId);
  const tenantId = optionalString(value.tenantId);
  const appPasswordSecretRef = optionalString(value.appPasswordSecretRef);
  const appType = value.appType;

  if (!botSlug || !displayName || !appId || !tenantId || !appPasswordSecretRef) {
    return null;
  }
  if (
    typeof appType !== 'string' ||
    !(TEAMS_BOT_APP_TYPES as readonly string[]).includes(appType)
  ) {
    return null;
  }
  // Belt and braces: a value that is not a vault handle is dropped rather than
  // rendered. The table holds no secret by construction (migration 0049) — this
  // is what makes that promise visible on the client too.
  if (!isTeamsBotSecretRef(appPasswordSecretRef)) return null;

  return {
    botSlug,
    displayName,
    appId,
    appType: appType as TeamsBotAppType,
    tenantId,
    appPasswordSecretRef,
  };
}

/**
 * Validate the GET envelope and project it. Returns `null` for anything that
 * is not a well-formed envelope — an unknown `state` included, because a state
 * this build cannot name is one it cannot explain either.
 */
export function parseTeamsIdentityEnvelope(value: unknown): TeamsIdentityView | null {
  if (!isRecord(value)) return null;

  const agentSlug = optionalString(value.agent);
  if (!agentSlug) return null;
  if (!isTeamsProvisioningState(value.state)) return null;

  const identity = isRecord(value.identity) ? value.identity : {};

  return {
    agentSlug,
    state: value.state,
    running: value.running === true,
    provisionerInstalled: value.provisioner_installed === true,
    botSlug: optionalString(identity.bot_slug),
    displayName: optionalString(identity.display_name),
    appId: optionalString(identity.app_id),
    tenantId: optionalString(identity.tenant_id),
    teamsAppId: optionalString(identity.teams_app_id),
    teamsAppExternalId: optionalString(identity.teams_app_external_id),
    lastError: optionalString(identity.last_error),
    createdAt: optionalString(identity.created_at),
    updatedAt: optionalString(identity.updated_at),
    teamsBot: parseTeamsBot(value.teams_bot),
    botsSync: parseTeamsBotsSync(value.teams_bots_sync),
  };
}

// ---------------------------------------------------------------------------
// The paste-able config block
// ---------------------------------------------------------------------------

/**
 * Render entries for channel-teams' `teams_bots` setup field.
 *
 * A JSON ARRAY, because that field is a string field the plugin `JSON.parse`s
 * (`parseTeamsBotsConfig`: "a JSON string when typed into the setup wizard's
 * string field"). Key ORDER is the declaration order of
 * {@link TeamsBotConfigEntry} — cosmetic for the parser, load-bearing for the
 * operator who diffs the block against what is already configured.
 */
export function formatTeamsBotsConfig(
  entries: readonly TeamsBotConfigEntry[],
): string {
  const rows = entries.map((entry) => ({
    botSlug: entry.botSlug,
    displayName: entry.displayName,
    appId: entry.appId,
    appType: entry.appType,
    tenantId: entry.tenantId,
    appPasswordSecretRef: entry.appPasswordSecretRef,
  }));
  return JSON.stringify(rows, null, 2);
}

/**
 * Sync states in which provisioning has NOT put the entry into the plugin
 * config, so the operator still has to paste it. `synced` is the only state
 * where the manual step is genuinely done; every other state — including
 * `unknown`, where this build cannot tell — keeps the instructions visible,
 * because a missing instruction is worse than a redundant one.
 */
export function isTeamsBotConfigApplied(state: TeamsBotsSyncState): boolean {
  return state === 'synced';
}

/**
 * The copy around the block.
 *
 * Since #910 the leading line is the ANSWER to "do I still have to do
 * something?": `applied` when provisioning wrote the entry itself, otherwise a
 * per-state reason followed by the paste instructions. The block itself is
 * rendered either way — an operator who configures explicitly, or who is
 * diffing against what is live, wants to see it regardless.
 */
export function teamsBotConfigMessages(
  view: TeamsIdentityView,
): readonly LocalizedMessage[] {
  if (!view.teamsBot) return [{ key: 'teamsBot.notReady' }];
  const state = view.botsSync.state;
  if (isTeamsBotConfigApplied(state)) {
    return [
      { key: 'teamsBot.applied', values: { plugin: view.botsSync.plugin_id } },
      { key: 'teamsBot.appliedFallback' },
      { key: 'teamsBot.secretRefNote' },
    ];
  }
  return [
    {
      key: `teamsBot.notApplied.${state}`,
      // Both arguments go to every state's line: which plugin, and which
      // setup field. Only some states name them, and ICU ignores the rest —
      // that beats a per-state argument table that drifts from the copy.
      values: {
        field: view.botsSync.config_key,
        plugin: view.botsSync.plugin_id,
      },
    },
    {
      key: 'teamsBot.instructions',
      values: { field: view.botsSync.config_key },
    },
    { key: 'teamsBot.secretRefNote' },
  ];
}

// ---------------------------------------------------------------------------
// Failure copy — shaped from the SERVER's classification, never from prose
//
// The classifier itself lives in the middleware, next to the only code that
// writes `last_error` (`services/teamsProvisioningJob.ts`), and the route
// projects its result as `identity.last_error_detail`. What is left for the
// client is purely presentational: turn the structured detail into an ordered
// list of i18n keys + ICU arguments. There is deliberately NO second parser
// here — a reworded sentence must break a colocated middleware test, not
// degrade this screen silently in production.
// ---------------------------------------------------------------------------

/**
 * Microsoft's own instructions for the step a consent failure blocks on. The
 * copy names the step; this is the link behind it, so the operator does not
 * have to hunt for the Entra blade.
 */
export const ENTRA_ADMIN_CONSENT_DOCS_URL =
  'https://learn.microsoft.com/entra/identity/enterprise-apps/grant-admin-consent';

export interface TeamsIdentityErrorLink {
  readonly href: string;
  /** i18n key of the link label, relative to `operatorAgents.teamsIdentity`. */
  readonly labelKey: string;
}

/** The one external step a failure sends the operator to, when there is one. */
export function teamsIdentityErrorLink(
  detail: TeamsIdentityLastErrorDetailDto,
): TeamsIdentityErrorLink | null {
  return detail.code === 'consent_missing'
    ? {
        href: ENTRA_ADMIN_CONSENT_DOCS_URL,
        labelKey: 'errors.consent_missing.consentLink',
      }
    : null;
}

/**
 * The localized sentences for a failure, in reading order: what happened, the
 * captured specifics (named scopes / fields / wait hint), what to do next.
 *
 * Keys are relative to the `operatorAgents.teamsIdentity` namespace. The
 * captured lists are passed as ICU arguments, never concatenated into copy.
 *
 * The `retryAfter` line is emitted ONLY when the connector actually sent a
 * `Retry-After` hint: a throttle can exhaust the retry budget without one
 * (`throttleHintOf` returns `{}`), and defaulting the argument to 0 would tell
 * the operator to retry "in about 0 seconds" at the exact moment the system
 * gave up.
 */
export function teamsIdentityErrorMessages(
  detail: TeamsIdentityLastErrorDetailDto,
): readonly LocalizedMessage[] {
  const base = `errors.${detail.code}`;
  const messages: LocalizedMessage[] = [{ key: `${base}.what` }];

  if (detail.code === 'consent_missing' && (detail.scopes?.length ?? 0) > 0) {
    const scopes = detail.scopes as readonly string[];
    messages.push({
      key: `${base}.scopes`,
      values: { scopes: scopes.join(', '), count: scopes.length },
    });
  }

  if (detail.code === 'arm_not_configured' && (detail.fields?.length ?? 0) > 0) {
    const fields = detail.fields as readonly string[];
    messages.push({
      key: `${base}.fields`,
      values: { fields: fields.join(', '), count: fields.length },
    });
  }

  // #910 — the write failure carries a technical sentence, shown as an ICU
  // argument on its own line rather than pasted into the copy.
  if (detail.code === 'config_sync_failed' && (detail.reason ?? '') !== '') {
    messages.push({
      key: `${base}.reason`,
      values: { reason: detail.reason as string },
    });
  }

  if (detail.code === 'throttled' && detail.retryAfterSeconds !== undefined) {
    messages.push({
      key: `${base}.retryAfter`,
      values: { seconds: detail.retryAfterSeconds },
    });
  }

  messages.push({ key: `${base}.next` });

  // Registration-only is a legitimate END STATE, not a broken agent — say so
  // last, where a worried operator stops reading.
  if (detail.code === 'arm_not_configured') {
    messages.push({ key: `${base}.keepsRegistration` });
  }

  return messages;
}

/** The raw sentence, demoted to a secondary technical line. */
export function teamsIdentityErrorTechnicalDetail(
  detail: TeamsIdentityLastErrorDetailDto,
): LocalizedMessage {
  return { key: 'errors.technicalDetail', values: { raw: detail.raw } };
}
