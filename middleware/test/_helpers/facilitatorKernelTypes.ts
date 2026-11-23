// What the contract-suite harness hands a test besides the kernel itself: the
// simulated channel and the fixture engine plugin.

import type {
  ConversationRoster,
  CoreApi,
  TargetedDeliveryOutcome,
  TargetedMessage,
} from '@omadia/channel-sdk';
import type {
  ChannelReadinessReport,
  ChannelReadinessService,
  ExecutionAuthorizationService,
  NativeToolCallContext,
  ProcessConversationMessagesService,
  ProcessMessageScope,
  ScopedAgentTurnService,
  ScopedConversationSendService,
  SendAuthorization,
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

/** The kernel services a plugin runs a facilitation with, as that plugin
 *  gets them from the service registry. */
export interface PluginServices {
  readonly execution: ExecutionAuthorizationService;
  readonly messages: ProcessConversationMessagesService;
  readonly agentTurn: ScopedAgentTurnService;
  readonly conversationSend: ScopedConversationSendService;
  readonly targetedSend: TargetedSendService;
}

/** One process (a facilitation) of the fixture engine: its open `active`
 *  execution scope, and the conversation it was started in. */
export interface FixtureProcess {
  readonly processId: string;
  readonly scopeId: string;
  /** What every read of the process names. */
  readonly scope: ProcessMessageScope;
  /** What a post of the process states; a turn states the same scope. */
  readonly authorization: SendAuthorization;
}

export interface FixtureEngine extends PluginServices {
  readonly pluginId: string;
  readonly readiness: ChannelReadinessService;
  readonly capabilities: SessionCapabilitiesService;
  /** Every tool call the engine's tools received, with the kernel's context. */
  readonly toolCalls: { tool: string; input: unknown; context: NativeToolCallContext | undefined }[];
  /** The processes its `facilitation_start` tool started and subscribed. */
  readonly started: FixtureProcess[];
  /**
   * Start a process for an agent in a conversation: a `configuring` scope
   * with the conversation as home (which reserves it), then the `active`
   * scope. Rejects with the refusal's code when the kernel refuses either.
   */
  openProcess(agentSlug: string, conversationId: string, channelType?: string): Promise<FixtureProcess>;
}
