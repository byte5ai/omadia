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

/** Replace every credential value in `text` — a plugin's error may echo one. */
export function scrubCredentials(text: string, credentials: Readonly<Record<string, string>>): string {
  let out = text;
  for (const value of Object.values(credentials)) {
    if (value.length >= 4) out = out.split(value).join('[redacted]');
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
    let outcome;
    try {
      outcome = await provider.provision({ agentSlug: agent.slug, agentDisplayName: agent.name, credentials });
    } catch (err) {
      const message = scrubCredentials(err instanceof Error ? err.message : String(err), credentials);
      log(`[agent-identities] ${channelType} bot for '${agent.slug}' failed in the plugin: ${message}`);
      return refusal(502, 'unreachable', 'the channel plugin could not register the bot');
    }
    if (!outcome.ok) {
      return refusal(
        REFUSAL_STATUS[outcome.code] ?? 502,
        outcome.code,
        scrubCredentials(outcome.message, credentials),
      );
    }
    const channelKey = normalizeAgentIdentityKey(outcome.channelKey);
    // Never release in the two refusals below: the key names a bot that is
    // somebody else's (the default bot, or another agent's).
    if (channelKey === '' || channelKey.length > MAX_CHANNEL_KEY_LENGTH) {
      log(`[agent-identities] ${channelType} plugin returned an unusable bot key for '${agent.slug}'`);
      return refusal(502, 'invalid_key', 'the channel plugin returned an unusable bot key');
    }
    const defaultKey = provider.defaultChannelKey?.();
    if (defaultKey !== undefined && normalizeAgentIdentityKey(defaultKey) === channelKey) {
      return refusal(409, 'already_in_use', `this is the ${channelType} channel's default bot — give the agent a bot of its own`);
    }
    const owner = await deps.store.ownerOf(channelType, channelKey);
    if (owner !== undefined) {
      return refusal(409, 'bot_taken', `this ${channelType} bot belongs to ${owner === agent.id ? 'this' : 'another'} agent`);
    }
    let record: AgentChannelIdentityRecord;
    try {
      record = await deps.store.insert({
        agentId: agent.id,
        channelType,
        channelKey,
        displayName: outcome.displayName ?? null,
        externalRef: outcome.externalRef ?? null,
      });
    } catch (err) {
      if (err instanceof AgentChannelIdentityConflict) {
        return refusal(409, err.reason, err.message);
      }
      // The plugin serves a bot nobody owns now: stop it again.
      await provider.release(channelKey).catch(() => undefined);
      throw err;
    }
    await deps.reload();
    log(`[agent-identities] '${agent.slug}' speaks on ${channelType} through its own bot ${channelKey}`);
    return { ok: true, identity: view(record, await statusOf(provider, channelKey)) };
  }

  async function remove(agent: IdentityAgent, channelType: string): Promise<RemoveResult> {
    const record = await deps.store.get(agent.id, channelType);
    if (!record) return refusal(404, 'identity_not_found', `the agent has no ${channelType} bot`);
    const provider = deps.providers.get(channelType);
    // Without the plugin there is nothing to stop; the row goes anyway, so an
    // uninstalled plugin cannot pin an identity forever.
    let released = false;
    if (provider) {
      try {
        await provider.release(record.channelKey);
        released = true;
      } catch (err) {
        log(
          `[agent-identities] releasing ${channelType} bot ${record.channelKey} of '${agent.slug}' failed: ${
            err instanceof Error ? err.message.slice(0, 300) : String(err)
          }`,
        );
        return refusal(502, 'unreachable', 'the channel plugin could not stop the bot — nothing was removed');
      }
    }
    await deps.store.delete(agent.id, channelType);
    await deps.reload();
    log(`[agent-identities] '${agent.slug}' no longer has its own ${channelType} bot (${record.channelKey})`);
    return { ok: true, removed: record, released };
  }

  return { overview, provision, remove };
}

export type AgentChannelIdentityService = ReturnType<typeof createAgentChannelIdentityService>;
