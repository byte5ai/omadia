/**
 * A single user/assistant exchange. Channels emit these as conversation
 * history; the orchestrator-extras topic-detector reads them; the kernel-
 * side ConversationHistoryStore stores them. The shape is the cross-package
 * contract — keep it stable.
 */
export interface ConversationTurn {
  userMessage: string;
  assistantAnswer: string;
  /** Unix millis of the user message. Used for TTL + debug logs. */
  at: number;
}
