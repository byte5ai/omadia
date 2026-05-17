// Channel plugin contract
export type {
  ChannelPlugin,
  ChannelHandle,
  ChannelRegistry,
  ChannelPluginResolver,
} from './plugin.js';

// What channels call on the core
export type { CoreApi, HttpMethod, LogLevel } from './coreApi.js';

// Inbound message shape
export type {
  IncomingTurn,
  ChannelUserRef,
  ChannelUserKind,
  IncomingAttachment,
  PlatformIdentity,
} from './incoming.js';

// Orchestrator → channel stream envelope (back-compat re-export)
export type { ChatStreamEvent } from './streamEvent.js';

// Orchestrator surface contract — lifted from the kernel in S+10-2 so
// channel-plugins-final (S+11) and the orchestrator-plugin (S+10-3/4) can
// consume `ChatAgent` without depending on the concrete Orchestrator class.
export type {
  ChatAgent,
  ChatStreamObserver,
  ChatTurnInput,
  ChatTurnAttachment,
  ChatTurnResult,
  VerifierResultSummary,
  RunTracePayload,
  RunStatus,
  RunToolCall,
  RunAgentInvocation,
  DiagramAttachment,
  PendingUserChoice,
  PendingSlotCard,
  PendingRoutineList,
  AgentMeta,
} from './chatAgent.js';

// Conversion helper from kernel-shaped result to channel-agnostic outgoing
// message — lifted from `services/orchestrator.ts` in S+10-2 so channel
// adapters can call it without crossing into kernel internals.
export { toSemanticAnswer } from './toSemanticAnswer.js';

// Privacy-Shield v2 (Slice S-6) — egress filter glue. Serialises a
// `ChatTurnResult` into the privacy-guard's flat `{ id, text }` slot
// shape and re-merges the filter's replacements back onto the result.
export {
  collectEgressSlots,
  applyEgressReplacements,
  buildBlockedResult,
  type EgressSlot,
} from './egressWalker.js';

// Semantic outgoing-message contracts (connectors render native)
export type {
  SemanticAnswer,
  OutgoingAttachment,
  VerifierBadge,
  FollowUpOption,
  OutgoingInteractive,
  OutgoingChoiceCard,
  OutgoingSlotPicker,
  OutgoingTopicAsk,
  CaptureDisclosure,
} from './outgoing.js';

// Channel-agnostic store interfaces
export type {
  ConversationTurn,
  ConversationHistoryStore,
  PersistedAttachment,
  AttachmentPutInput,
  AttachmentStore,
} from './stores.js';

// Phase 5B: in-memory implementation channel plugins can construct
// directly. Lifted from `middleware/src/services/conversationHistory.ts`
// so dynamic-imported channels don't depend on a kernel singleton.
export {
  InMemoryConversationHistoryStore,
  type InMemoryConversationHistoryStoreOptions,
  type PendingTopicDecision,
} from './inMemoryConversationHistory.js';

// NO_REPLY sentinel: agent emits this literal when it has nothing to say,
// channel adapters drop the message before forwarding to the provider.
export { NO_REPLY_SENTINEL, isNoReply, logNoReplyDrop } from './noReply.js';
