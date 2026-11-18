// CoreApi as ONE channel plugin sees it (#2043).
//
// `createCoreApi` builds a single object for the whole kernel, and every
// method that needs to know the caller takes a `channelId` the caller passes
// itself. That was acceptable while the worst a wrong id could do was a
// mislabelled log line. It is not for what #2043 added: an inbound message
// event is the kernel's authoritative record of who wrote what, and the
// membership event behind the presence check says "this bot is in this
// conversation". A second channel plugin must not be able to state either
// for a channel type it does not serve.
//
// So the channel registry hands each plugin a view of the CoreApi that is
// bound to it: the plugin's own id is stamped on what it emits and registers,
// and anything for a channel type ANOTHER plugin holds is dropped (events) or
// refused (providers).
//
// WHICH PLUGIN HOLDS A CHANNEL TYPE is decided the way every provider
// registry here already decides it: the first plugin that acts for a type
// owns it until it deactivates (`ChannelTypeClaims`). It cannot be read from
// the plugin id: `@omadia/channel-teams` serves `teams`, and the id-derived
// type of that plugin is the id itself. A channel plugin registers its
// providers while it activates, so the real owner holds its type before any
// event flows.
//
// Scope, deliberately narrow: the facilitator surfaces and the membership
// event. Turn handling, routes and the older provider registries keep their
// existing contract; they have their own ownership rules.

import type {
  ChannelReadinessProvider,
  ConversationMembershipEvent,
  ConversationMessageEvent,
  CoreApi,
  MeetingSourceProvider,
  SessionEvent,
} from '@omadia/channel-sdk';
import type { SessionCapabilitySnapshot } from '@omadia/plugin-api';

/** Which channel plugin acts for which channel type. First claim wins; a
 *  deactivated plugin's claims are released. */
export class ChannelTypeClaims {
  private readonly owners = new Map<string, string>();

  /** `true` when `channelId` holds `channelType` (claiming it if free). */
  claim(channelId: string, channelType: string): boolean {
    const owner = this.owners.get(channelType);
    if (owner === undefined) {
      this.owners.set(channelType, channelId);
      return true;
    }
    return owner === channelId;
  }

  ownerOf(channelType: string): string | undefined {
    return this.owners.get(channelType);
  }

  release(channelId: string): void {
    for (const [channelType, owner] of this.owners) {
      if (owner === channelId) this.owners.delete(channelType);
    }
  }
}

export function scopeCoreApiToChannel(
  core: CoreApi,
  channelId: string,
  claims: ChannelTypeClaims,
  log: (message: string) => void = () => undefined,
): CoreApi {
  /** `true` (and logged) when the type belongs to another channel plugin. */
  const foreign = (what: string, stated: unknown): boolean => {
    if (typeof stated === 'string' && stated.length > 0 && claims.claim(channelId, stated)) return false;
    log(
      `[channels] ${channelId} tried to ${what} for channel type '${String(stated)}', which ${
        typeof stated === 'string' && claims.ownerOf(stated) ? `belongs to ${claims.ownerOf(stated)!}` : 'is not a channel type'
      } — ignored`,
    );
    return true;
  };
  const refuse = (what: string, stated: unknown): never => {
    throw new Error(
      `channel '${channelId}' cannot register ${what} for '${String(stated)}': the channel type belongs to '${
        typeof stated === 'string' ? (claims.ownerOf(stated) ?? 'nobody') : 'nobody'
      }'`,
    );
  };

  const scoped: CoreApi = { ...core };

  if (core.emitConversationMessage) {
    const emit = core.emitConversationMessage;
    scoped.emitConversationMessage = (event: ConversationMessageEvent): void => {
      if (event === null || typeof event !== 'object' || foreign('emit a message event', event.channelType)) return;
      emit({ ...event, channelId });
    };
  }
  if (core.emitSessionEvent) {
    const emit = core.emitSessionEvent;
    scoped.emitSessionEvent = (event: SessionEvent): void => {
      if (event === null || typeof event !== 'object' || foreign('emit a session event', event.channelType)) return;
      emit({ ...event, channelId });
    };
  }
  if (core.emitSessionCapabilities) {
    const emit = core.emitSessionCapabilities;
    scoped.emitSessionCapabilities = (snapshot: SessionCapabilitySnapshot): void => {
      if (
        snapshot === null ||
        typeof snapshot !== 'object' ||
        foreign('report session capabilities', snapshot.channelType)
      ) {
        return;
      }
      emit(snapshot);
    };
  }
  if (core.emitConversationEvent) {
    const emit = core.emitConversationEvent;
    scoped.emitConversationEvent = (event: ConversationMembershipEvent): void => {
      if (event === null || typeof event !== 'object') return;
      // `channelType` is optional on a membership event. A stated one must be
      // the plugin's own; without one the event passes as it always did (it
      // then carries no channel type the presence check could match).
      if (event.channelType !== undefined && foreign('emit a membership event', event.channelType)) return;
      emit({ ...event, channelId });
    };
  }
  if (core.isAllMessagesSubscribed) {
    const ask = core.isAllMessagesSubscribed;
    // A plugin learns about subscriptions of its own channel type only.
    scoped.isAllMessagesSubscribed = (type, conversationId, channelKey): boolean =>
      typeof type === 'string' && claims.claim(channelId, type) && ask(type, conversationId, channelKey);
  }
  // Provider registrations: stamped with the plugin's own id, and each one is
  // a claim on its channel type. The older registries keep their own
  // first-registrant rule; claiming here keeps the two views in step.
  const claimed = <P extends { channelType: string }>(
    what: string,
    register: ((id: string, provider: P) => void) | undefined,
  ): ((id: string, provider: P) => void) | undefined =>
    register &&
    ((_stated: string, provider: P): void => {
      if (!provider || typeof provider.channelType !== 'string' || !claims.claim(channelId, provider.channelType)) {
        refuse(what, provider?.channelType);
      }
      register(channelId, provider);
    });
  const withClaim = {
    registerReadinessProvider: claimed<ChannelReadinessProvider>('a readiness provider', core.registerReadinessProvider),
    registerMeetingSourceProvider: claimed<MeetingSourceProvider>('a meeting source', core.registerMeetingSourceProvider),
    registerRosterProvider: claimed('a roster provider', core.registerRosterProvider),
    registerTargetedSendProvider: claimed('a targeted-send provider', core.registerTargetedSendProvider),
    registerConversationSendProvider: claimed('a conversation-send provider', core.registerConversationSendProvider),
  };
  for (const [name, fn] of Object.entries(withClaim)) {
    if (fn) (scoped as unknown as Record<string, unknown>)[name] = fn;
  }
  return scoped;
}
