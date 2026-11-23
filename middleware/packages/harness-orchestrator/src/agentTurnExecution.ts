import type { ChatAgent, ChatStreamEvent, ChatStreamObserver, ChatTurnInput } from '@omadia/channel-sdk';
import type { SemanticAnswer } from '@omadia/channel-sdk';
import {
  runGeneratorInExecutionContext,
  runInExecutionContext,
  type ModelExecutionContext,
} from '@omadia/usage-telemetry';

const INNER_AGENT = Symbol.for('omadia.agentTurnExecution.inner');

/** The chat agent a {@link withAgentTurnExecution} wrapper runs; any other
 *  agent is returned as it is. */
export function innerChatAgent(agent: ChatAgent): ChatAgent {
  return ((agent as unknown as Record<symbol, ChatAgent | undefined>)[INNER_AGENT]) ?? agent;
}

/**
 * Spec 2042 §5.10 — every turn of an agent is an execution context of the
 * model gateway: the agent turn, charged to and limited by the agent's
 * envelope.
 *
 * The agent runtime's own turn scope (`turnContext`) already marks most of
 * it (`currentAgentTurnExecutionContext`). This wrapper is the outermost
 * layer of an agent's chat agent, so what runs before and after that scope
 * is the agent's too: the fast lane's triage and planner before the loop,
 * the verifier's scorers after it, and the `claude-cli` runtime, which
 * opens no turn scope of its own.
 *
 * Every property other than `chat` and `chatStream` passes through, so the
 * capabilities a wrapper probes (`holdsContentUntilVerdict`,
 * `offeredToolNames`, …) are the inner agent's.
 */
export function withAgentTurnExecution(agent: ChatAgent, agentSlug: string): ChatAgent {
  const context: ModelExecutionContext = { kind: 'agent_turn', ownerId: agentSlug, agentSlug };
  return new Proxy(agent, {
    get(target, prop, receiver) {
      if (prop === INNER_AGENT) return target;
      if (prop === 'chat') {
        return (input: ChatTurnInput): Promise<SemanticAnswer> =>
          runInExecutionContext(context, () => target.chat(input));
      }
      if (prop === 'chatStream') {
        return (input: ChatTurnInput, observer?: ChatStreamObserver): AsyncGenerator<ChatStreamEvent> =>
          runGeneratorInExecutionContext(context, () => target.chatStream(input, observer));
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
