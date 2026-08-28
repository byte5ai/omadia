/**
 * `teams_bots[]` config sync — epic byte5ai/omadia#860, issue #910.
 *
 * Closes the last manual step of the agent factory. Provisioning creates an
 * Entra app, an Azure bot, a Teams app package, a tenant-catalog entry and a
 * team install without an operator touching anything — and then, until this
 * module existed, asked them to copy a JSON block from the operator UI into
 * the `teams_bots` setup field of `@omadia/channel-teams` by hand. Until that
 * paste happened the bot existed everywhere except in the middleware, which
 * had neither an adapter nor a route for it, so it stayed silent.
 *
 * THE PROJECTION LIVES HERE. {@link projectTeamsBotConfig} moved out of
 * `routes/operatorAgents.ts` into this module so the UI block and the written
 * entry come from ONE producer. The router re-exports it for its existing
 * callers; a second, drifting copy would hand operators a config that silently
 * does not parse.
 *
 * WRITE RULES (each one is a test in `test/teamsBotsConfigSync.test.ts`):
 *
 *   - IDEMPOTENT BY `botSlug`. A re-run REPLACES its own entry in place and
 *     never appends a second one. Position is preserved, so `teams_bots[0]` —
 *     the default bot of channel-teams' legacy scalar shim, which owns the
 *     `/api/messages` aliases — never changes identity because some other bot
 *     was re-provisioned.
 *   - EVERY FOREIGN ENTRY IS PRESERVED VERBATIM. Entries are read as RAW
 *     objects and written back untouched; only the entry whose `botSlug`
 *     matches this identity is replaced. Nothing is normalized, re-ordered or
 *     re-defaulted, so an operator's hand-tuned entry for another slug comes
 *     back byte-identical. (This is why the module does not re-use
 *     channel-teams' `parseTeamsBotsConfig` result shape for the round trip:
 *     that parser DEFAULTS `appType` and `displayName`, so a parse/serialize
 *     cycle would silently rewrite entries it was only meant to read past.)
 *   - THE CONTAINER FORM ROUND-TRIPS. `parseTeamsBotsConfig` accepts both a
 *     real array (install-registry value) and a JSON string (what the setup
 *     wizard's string field holds). Whichever form the stored value had is the
 *     form it is written back in; an absent value is created as a JSON string,
 *     because that is what the setup field is.
 *   - NOTHING SECRET IS WRITTEN. The entry carries `appPasswordSecretRef` —
 *     the opaque `teams_bot_password:<appId>` handle into the M365 connector's
 *     vault. `parseTeamsBotsConfig` rejects an inline `appPassword` outright,
 *     and this module never has the password to begin with.
 *
 * FAILURE POSTURE: this is a best-effort finishing move on an identity that is
 * ALREADY valid in Azure. {@link syncTeamsBotConfig} therefore reports rather
 * than rolls back — the caller (the job runner) records a warning on the
 * identity and keeps the run `installed`, and the operator UI keeps the
 * copy-paste block as the documented fallback.
 */

import type { InstalledRegistry } from '../plugins/installedRegistry.js';
import { CHANNEL_TEAMS_PLUGIN_ID } from './teamsAppPackageAssets.js';

export { CHANNEL_TEAMS_PLUGIN_ID };

/** The channel-teams setup field this module owns one entry of. */
export const TEAMS_BOTS_CONFIG_KEY = 'teams_bots';

// ---------------------------------------------------------------------------
// The projection (moved from routes/operatorAgents.ts — see module header)
// ---------------------------------------------------------------------------

/** The identity fields a `teams_bots[]` entry is built from. Structural on
 *  purpose: the store record, the job runner's record and the router's
 *  camelCase projection all satisfy it without importing each other. */
export interface TeamsBotIdentitySource {
  readonly botSlug: string;
  readonly displayName: string;
  readonly appId: string | null;
  readonly tenantId: string | null;
}

/**
 * Custody convention for the provisioned bot's app password: the
 * `agent_teams_identities` table stores NO secret material — the M365
 * connector's `createAppRegistration` keeps the generated client secret in
 * the CONNECTOR's vault and hands back only the opaque, deterministic ref
 * `teams_bot_password:<appId>` (teamsProvisioner contract v0.3.1). Both the
 * status endpoint and the config write re-derive that ref from `app_id`, so
 * the secret never appears in an HTTP response, a middleware table or the
 * plugin's config store. Keyed by appId (globally unique per registration),
 * NOT by bot slug, so no two identities can ever alias one credential.
 */
