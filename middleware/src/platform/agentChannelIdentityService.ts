// Registering and removing an agent's own bot on a channel (spec 2042 §5.3).
//
// The operator enters the bot's credentials for an agent; the channel plugin
// that runs the bot checks them with the platform, keeps them in its vault,
// starts the bot and returns its routing key; this service stores (agent,
// channel type, key) and reloads the registry, after which every turn through
// the bot belongs to the agent (`ManagementRouter` step 1, `identity`).
//
// Credentials pass through here once and are never stored or logged: an
// error text from the plugin is scrubbed of every credential value before it
// is logged or returned.

import {
  normalizeAgentIdentityKey,
  type AgentIdentityDescription,
  type AgentIdentityField,
  type AgentIdentityProvider,
  type AgentIdentityStatus,
} from '@omadia/channel-sdk';

import {
  AgentChannelIdentityConflict,
  type AgentChannelIdentityRecord,
  type AgentChannelIdentityStore,
} from './agentChannelIdentityStore.js';

/** The longest credential value accepted (a Slack token is ~60 characters). */
export const MAX_CREDENTIAL_LENGTH = 4096;
/** The longest routing key the table accepts (migration 0105). */
const MAX_CHANNEL_KEY_LENGTH = 200;
const STATUS_TIMEOUT_MS = 3000;
/** The longest name of a bot the kernel stores for display. */
const MAX_NAME_LENGTH = 200;

/** A plugin's `identify` answer narrowed: a key and display names, or undefined. */
function describedBot(outcome: unknown): AgentIdentityDescription | undefined {
  const o = (outcome ?? {}) as { ok?: unknown; channelKey?: unknown; externalRef?: unknown; displayName?: unknown };
  if (o.ok !== true || typeof o.channelKey !== 'string') return undefined;
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, MAX_NAME_LENGTH) : undefined;
  const externalRef = text(o.externalRef);
  const displayName = text(o.displayName);
  return {
    channelKey: normalizeAgentIdentityKey(o.channelKey),
    ...(externalRef ? { externalRef } : {}),
    ...(displayName ? { displayName } : {}),
  };
}

export interface AgentIdentityProviders {
  get(channelType: string): AgentIdentityProvider | undefined;
  types(): readonly string[];
}

export interface IdentityAgent {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export interface AgentChannelIdentityServiceDeps {
  readonly providers: AgentIdentityProviders;
  readonly store: AgentChannelIdentityStore;
  /** Makes the new or removed bot key visible to routing. */
  readonly reload: () => Promise<void>;
  readonly log?: (msg: string) => void;
}

export interface ChannelIdentityView {
  readonly channelType: string;
  readonly channelKey: string;
  readonly externalRef: string | null;
  readonly displayName: string | null;
  readonly createdAt: string;
  /** `unknown` when the plugin is not active or does not report. */
  readonly status: AgentIdentityStatus;
}

export interface ChannelIdentityChannel {
  readonly channelType: string;
  readonly fields: readonly AgentIdentityField[];
  readonly identity: ChannelIdentityView | null;
}

export interface ChannelIdentityOverview {
  /** One entry per channel whose plugin runs agent bots, plus channels the
   *  agent has a bot on whose plugin is not active (`fields` empty). */
  readonly channels: readonly ChannelIdentityChannel[];
}

export type ProvisionResult =
  | { readonly ok: true; readonly identity: ChannelIdentityView }
  | { readonly ok: false; readonly status: number; readonly error: string; readonly message: string };

export type RemoveResult =
  | { readonly ok: true; readonly removed: AgentChannelIdentityRecord; readonly released: boolean }
  | { readonly ok: false; readonly status: number; readonly error: string; readonly message: string };

const REFUSAL_STATUS: Readonly<Record<string, number>> = {
  invalid_credentials: 422,
  invalid_input: 400,
  already_in_use: 409,
  unreachable: 502,
};

function refusal(status: number, error: string, message: string): { ok: false; status: number; error: string; message: string } {
  return { ok: false, status, error, message };
}

/**
 * Replace every credential value in `text`: a plugin's error may echo one, as
 * is or URL-encoded (a Telegram token's `:` in a request URL is `%3A`).
 */
export function scrubCredentials(text: string, credentials: Readonly<Record<string, string>>): string {
  let out = text;
  for (const value of Object.values(credentials)) {
    if (value.length < 4) continue;
    const encoded = encodeURIComponent(value);
    // Percent-escapes are case-insensitive: `%3A` and `%3a` are both seen.
    const lowerEscapes = encoded.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
    for (const form of new Set([value, encoded, lowerEscapes])) out = out.split(form).join('[redacted]');
  }
  return out.slice(0, 500);
}

/**
 * Exactly the declared fields, as trimmed strings; a required one present.
 * Returns the cleaned map or the reason it was refused (never the value).
 */
export function validateCredentials(
  fields: readonly AgentIdentityField[],
  raw: unknown,
): { ok: true; credentials: Record<string, string> } | { ok: false; message: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'credentials must be an object' };
  }
  const input = raw as Record<string, unknown>;
  const known = new Set(fields.map((f) => f.key));
  const unknownKey = Object.keys(input).find((k) => !known.has(k));
  if (unknownKey !== undefined) return { ok: false, message: `unknown field '${unknownKey}'` };
  const credentials: Record<string, string> = {};
  for (const field of fields) {
    const value = input[field.key];
    if (value === undefined || value === null || value === '') {
      if (field.required !== false) return { ok: false, message: `'${field.key}' is required` };
      continue;
    }
    if (typeof value !== 'string') return { ok: false, message: `'${field.key}' must be a string` };
    const trimmed = value.trim();
    if (trimmed.length > MAX_CREDENTIAL_LENGTH) return { ok: false, message: `'${field.key}' is too long` };
    if (trimmed === '' && field.required !== false) return { ok: false, message: `'${field.key}' is required` };
    if (trimmed !== '') credentials[field.key] = trimmed;
  }
  return { ok: true, credentials };
}

