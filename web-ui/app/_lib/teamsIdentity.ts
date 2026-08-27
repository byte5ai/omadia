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
 * OUT OF SCOPE, ON PURPOSE: pushing this block into channel-teams' config
 * automatically. The operator pastes it, and the copy says so plainly rather
 * than letting them assume a sync that does not exist. Automatic `teams_bots[]`
 * sync is the documented follow-up (see the route's own note at
 * `operatorAgents.ts`, "`teams_bots[]` sync (follow-up)").
 */

/**
 * An i18n key plus its ICU arguments. Every user-facing string this module and
 * {@link module:teamsIdentityErrors} produce is one of these — a key relative
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

/**
 * The pipeline in the order the runner walks it. `failed` is deliberately not
 * a step — it is an outcome that can replace any of them, and numbering it
 * would tell the operator they are "at step 7 of 7" when nothing was achieved.
 */
export const TEAMS_PROVISIONING_STEPS = [
  'pending',
  'app_registered',
  'bot_created',
  'package_built',
  'catalog_uploaded',
  'installed',
] as const satisfies readonly TeamsProvisioningState[];

/** How the state should READ — the colour/severity axis, not the wording. */
export type TeamsProvisioningTone =
  | 'idle'
  | 'running'
  | 'done'
  | 'halted'
  | 'failed';

/**
 * `halted` is the interesting one: provisioning stopped short of `installed`
 * and no attempt is in flight. That covers the ArmNotConfigured case, which is
 * a LEGITIMATE end state (`app_registered`, registration kept) — so it is not
 * `failed`, and the copy is what explains the difference.
 */
export function teamsProvisioningTone(input: {
  readonly state: TeamsProvisioningState;
  readonly running: boolean;
  readonly hasError: boolean;
}): TeamsProvisioningTone {
  if (input.state === 'failed') return 'failed';
  if (input.running) return 'running';
  if (input.state === 'installed') return 'done';
  if (input.hasError) return 'halted';
  return input.state === 'pending' ? 'idle' : 'halted';
}

/** Readable label for a state. */
export function teamsProvisioningStateMessage(
  state: TeamsProvisioningState,
): LocalizedMessage {
  return { key: `states.${state}` };
}

/** "Step 3 of 6" — `null` for `failed`, which is not a position in the run. */
export function teamsProvisioningProgress(
  state: TeamsProvisioningState,
): LocalizedMessage | null {
  const index = (TEAMS_PROVISIONING_STEPS as readonly string[]).indexOf(state);
  if (index < 0) return null;
  return {
    key: 'progress',
    values: { step: index + 1, total: TEAMS_PROVISIONING_STEPS.length },
  };
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
 * The copy around the block. Says the quiet part out loud: pasting is a MANUAL
 * step, and nothing syncs it for you.
 */
export function teamsBotConfigMessages(
  view: TeamsIdentityView,
): readonly LocalizedMessage[] {
  if (!view.teamsBot) return [{ key: 'teamsBot.notReady' }];
  return [
    { key: 'teamsBot.manualStep' },
    { key: 'teamsBot.instructions', values: { field: 'teams_bots' } },
    { key: 'teamsBot.secretRefNote' },
    { key: 'teamsBot.followUp' },
  ];
}
