/**
 * OpenAI Responses provider over raw fetch + SSE — the wire the ChatGPT/Codex
 * backend speaks for subscription OAuth bearers (#294, EXPERIMENTAL).
 *
 * Verified live against `https://chatgpt.com/backend-api/codex/responses`
 * (2026-08-21): requires `stream:true` + the `OpenAI-Beta: responses=
 * experimental`, `originator` and per-request `session_id` headers; supports
 * custom function tools, forced `tool_choice`, parallel tool calls and
 * `input_image` parts; `instructions` is optional. `store:false` is forced —
 * omadia never persists conversations server-side.
 *
 * No vendor SDK on purpose: the backend is not a public API surface, so an
 * SDK's param validation would fight it, and raw fetch keeps the npm-audit
 * surface at zero. The token can ROTATE mid-process, so the bearer is resolved
 * per request via `bearerProvider` — never captured at build time.
 */
import { randomUUID } from 'node:crypto';

import type {
  ContentPart,
  FinishReason,
  LlmErrorClassification,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
  LlmUsage,
  ToolChoice,
} from '@omadia/llm-provider-api';

import { SseParser } from './sse.js';

export interface OpenAiResponsesProviderOptions {
  /** e.g. `https://chatgpt.com/backend-api/codex` — `/responses` is appended. */
  readonly baseURL: string;
  /** Per-request bearer (OAuth path — preferred; may refresh/rotate). */
  readonly bearerProvider?: () => Promise<string>;
  /** Static fallback credential when no `bearerProvider` is set. */
  readonly apiKey?: string;
  readonly id?: string;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (...args: unknown[]) => void;
}

/** HTTP failure carrying the status for `classifyError`. */
export class ResponsesHttpError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`openai-responses: HTTP ${String(status)}: ${body.slice(0, 300)}`);
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function systemText(system: LlmRequest['system']): string | undefined {
  if (system === undefined) return undefined;
  if (typeof system === 'string') return system.length > 0 ? system : undefined;
  const text = system.map((b) => b.text).join('\n\n');
  return text.length > 0 ? text : undefined;
}

function toolResultText(
  content: string | ReadonlyArray<{ type: string; text?: string }>,
): string {
  if (typeof content === 'string') return content;
  const texts: string[] = [];
  for (const part of content) {
    if (part.type === 'text' && typeof part.text === 'string') {
      texts.push(part.text);
    } else {
      // Contract rule: never drop non-text tool results silently.
      throw new Error(
        'openai-responses: image tool results are not supported by the Responses wire mapping',
      );
    }
  }
  return texts.join('\n');
}

/** Neutral messages → Responses `input` items. */
function toInputItems(req: LlmRequest): unknown[] {
  const items: unknown[] = [];
  for (const message of req.messages) {
    const contentParts: unknown[] = [];
    const flush = (): void => {
      if (contentParts.length === 0) return;
      items.push({
        type: 'message',
        role: message.role,
        content: [...contentParts],
      });
      contentParts.length = 0;
    };
    for (const part of message.content) {
      switch (part.type) {
        case 'text':
          contentParts.push(
            message.role === 'assistant'
              ? { type: 'output_text', text: part.text }
              : { type: 'input_text', text: part.text },
          );
          break;
        case 'image':
          contentParts.push({
            type: 'input_image',
            image_url: `data:${part.mediaType};base64,${part.data}`,
          });
          break;
        case 'tool_call':
          // Function calls are top-level items, not message content.
          flush();
          items.push({
            type: 'function_call',
            call_id: part.id,
            name: part.name,
            arguments: JSON.stringify(part.input ?? {}),
          });
          break;
        case 'tool_result':
          flush();
          items.push({
            type: 'function_call_output',
            call_id: part.toolCallId,
            output: toolResultText(part.content),
          });
          break;
      }
    }
    flush();
  }
  return items;
}

function toToolChoice(choice: ToolChoice): unknown {
  switch (choice.type) {
    case 'auto':
      return 'auto';
    case 'none':
      return 'none';
    case 'required':
      return 'required';
    case 'tool':
      return { type: 'function', name: choice.name };
  }
}

function toRequestBody(req: LlmRequest): Record<string, unknown> {
  const instructions = systemText(req.system);
  const tools = (req.tools ?? [])
    // Server/built-in tools are vendor-owned schemas we cannot forward here.
    .filter((t) => t.serverType === undefined)
    .map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
      strict: false,
    }));
  const disableParallel =
    req.toolChoice !== undefined &&
    'disableParallel' in req.toolChoice &&
    req.toolChoice.disableParallel === true;
  return {
    model: req.model,
    ...(instructions !== undefined ? { instructions } : {}),
    input: toInputItems(req),
    max_output_tokens: req.maxTokens,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(req.toolChoice !== undefined
      ? { tool_choice: toToolChoice(req.toolChoice) }
      : {}),
    ...(disableParallel ? { parallel_tool_calls: false } : {}),
    // Backend contract: stream-only, and omadia never stores server-side.
    stream: true,
    store: false,
  };
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function toUsage(usage: unknown): LlmUsage {
  const u = asRecord(usage);
  return {
    inputTokens: num(u['input_tokens']) ?? 0,
    outputTokens: num(u['output_tokens']) ?? 0,
  };
}

