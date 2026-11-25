/**
 * ADR-0017 — the privacy shield applies to every model call, including a
 * plugin's `ctx.llm`. Before this, a plugin tool got the user's real values
 * (tool inputs are restored before a handler runs, #1544) and could hand them
 * to a model unmasked (docs/security-architecture.md §6f).
 *
 * Inside a guarded turn (`turnContext.privacyHandle` present) the wire-bound
 * texts of the request — system prompt and every message — go through the
 * same two steps the turn's own prompt takes:
 *   1. the values this turn already masked are replaced by their surrogates
 *      again (`remaskPromptValues`), deterministic and independent of the
 *      `mask_user_prompt` flag;
 *   2. the detectors mask remaining PII spans (`maskUserPrompt`, origin
 *      `context`) when the operator enabled prompt masking. `blocked` fails
 *      the call closed: the request is never sent.
 * The answer text and the string leaves of tool-call inputs are restored to
 * real values before the plugin reads them, so plugin code keeps working on
 * the user's values. Without a handle (jobs, routes, no privacy provider) the
 * request passes byte-identical.
 */

import type { PrivacyTurnHandle } from '@omadia/orchestrator';
import type { LlmCompleteRequest, LlmCompleteResult } from '@omadia/plugin-api';

/** Thrown when the privacy shield refuses to let a `ctx.llm` prompt leave. */
export class LlmPrivacyBlockedError extends Error {
  constructor(callerAgentId: string, reason: string) {
    super(
      `plugin '${callerAgentId}' ctx.llm call refused by the privacy shield: the prompt could not be masked (${reason})`,
    );
    this.name = 'LlmPrivacyBlockedError';
  }
}

export interface ShieldedLlmCall {
  readonly request: LlmCompleteRequest;
  readonly restore: (result: LlmCompleteResult) => Promise<LlmCompleteResult>;
}

const identityRestore = (result: LlmCompleteResult): Promise<LlmCompleteResult> =>
  Promise.resolve(result);

async function maskWireText(
  privacy: PrivacyTurnHandle,
  callerAgentId: string,
  text: string,
): Promise<string> {
  const remasked =
    typeof privacy.remaskPromptValues === 'function' ? privacy.remaskPromptValues(text) : text;
  if (remasked.length === 0) return remasked;
  const outcome = await privacy.maskUserPrompt(remasked, { origin: 'context' });
  if (outcome.outcome === 'blocked') {
    throw new LlmPrivacyBlockedError(callerAgentId, outcome.reason);
  }
  return outcome.outcome === 'masked' ? outcome.maskedText : remasked;
}

async function restoreStrings(
  value: unknown,
  restore: (text: string) => Promise<string>,
): Promise<unknown> {
  if (typeof value === 'string') return restore(value);
  if (Array.isArray(value)) return Promise.all(value.map((item) => restoreStrings(item, restore)));
  if (value !== null && typeof value === 'object') {
    const entries = await Promise.all(
      Object.entries(value as Record<string, unknown>).map(
        async ([key, item]) => [key, await restoreStrings(item, restore)] as const,
      ),
    );
    return Object.fromEntries(entries);
  }
  return value;
}

/**
 * The request to send and the restore to apply to its answer. Identity when
 * `privacy` is absent.
 */
export async function shieldPluginLlmCall(
  privacy: PrivacyTurnHandle | undefined,
  callerAgentId: string,
  request: LlmCompleteRequest,
): Promise<ShieldedLlmCall> {
  if (privacy === undefined) return { request, restore: identityRestore };

  const system =
    request.system !== undefined
      ? await maskWireText(privacy, callerAgentId, request.system)
      : undefined;
  const messages = [];
  for (const message of request.messages) {
    messages.push({
      ...message,
      content: await maskWireText(privacy, callerAgentId, message.content),
    });
  }
  const masked: LlmCompleteRequest = {
    ...request,
    ...(system !== undefined ? { system } : {}),
    messages,
  };

  const restoreText = (text: string): Promise<string> => privacy.restorePromptPseudonyms(text);
  const restore = async (result: LlmCompleteResult): Promise<LlmCompleteResult> => {
    const text = await restoreText(result.text);
    if (result.toolCalls === undefined) return { ...result, text };
    const toolCalls = await Promise.all(
      result.toolCalls.map(async (call) => ({
        ...call,
        input: (await restoreStrings(call.input, restoreText)) as typeof call.input,
      })),
    );
    return { ...result, text, toolCalls };
  };
  return { request: masked, restore };
}