export function defaultTeamsBotSecretRef(record: {
  readonly appId: string | null;
}): string {
  if (!record.appId) {
    throw new Error(
      'defaultTeamsBotSecretRef requires a provisioned appId — the secret ref is derived from it',
    );
  }
  return `teams_bot_password:${record.appId}`;
}

/**
 * One `teams_bots[]` entry of channel-teams' plugin config — shaped EXACTLY
 * like a `parseTeamsBotsConfig` entry (camelCase keys), so the same value is
 * both written into the plugin config and rendered for an operator to paste.
 */
export interface TeamsBotConfigProjection {
  readonly botSlug: string;
  readonly displayName: string;
  readonly appId: string;
  /** Literal — the epic provisions SingleTenant apps only (new MultiTenant
   *  registrations are deprecated since 07/2025). */
  readonly appType: 'SingleTenant';
  readonly tenantId: string;
  /** Opaque connector-vault ref (teamsProvisioner contract v0.3.1), NEVER
   *  the password itself. */
  readonly appPasswordSecretRef: string;
}

/**
 * THE single `teams_bots[]` projection of the platform (W2a #860, #910).
 *
 * Every surface that publishes or writes a provisioned identity goes through
 * here rather than re-assembling the block: the entry is a config contract
 * with channel-teams, and a second copy of it would drift.
 *
 * `null` until BOTH the Entra app and its tenant are known — an incomplete
 * entry is worse than none, because channel-teams rejects the whole
 * `teams_bots[]` array over one bad element.
 */
export function projectTeamsBotConfig<T extends TeamsBotIdentitySource>(
  record: T,
  clientSecretRef?: (record: T) => string,
): TeamsBotConfigProjection | null {
  if (!record.appId || !record.tenantId) return null;
  return {
    botSlug: record.botSlug,
    displayName: record.displayName,
    appId: record.appId,
    appType: 'SingleTenant',
    tenantId: record.tenantId,
    appPasswordSecretRef:
      clientSecretRef?.(record) ?? defaultTeamsBotSecretRef(record),
  };
}

// ---------------------------------------------------------------------------
// Reading + rewriting the stored value
// ---------------------------------------------------------------------------

/** A stored `teams_bots` value that this module refuses to touch. Thrown, not
 *  swallowed: rewriting a value we could not read would destroy operator
 *  configuration, so an unreadable field is a loud skip, never a reset. */
export class TeamsBotsConfigSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamsBotsConfigSyncError';
  }
}

/**
 * The stored value, decomposed. `entries` are the RAW objects exactly as they
 * were stored (see the module header on why nothing is normalized); `form`
 * records how they were serialized so a write puts them back the same way.
 */
export interface TeamsBotsConfigDocument {
  readonly entries: readonly Record<string, unknown>[];
  readonly form: 'string' | 'array';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asEntries(value: unknown, origin: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new TeamsBotsConfigSyncError(
      `the ${TEAMS_BOTS_CONFIG_KEY} setup field of ${CHANNEL_TEAMS_PLUGIN_ID} ${origin} is not a JSON array — refusing to overwrite a value this sync cannot read`,
    );
  }
  return value.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new TeamsBotsConfigSyncError(
        `${TEAMS_BOTS_CONFIG_KEY} entry ${String(index)} is not an object — refusing to overwrite a value this sync cannot read`,
      );
    }
    return entry;
  });
}

/**
 * Read the plugin's stored `teams_bots` value.
 *
 * Accepts exactly what `parseTeamsBotsConfig` accepts as a CONTAINER —
 * `undefined` / `null` / `''` / `[]` (nothing configured), a real array, or a
 * JSON string encoding that array — and rejects everything else loudly.
 * Entry-level validation is deliberately NOT repeated here: an entry this sync
 * does not own is none of its business, and re-validating it would turn a
 * foreign operator mistake into a failure of an unrelated provisioning run.
 */
export function readTeamsBotsConfig(raw: unknown): TeamsBotsConfigDocument {
  if (raw === undefined || raw === null) return { entries: [], form: 'string' };
  if (typeof raw === 'string') {
    if (raw.trim().length === 0) return { entries: [], form: 'string' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new TeamsBotsConfigSyncError(
        `the ${TEAMS_BOTS_CONFIG_KEY} setup field of ${CHANNEL_TEAMS_PLUGIN_ID} is not valid JSON (${err instanceof Error ? err.message : String(err)}) — refusing to overwrite a value this sync cannot read`,
      );
    }
    return { entries: asEntries(parsed, 'holds a JSON value that'), form: 'string' };
  }
  return { entries: asEntries(raw, 'holds a value that'), form: 'array' };
}

