// What the contract-suite harness hands a test besides the kernel itself: the
// simulated channel and the fixture engine plugin.

import type {
  ConversationRoster,
  CoreApi,
  TargetedDeliveryOutcome,
  TargetedMessage,
} from '@omadia/channel-sdk';
import type {
  AgentTurnService,
  ChannelReadinessReport,
  ChannelReadinessService,
  ConversationMessagesService,
  ConversationSendService as PluginConversationSendService,
  NativeToolCallContext,
  SessionCapabilitiesService,
  TargetedSendService,
} from '@omadia/plugin-api';

// ── simulated channel ──────────────────────────────────────────────────────

export interface RecordedSend {
  readonly kind: 'conversation' | 'direct';
  readonly target: string;
  /** The identity the message went out as; `undefined` = the channel's default bot. */
  readonly asChannelKey: string | undefined;
  readonly message: TargetedMessage;
  readonly userRef?: unknown;
}

export interface SimulatedChannel {
  readonly core: CoreApi;
  readonly sent: RecordedSend[];
  rosters: Map<string, ConversationRoster>;
  readiness: ChannelReadinessReport | undefined;
  /** What the next send answers; reset to `delivered` after each send. */
  nextOutcome: TargetedDeliveryOutcome | undefined;
  /** A bot was added to a group conversation. */
  botAdded(conversationId: string): void;
}

// ── fixture engine plugin ──────────────────────────────────────────────────

export interface FixtureEngine {
  readonly pluginId: string;
  readonly messages: ConversationMessagesService;
  readonly agentTurn: AgentTurnService;
  readonly conversationSend: PluginConversationSendService;
  readonly targetedSend: TargetedSendService;
  readonly readiness: ChannelReadinessService;
  readonly capabilities: SessionCapabilitiesService;
  /** Every tool call the engine's tools received, with the kernel's context. */
  readonly toolCalls: { tool: string; input: unknown; context: NativeToolCallContext | undefined }[];
}