async function statusOf(provider: AgentIdentityProvider | undefined, channelKey: string): Promise<AgentIdentityStatus> {
  if (!provider) return { state: 'unknown', detail: 'the channel plugin is not active' };
  if (!provider.status) return { state: 'unknown' };
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      provider.status(channelKey),
      new Promise<AgentIdentityStatus>((resolve) => {
        timer = setTimeout(() => resolve({ state: 'unknown', detail: 'no answer from the channel plugin' }), STATUS_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return { state: 'unknown', detail: 'the channel plugin could not report' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function view(record: AgentChannelIdentityRecord, status: AgentIdentityStatus): ChannelIdentityView {
  return {
    channelType: record.channelType,
    channelKey: record.channelKey,
    externalRef: record.externalRef,
    displayName: record.displayName,
    createdAt: record.createdAt.toISOString(),
    status,
  };
}

export function createAgentChannelIdentityService(deps: AgentChannelIdentityServiceDeps) {
  const log = deps.log ?? (() => undefined);

  async function overview(agent: IdentityAgent): Promise<ChannelIdentityOverview> {
    const records = await deps.store.listForAgent(agent.id);
    const byType = new Map(records.map((r) => [r.channelType, r]));
    const types = [...new Set([...deps.providers.types(), ...byType.keys()])].sort();
    const channels = await Promise.all(
      types.map(async (channelType): Promise<ChannelIdentityChannel> => {
        const provider = deps.providers.get(channelType);
        const record = byType.get(channelType);
        return {
          channelType,
          fields: provider?.fields ?? [],
          identity: record ? view(record, await statusOf(provider, record.channelKey)) : null,
        };
      }),
    );
    return { channels };
  }

  /** The plugin's default bot key, or undefined (also when the plugin throws). */
  function defaultKeyOf(provider: AgentIdentityProvider): string | undefined {
    try {
      const key = provider.defaultChannelKey?.();
      return typeof key === 'string' && key.trim() !== '' ? normalizeAgentIdentityKey(key) : undefined;
    } catch {
      return undefined;
    }
  }

  /** A plugin refusal as the route answers it: known codes only, scrubbed text. */
  function refusalOf(outcome: unknown, credentials: Readonly<Record<string, string>>): ProvisionResult {
    const o = (outcome ?? {}) as { code?: unknown; message?: unknown };
    const code = typeof o.code === 'string' && o.code in REFUSAL_STATUS ? o.code : 'unreachable';
    const message = typeof o.message === 'string' ? o.message : 'the channel plugin refused the bot';
    return refusal(REFUSAL_STATUS[code] ?? 502, code, scrubCredentials(message, credentials));
  }

  /** Stop a bot nobody owns; a failure is logged without the plugin's text. */
  async function releaseOrphan(provider: AgentIdentityProvider, channelKey: string, why: string): Promise<void> {
    try {
      await provider.release(channelKey);
    } catch {
      log(`[agent-identities] the ${provider.channelType} bot ${channelKey} (${why}) could not be stopped; it may still run in the plugin`);
    }
  }

  async function provision(agent: IdentityAgent, channelType: string, rawCredentials: unknown): Promise<ProvisionResult> {
    const provider = deps.providers.get(channelType);
    if (!provider) {
      return refusal(404, 'channel_not_available', `no active channel plugin runs agent bots on '${channelType}'`);
    }
    const checked = validateCredentials(provider.fields, rawCredentials);
    if (!checked.ok) return refusal(400, 'invalid_input', checked.message);
    if (await deps.store.get(agent.id, channelType)) {
      return refusal(409, 'agent_has_identity', `the agent has a ${channelType} bot already — remove it first`);
    }
    const { credentials } = checked;
    const input = { agentSlug: agent.slug, agentDisplayName: agent.name, credentials };
    const pluginFailed = (step: string, err: unknown): ProvisionResult => {
      const message = scrubCredentials(err instanceof Error ? err.message : String(err), credentials);
      log(`[agent-identities] ${channelType} bot for '${agent.slug}' failed in the plugin (${step}): ${message}`);
      return refusal(502, 'unreachable', 'the channel plugin could not register the bot');
    };

    // 1. Which bot is it? No side effect in the plugin yet.
    let identified: unknown;
    try {
      identified = await provider.identify(input);
    } catch (err) {
      return pluginFailed('identify', err);
    }
    const described = describedBot(identified);
    if (!described) return refusalOf(identified, credentials);
    const { channelKey } = described;
    if (channelKey === '' || channelKey.length > MAX_CHANNEL_KEY_LENGTH) {
      log(`[agent-identities] ${channelType} plugin named an unusable bot key for '${agent.slug}'`);
      return refusal(502, 'invalid_key', 'the channel plugin returned an unusable bot key');
    }
    // 2. Is it free? The default bot and another agent's bot are refused
    //    before the plugin does anything to them.
    if (defaultKeyOf(provider) === channelKey) {
      return refusal(409, 'already_in_use', `this is the ${channelType} channel's default bot — give the agent a bot of its own`);
    }
    const owner = await deps.store.ownerOf(channelType, channelKey);
    if (owner !== undefined) {
      return refusal(409, 'bot_taken', `this ${channelType} bot belongs to ${owner === agent.id ? 'this' : 'another'} agent`);
    }
    // 3. Start it.
    let started: unknown;
    try {
      started = await provider.provision(input, channelKey);
    } catch (err) {
      return pluginFailed('provision', err);
    }
    if ((started as { ok?: unknown } | null)?.ok !== true) return refusalOf(started, credentials);
    let record: AgentChannelIdentityRecord;
    try {
      record = await deps.store.insert({
        agentId: agent.id,
        channelType,
        channelKey,
        displayName: described.displayName ?? null,
        externalRef: described.externalRef ?? null,
      });
    } catch (err) {
      // A concurrent request may have taken the agent or the bot meanwhile.
      // Stop the bot unless an agent now owns it (then it is that agent's).
      if ((await deps.store.ownerOf(channelType, channelKey).catch(() => 'unknown')) === undefined) {
        await releaseOrphan(provider, channelKey, 'not stored');
      }
      if (err instanceof AgentChannelIdentityConflict) return refusal(409, err.reason, err.message);
      throw err;
    }
    await deps.reload();
    log(`[agent-identities] '${agent.slug}' speaks on ${channelType} through its own bot ${channelKey}`);
    return { ok: true, identity: view(record, await statusOf(provider, channelKey)) };
  }

  async function remove(agent: IdentityAgent, channelType: string): Promise<RemoveResult> {
    const record = await deps.store.get(agent.id, channelType);
    if (!record) return refusal(404, 'identity_not_found', `the agent has no ${channelType} bot`);
    const released = await releaseRecord(record);
    if (released === 'failed') {
      return refusal(502, 'unreachable', 'the channel plugin could not stop the bot — nothing was removed');
    }
    await deps.store.delete(agent.id, channelType);
    await deps.reload();
    log(`[agent-identities] '${agent.slug}' no longer has its own ${channelType} bot (${record.channelKey})`);
    return { ok: true, removed: record, released: released === 'released' };
  }

  /**
   * Ask the plugin to stop the bot and forget its credentials. `skipped`
   * when the plugin is not active: there is nothing to stop, but the
   * credentials may still be in its vault (the operator should revoke them).
   * A plugin's error text is not logged: it may carry a credential.
   */
  async function releaseRecord(record: AgentChannelIdentityRecord): Promise<'released' | 'skipped' | 'failed'> {
    const provider = deps.providers.get(record.channelType);
    if (!provider) return 'skipped';
    try {
      await provider.release(record.channelKey);
      return 'released';
    } catch (err) {
      log(
        `[agent-identities] releasing ${record.channelType} bot ${record.channelKey} failed (${err instanceof Error ? err.name : 'error'})`,
      );
      return 'failed';
    }
  }

  /**
   * #2088 purge — stop every bot of an agent before its row (and with it,
   * by `ON DELETE CASCADE`, its identities) is gone for good. `ok: false`
   * names the bots an active plugin could not stop; the purge then waits.
   */
  async function releaseAll(agentId: string): Promise<{ ok: boolean; failed: readonly string[]; notReleased: readonly string[] }> {
    const records = await deps.store.listForAgent(agentId);
    const failed: string[] = [];
    const notReleased: string[] = [];
    for (const record of records) {
      const outcome = await releaseRecord(record);
      if (outcome === 'failed') failed.push(`${record.channelType}:${record.channelKey}`);
      if (outcome === 'skipped') notReleased.push(`${record.channelType}:${record.channelKey}`);
    }
    return { ok: failed.length === 0, failed, notReleased };
  }

  return { overview, provision, remove, releaseAll };
}

export type AgentChannelIdentityService = ReturnType<typeof createAgentChannelIdentityService>;