/** Serialize a document back into a config value of its original form. The
 *  string form is pretty-printed: an operator who opens the setup field after
 *  a sync must be able to read and edit what is in it. */
export function serializeTeamsBotsConfig(
  doc: TeamsBotsConfigDocument,
): string | readonly Record<string, unknown>[] {
  return doc.form === 'array'
    ? doc.entries
    : JSON.stringify(doc.entries, null, 2);
}

/** The projection as a plain entry object, in the key order the operator UI
 *  renders (`formatTeamsBotsConfig` in web-ui) so a written entry and a pasted
 *  one are textually identical. */
export function teamsBotConfigEntry(
  projection: TeamsBotConfigProjection,
): Record<string, unknown> {
  return {
    botSlug: projection.botSlug,
    displayName: projection.displayName,
    appId: projection.appId,
    appType: projection.appType,
    tenantId: projection.tenantId,
    appPasswordSecretRef: projection.appPasswordSecretRef,
  };
}

/** `botSlug` of a raw entry, read with `parseTeamsBotsConfig`'s own
 *  trimmed-non-empty-string semantics. `undefined` for an entry that has none
 *  — such an entry is foreign by definition and is never matched. */
function entrySlug(entry: Record<string, unknown>): string | undefined {
  const value = entry['botSlug'];
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function sameEntry(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  if (keysA.some((key, i) => key !== keysB[i])) return false;
  return keysA.every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key]));
}

export interface TeamsBotsUpsertResult {
  readonly document: TeamsBotsConfigDocument;
  /** `false` when the stored entry already equals the projection — the caller
   *  then skips the write AND the reactivation, so a no-op re-run does not
   *  bounce a live channel plugin. */
  readonly changed: boolean;
}

/**
 * Place this identity's entry in the list: replace the entry with the same
 * `botSlug` IN PLACE, or append when there is none. Every other entry is
 * carried over by reference, untouched.
 */
export function upsertTeamsBotEntry(
  doc: TeamsBotsConfigDocument,
  projection: TeamsBotConfigProjection,
): TeamsBotsUpsertResult {
  const next = teamsBotConfigEntry(projection);
  const index = doc.entries.findIndex(
    (entry) => entrySlug(entry) === projection.botSlug,
  );
  if (index === -1) {
    return {
      document: { entries: [...doc.entries, next], form: doc.form },
      changed: true,
    };
  }
  const current = doc.entries[index];
  if (current !== undefined && sameEntry(current, next)) {
    return { document: doc, changed: false };
  }
  const entries = [...doc.entries];
  entries[index] = next;
  return { document: { entries, form: doc.form }, changed: true };
}

// ---------------------------------------------------------------------------
// The sync itself
// ---------------------------------------------------------------------------

export type TeamsBotsConfigSyncSkipReason =
  /** channel-teams is not installed — a legitimate deployment, not an error:
   *  the identity is provisioned and the entry has nowhere to go yet. */
  | 'plugin_not_installed'
  /** No installed registry is bound (tests, minimal mounts, pre-boot). */
  | 'registry_unavailable'
  /** The identity has no `app_id`/`tenant_id` yet, so there is no entry to
   *  write. Unreachable from the `installed` state; total anyway. */
  | 'identity_incomplete';

export type TeamsBotsConfigSyncOutcome =
  | { readonly status: 'synced'; readonly botSlug: string }
  | { readonly status: 'unchanged'; readonly botSlug: string }
  | {
      readonly status: 'skipped';
      readonly reason: TeamsBotsConfigSyncSkipReason;
    };

export interface TeamsBotsConfigSyncDeps {
  /** Late-bound like every other registry accessor in the boot wiring. */
  readonly getInstalledRegistry: () => InstalledRegistry | undefined;
  /**
   * Re-activate the plugin so the new entry is live WITHOUT a restart. This is
   * the plugin-side equivalent of the operator router's `registry.reload()`:
   * channel-teams builds its adapters and per-bot routes in `activate()`, so a
   * config write alone would only take effect on the next boot.
   */
  readonly reactivate?: (pluginId: string) => Promise<unknown>;
  /** Override for tests; defaults to `@omadia/channel-teams`. */
  readonly pluginId?: string;
  readonly clientSecretRef?: (record: TeamsBotIdentitySource) => string;
}

