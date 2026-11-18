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
// and anything for another channel type is dropped (events) or refused
// (providers). The kernel knows both facts itself — the id from the install,
// the channel type from the manifest (`channelTypeFor`) — so nothing here
// relies on what the plugin says about itself.
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

export function scopeCoreApiToChannel(
  core: CoreApi,
  channelId: string,
  channelType: string,
  log: (message: string) => void = () => undefined,
): CoreApi {
  const foreign = (what: string, stated: unknown): boolean => {
    if (stated === channelType) return false;
    log(
      `[channels] ${channelId} tried to ${what} for channel type '${String(stated)}'; it serves '${channelType}' — ignored`,
    );
    return true;
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
      // `channelType` is optional on a membership event; a stated one must be
      // the plugin's own, an absent one becomes it.
      if (event.channelType !== undefined && foreign('emit a membership event', event.channelType)) return;
      emit({ ...event, channelId, channelType });
    };
  }
  if (core.isAllMessagesSubscribed) {
    const ask = core.isAllMessagesSubscribed;
    // A plugin learns about subscriptions of its own channel type only.
    scoped.isAllMessagesSubscribed = (type, conversationId, channelKey): boolean =>
      type === channelType && ask(type, conversationId, channelKey);
  }
  if (core.registerReadinessProvider) {
    const register = core.registerReadinessProvider;
    scoped.registerReadinessProvider = (_stated: string, provider: ChannelReadinessProvider): void => {
      if (foreign('register a readiness provider', provider?.channelType)) {
        throw new Error(
          `channel '${channelId}' serves '${channelType}' and cannot register a readiness provider for '${String(provider?.channelType)}'`,
        );
      }
      register(channelId, provider);
    };
  }
  if (core.registerMeetingSourceProvider) {
    const register = core.registerMeetingSourceProvider;
    scoped.registerMeetingSourceProvider = (_stated: string, provider: MeetingSourceProvider): void => {
      if (foreign('register a meeting source', provider?.channelType)) {
        throw new Error(
          `channel '${channelId}' serves '${channelType}' and cannot register a meeting source for '${String(provider?.channelType)}'`,
        );
      }
      register(channelId, provider);
    };
  }
  return scoped;
}
