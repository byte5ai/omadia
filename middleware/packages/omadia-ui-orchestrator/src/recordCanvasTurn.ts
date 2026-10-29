import {
  PRIVACY_REDACT_SERVICE_NAME,
  type PluginContext,
  type PrivacyGuardService,
} from '@omadia/plugin-api';
import { CHAT_AGENT_SERVICE, type ChatAgentBundle, type ChatTurnInput } from '@omadia/channel-sdk';

/** The slice of the base orchestrator's SessionLogger (on the `chatAgent`
 *  bundle) a canvas fast-path turn is recorded through. */
interface CanvasSessionLogger {
  log(entry: {
    scope: string;
    userMessage: string;
    assistantAnswer: string;
    toolCalls?: number;
    iterations?: number;
    userId?: string;
    maskedView?: { userMessage: string; assistantAnswer: string };
    unprotected?: boolean;
  }): Promise<{ turnExternalId: string }>;
}

/** Record an LLM-free canvas answer (fast path, in-place learned plan) as
 *  a normal turn through the base orchestrator's session logger — the
 *  `chatAgent` bundle carries it (duck-typed: the channel-sdk bundle type
 *  does not name it). The rows stay on the canvas; the transcript holds
 *  the summary sentence. Under a Privacy Shield the masked view is EMPTY:
 *  no capture decorator sends the turn to a model of its own. Never throws. */
export async function recordCanvasTurn(
  ctx: PluginContext,
  input: ChatTurnInput,
  answer: string,
  toolCalls: number,
  /** transcript line for an action turn without user text */
  fallbackUserMessage?: string,
): Promise<string | undefined> {
  if (input.sessionScope === undefined) return undefined;
  const userMessage =
    input.userMessage.trim().length === 0 && fallbackUserMessage !== undefined
      ? fallbackUserMessage
      : input.userMessage;
  const bundle = ctx.services.get<ChatAgentBundle & { sessionLogger?: CanvasSessionLogger }>(CHAT_AGENT_SERVICE);
  const logger = bundle?.sessionLogger;
  if (!logger) return undefined;
  const guarded =
    (ctx.services as PluginContext['services'] | undefined)?.get<PrivacyGuardService>(PRIVACY_REDACT_SERVICE_NAME) !==
    undefined;
  try {
    const { turnExternalId } = await logger.log({
      scope: input.sessionScope,
      userMessage,
      assistantAnswer: answer,
      toolCalls,
      iterations: 0,
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      ...(guarded ? { maskedView: { userMessage: '', assistantAnswer: '' } } : {}),
      unprotected: !guarded,
    });
    return turnExternalId;
  } catch (err) {
    ctx.log(`[ui-orchestrator] fast-path session log failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}