/**
 * Write this identity's `teams_bots` entry into the channel-teams plugin
 * config and reload the plugin.
 *
 * Throws {@link TeamsBotsConfigSyncError} (unreadable stored value) or
 * whatever the registry/reactivation threw. Callers on the provisioning path
 * must treat that as a WARNING on an otherwise-successful run — see the module
 * header.
 */
export async function syncTeamsBotConfig(
  deps: TeamsBotsConfigSyncDeps,
  record: TeamsBotIdentitySource,
): Promise<TeamsBotsConfigSyncOutcome> {
  const projection = projectTeamsBotConfig(record, deps.clientSecretRef);
  if (!projection) return { status: 'skipped', reason: 'identity_incomplete' };

  const pluginId = deps.pluginId ?? CHANNEL_TEAMS_PLUGIN_ID;
  const registry = deps.getInstalledRegistry();
  if (!registry) return { status: 'skipped', reason: 'registry_unavailable' };

  const installed = registry.get(pluginId);
  if (!installed) return { status: 'skipped', reason: 'plugin_not_installed' };

  const doc = readTeamsBotsConfig(installed.config[TEAMS_BOTS_CONFIG_KEY]);
  const { document, changed } = upsertTeamsBotEntry(doc, projection);
  if (!changed) return { status: 'unchanged', botSlug: projection.botSlug };

  await registry.updateConfig(pluginId, {
    ...installed.config,
    [TEAMS_BOTS_CONFIG_KEY]: serializeTeamsBotsConfig(document),
  });
  // Reload AFTER the write, and only after a write: an activation failure
  // must not be able to leave the config unwritten, and a no-op run must not
  // bounce a plugin that is serving traffic.
  await deps.reactivate?.(pluginId);
  return { status: 'synced', botSlug: projection.botSlug };
}

// ---------------------------------------------------------------------------
// Status projection (the operator UI's "did the sync take?" signal)
// ---------------------------------------------------------------------------

export type TeamsBotsConfigSyncState =
  /** The plugin config holds exactly this identity's entry. */
  | 'synced'
  /** An entry for this slug exists but differs — a hand edit, or a sync that
   *  failed after an identity field changed. */
  | 'out_of_sync'
  /** channel-teams is installed and has no entry for this slug. */
  | 'missing'
  | 'plugin_not_installed'
  /** The stored value cannot be read, so nothing was written. */
  | 'unreadable'
  /** No entry exists to compare yet (identity before `app_registered`). */
  | 'not_applicable'
  /** No installed registry is bound — the status is genuinely unknown. */
  | 'unknown';

export interface TeamsBotsConfigSyncStatus {
  readonly state: TeamsBotsConfigSyncState;
  readonly plugin_id: string;
  readonly config_key: string;
}

/**
 * Answer "is this bot actually configured in channel-teams right now?" by
 * LOOKING, not by remembering.
 *
 * Deliberately derived from the live plugin config instead of a persisted
 * "we synced it" flag: an operator can edit or delete the entry at any time,
 * and a recorded intention would then tell the UI a comfortable lie. The
 * identity row stays free of a column that could disagree with reality.
 */
export function projectTeamsBotsConfigSyncStatus(
  deps: Pick<TeamsBotsConfigSyncDeps, 'getInstalledRegistry' | 'pluginId' | 'clientSecretRef'>,
  record: TeamsBotIdentitySource,
): TeamsBotsConfigSyncStatus {
  const pluginId = deps.pluginId ?? CHANNEL_TEAMS_PLUGIN_ID;
  const base = { plugin_id: pluginId, config_key: TEAMS_BOTS_CONFIG_KEY };
  const projection = projectTeamsBotConfig(record, deps.clientSecretRef);
  if (!projection) return { ...base, state: 'not_applicable' };

  const registry = deps.getInstalledRegistry();
  if (!registry) return { ...base, state: 'unknown' };
  const installed = registry.get(pluginId);
  if (!installed) return { ...base, state: 'plugin_not_installed' };

  let doc: TeamsBotsConfigDocument;
  try {
    doc = readTeamsBotsConfig(installed.config[TEAMS_BOTS_CONFIG_KEY]);
  } catch {
    return { ...base, state: 'unreadable' };
  }
  const current = doc.entries.find(
    (entry) => entrySlug(entry) === projection.botSlug,
  );
  if (current === undefined) return { ...base, state: 'missing' };
  return {
    ...base,
    state: sameEntry(current, teamsBotConfigEntry(projection))
      ? 'synced'
      : 'out_of_sync',
  };
}
