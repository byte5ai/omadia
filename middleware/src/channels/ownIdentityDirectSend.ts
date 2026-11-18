// Direct message as an agent's OWN channel identity (#2043): the
// `asAgentSlug` branch of the targeted-send service.
//
// A facilitator reminds a person privately, or reports to the initiator, as
// itself. Rules, each a named outcome and never a throw:
//
//   - only 'user:<id>' principals; a role fan-out is not a facilitator's reach
//   - the agent has an identity of its own on the channel, else `no_identity`
//   - the agent moderates a conversation the recipient is part of (roster or
//     a stored message of theirs), else `not_permitted`
//   - the provider gets the recipient's channel user reference, so a FIRST
//     contact can open the 1:1; `app_not_installed` and `blocked` come back
//     from the provider as they are

import type {
  ChannelUserRef,
  TargetedDeliveryOutcome,
  TargetedMessage,
  TargetedSendReport,
} from '@omadia/channel-sdk';
import { parsePrincipal } from '@omadia/channel-sdk';

import {
  resolveChannelUser,
  unreachable,
  type OwnIdentityDeps,
} from './ownIdentitySend.js';
import type { TargetedSendRegistry } from './targetedSendRegistry.js';

export interface OwnIdentityDirectSendInput {
  channelType: string;
  principal: string;
  message: TargetedMessage;
  asAgentSlug: string;
  /** The recipient's channel reference when the caller knows it. */
  userRef?: { kind: string; id: string };
}

export interface OwnIdentityDirectSendDeps {
  providers: TargetedSendRegistry;
  ownIdentity?: OwnIdentityDeps;
  lookupConversationRefs?: (principalIds: string[], channelType: string) => Promise<Map<string, unknown>>;
  log: (msg: string) => void;
}

function report(principalId: string, outcome: TargetedDeliveryOutcome): TargetedSendReport {
  const principal = parsePrincipal(`user:${principalId}`);
  return {
    ...(principal ? { principal } : {}),
    resolution: { kind: 'single-user' },
    deliveries: [{ principalId, outcome }],
    diagnostics:
      outcome.outcome === 'unreachable'
        ? [
            {
              code: 'holder_unreachable',
              message: `delivery to '${principalId}' failed: ${outcome.code} — ${outcome.message}`,
              principalId,
            },
          ]
        : [],
  };
}

export async function sendDirectAsOwnIdentity(
  deps: OwnIdentityDirectSendDeps,
  input: OwnIdentityDirectSendInput,
  callerPluginId: string | undefined,
): Promise<TargetedSendReport> {
  const principal = parsePrincipal(input.principal);
  if (!principal || principal.kind !== 'user') {
    return {
      resolution: { kind: 'single-user' },
      deliveries: [],
      diagnostics: [
        {
          code: 'invalid_principal',
          message: `'${input.principal}' is not a user principal ('user:<id>'); an agent sends as itself to one person at a time`,
        },
      ],
    };
  }
  const principalId = principal.userId;
  const own = deps.ownIdentity;
  const identity = own?.identityFor(input.asAgentSlug, input.channelType);
  if (!own || !identity) {
    return report(
      principalId,
      unreachable(
        'no_identity',
        `agent '${input.asAgentSlug}' has no ${input.channelType} identity of its own — it does not write through another agent's bot`,
      ),
    );
  }
  const subscriptions = (own.subscriptions?.subscriptionsOf(input.asAgentSlug, input.channelType) ?? []).filter(
    (s) => callerPluginId === undefined || s.pluginId === callerPluginId,
  );
  const known = subscriptions.length > 0 ? await resolveChannelUser(own, subscriptions, principalId) : undefined;
  if (!known) {
    deps.log(
      `[channels] own-identity DM by '${input.asAgentSlug}' to '${principalId}' (${input.channelType}) refused (not a person of a conversation it moderates)`,
    );
    return report(
      principalId,
      unreachable(
        'not_permitted',
        `'${principalId}' is not part of a conversation agent '${input.asAgentSlug}' moderates — it only writes to people of its own facilitations`,
      ),
    );
  }
  // The caller's reference wins on the namespace (`kind`) only when it names
  // the SAME person; the id the kernel found is the authority.
  const stated = input.userRef;
  const userRef: ChannelUserRef =
    stated && typeof stated.id === 'string' && stated.id.toLowerCase() === known.id.toLowerCase()
      ? { ...known, kind: (typeof stated.kind === 'string' ? stated.kind : known.kind) as ChannelUserRef['kind'] }
      : known;

  const provider = deps.providers.get(input.channelType);
  if (!provider) {
    return {
      principal,
      resolution: { kind: 'single-user' },
      deliveries: [],
      diagnostics: [
        {
          code: 'no_targeted_send_provider',
          message: `no targeted-send provider registered for channel type '${input.channelType}'`,
        },
      ],
    };
  }
  const refs = deps.lookupConversationRefs
    ? await deps.lookupConversationRefs([principalId], input.channelType).catch(() => new Map<string, unknown>())
    : new Map<string, unknown>();
  const conversationRef = refs.get(principalId);
  let outcome: TargetedDeliveryOutcome;
  try {
    outcome = await provider.sendToUser(
      { principalId, userRef, ...(conversationRef !== undefined ? { conversationRef } : {}) },
      input.message,
      { asChannelKey: identity.channelKey },
    );
  } catch (err) {
    outcome = unreachable('channel_error', err instanceof Error ? err.message : String(err));
  }
  if (outcome.outcome === 'unreachable') {
    deps.log(
      `[channels] own-identity DM by '${input.asAgentSlug}' to '${principalId}' (${input.channelType}) unreachable: ${outcome.code}`,
    );
  }
  return report(principalId, outcome);
}