function toFinalResponse(payload: unknown, fallbackModel: string): LlmResponse {
  const response = asRecord(asRecord(payload)['response']);
  const output = Array.isArray(response['output']) ? response['output'] : [];
  const content: ContentPart[] = [];
  let sawToolCall = false;
  for (const rawItem of output) {
    const item = asRecord(rawItem);
    const type = str(item['type']);
    if (type === 'message') {
      const parts = Array.isArray(item['content']) ? item['content'] : [];
      for (const rawPart of parts) {
        const part = asRecord(rawPart);
        if (str(part['type']) === 'output_text') {
          content.push({ type: 'text', text: String(part['text'] ?? '') });
        }
      }
    } else if (type === 'function_call') {
      sawToolCall = true;
      let input: unknown = {};
      const args = str(item['arguments']);
      if (args !== undefined) {
        try {
          input = JSON.parse(args);
        } catch {
          input = { __raw: args };
        }
      }
      content.push({
        type: 'tool_call',
        id: str(item['call_id']) ?? str(item['id']) ?? randomUUID(),
        name: str(item['name']) ?? 'unknown_tool',
        input,
      });
    }
    // reasoning / other item types: not part of the neutral contract.
  }
  const status = str(response['status']);
  const incompleteReason = str(asRecord(response['incomplete_details'])['reason']);
  const finishReason: FinishReason = sawToolCall
    ? 'tool_calls'
    : incompleteReason === 'max_output_tokens'
      ? 'max_tokens'
      : 'stop';
  return {
    content,
    finishReason,
    ...(status !== undefined
      ? { providerFinishReason: incompleteReason ?? status }
      : {}),
    model: str(response['model']) ?? fallbackModel,
    usage: toUsage(response['usage']),
  };
}

export function createOpenAiResponsesProvider(
  options: OpenAiResponsesProviderOptions,
): LlmProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.baseURL.replace(/\/+$/, '')}/responses`;

  async function bearer(): Promise<string> {
    if (options.bearerProvider) return options.bearerProvider();
    if (options.apiKey !== undefined && options.apiKey.length > 0) {
      return options.apiKey;
    }
    throw new Error('openai-responses: no credential configured');
  }

  async function* streamImpl(req: LlmRequest): AsyncGenerator<LlmStreamEvent> {
    const token = await bearer();
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        // Live-verified header set — without these the backend 4xxes.
        'openai-beta': 'responses=experimental',
        originator: 'codex_cli_rs',
        session_id: randomUUID(),
      },
      body: JSON.stringify(toRequestBody(req)),
    });
    if (!res.ok || res.body === null) {
      const body = await res.text().catch(() => '');
      throw new ResponsesHttpError(res.status, body);
    }

    const parser = new SseParser();
    const decoder = new TextDecoder();
    let finalEvent: LlmStreamEvent | undefined;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      for (const evt of parser.push(decoder.decode(chunk, { stream: true }))) {
        const payload = ((): unknown => {
          try {
            return JSON.parse(evt.data);
          } catch {
            return {};
          }
        })();
        const p = asRecord(payload);
        switch (evt.event) {
          case 'response.output_text.delta': {
            const delta = str(p['delta']);
            if (delta !== undefined) yield { type: 'text_delta', text: delta };
            break;
          }
          case 'response.output_item.added': {
            if (str(asRecord(p['item'])['type']) === 'function_call') {
              yield { type: 'tool_use_start' };
            }
            break;
          }
          case 'response.function_call_arguments.delta': {
            const delta = str(p['delta']);
            if (delta !== undefined) {
              yield { type: 'tool_input_delta', text: delta };
            }
            break;
          }
          case 'response.completed': {
            finalEvent = {
              type: 'final',
              response: toFinalResponse(payload, req.model),
            };
            break;
          }
          case 'response.failed':
          case 'error': {
            const message =
              str(asRecord(p['error'])['message']) ??
              str(asRecord(asRecord(p['response'])['error'])['message']) ??
              'stream reported failure';
            throw new Error(`openai-responses: ${message}`);
          }
          default:
            break; // created / in_progress / content_part.* / *.done — no-ops
        }
      }
    }
    if (finalEvent === undefined) {
      throw new Error('openai-responses: stream ended without response.completed');
    }
    yield finalEvent;
  }

  return {
    id: options.id ?? 'openai-responses',
    capabilities: {
      tools: true,
      vision: true,
      streaming: true,
      promptCaching: false,
      forcedToolChoice: true,
      parallelToolCalls: true,
      // One-or-the-other per completion has not been disproven live; stay
      // conservative so the orchestrator compensates with its post-turn pass.
      interleavedToolUse: false,
    },
    stream: (req: LlmRequest) => streamImpl(req),
    async complete(req: LlmRequest): Promise<LlmResponse> {
      for await (const evt of streamImpl(req)) {
        if (evt.type === 'final') return evt.response;
      }
      throw new Error('openai-responses: stream ended without a final event');
    },
    classifyError(err: unknown): LlmErrorClassification {
      if (err instanceof ResponsesHttpError) {
        if (err.status === 401 || err.status === 403) {
          return { retryable: false, kind: 'auth' };
        }
        if (err.status === 429) return { retryable: true, kind: 'rate_limit' };
        if (err.status >= 500) return { retryable: true, kind: 'overloaded' };
        return { retryable: false, kind: 'other' };
      }
      // A dead OAuth grant surfaces from the bearerProvider (token store).
      if (
        err instanceof Error &&
        err.name === 'OAuthReconnectRequiredError'
      ) {
        return { retryable: false, kind: 'auth' };
      }
      return { retryable: false, kind: 'other' };
    },
  };
}
