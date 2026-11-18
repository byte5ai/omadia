import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { LlmProvider, LlmResponse } from '@omadia/llm-provider';
import type {
  PrivacyGuardService,
  PrivacyToolErrorRequest,
} from '@omadia/plugin-api';
import { NativeToolRegistry, Orchestrator } from '@omadia/orchestrator';

/**
 * The chat path's handling of a THROWN tool exception.
 *
 * A handler exception is not sanitized text: an ORM echoes the failing row, a
 * driver echoes the bound parameters. This path used to fold the rejection into
 * `Error: ${err.message}` and hand it to the model — past the Privacy Shield,
 * which only ever sees what a tool RETURNS — so a driver error quoting a row put
 * that row on the provider wire, into the streamed `tool_result` event and into
 * the persisted session.
 *
 * This file is the fence around the fix. It drives the REAL `Orchestrator`
 * through the REAL `privacyGuard` seam (`runTurn` mints its own per-turn handle
 * from it) and asserts: the model gets a withheld notice — class name,
 * sanitised code, a log reference — never the message; the full error goes to
 * the server log under that same reference; the turn's receipt records the
 * withheld error. Without a privacy provider the raw message still flows, the
 * same parity every other tool result has on an unshielded deployment.
 *
 * Mutation-check discipline: every assertion reads the tool_result CONTENT the
 * orchestrator handed to the model (or the log/receipt), never a call count.
 * All values are synthetic.
 */

const EMAIL = 'erika.mustermann@example.com';
const PII_ERROR = `Fault: Invalid field 'x' on record {"email":"${EMAIL}"}`;
const PII_RESULT = `{"email":"${EMAIL}"}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const usage = {
  inputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
} as const;

function toolCallResponse(name: string): LlmResponse {
  return {
    content: [{ type: 'tool_call', id: 'use-1', name, input: {} }],
    finishReason: 'tool_calls',
    providerFinishReason: 'tool_use',
    model: 'test',
    usage,
  } as unknown as LlmResponse;
}

function textResponse(text: string): LlmResponse {
  return {
    content: [{ type: 'text', text }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model: 'test',
    usage,
  } as unknown as LlmResponse;
}

/** Records every message list handed to the provider, so the tool_result the
 *  model would have seen can be inspected directly. */
function recordingProvider(responses: readonly LlmResponse[]): {
  provider: LlmProvider;
  seen: unknown[][];
} {
  const seen: unknown[][] = [];
  let idx = 0;
  const provider = {
    id: 'anthropic',
    capabilities: {
      tools: true,
      vision: true,
      streaming: true,
      promptCaching: true,
      forcedToolChoice: true,
      parallelToolCalls: true,
    },
    complete: (request: { messages?: unknown[] }) => {
      seen.push(request.messages ?? []);
      const response = responses[idx];
      idx += 1;
      if (!response) throw new Error('recordingProvider: no scripted response left');
      return Promise.resolve(response);
    },
    stream: () => {
      throw new Error('not used');
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  };
  return { provider: provider as unknown as LlmProvider, seen };
}

/**
 * The REAL `privacyGuard` seam the orchestrator builds its per-turn handle from
 * — not a handle injected into `turnContext`, which `runTurn` would overwrite
 * with its own. Interns for real (so "masking ran" is observable as a missing
 * raw string) and records every tool-error entry it is handed.
 */
function maskingPrivacyService(recorded: PrivacyToolErrorRequest[]): PrivacyGuardService {
  return {
    async internToolResultV4(request: { toolName: string; rawResult: string }) {
      return {
        digestText: `«dataset:${request.toolName}» ${request.rawResult.replaceAll(EMAIL, '[masked:email]')}`,
        datasetId: `ds-${request.toolName}`,
      };
    },
    async recordBypassedTool() {},
    async recordToolError(request: PrivacyToolErrorRequest) {
      recorded.push(request);
    },
    async redactToolErrorText({ text }: { text: string }) {
      return {
        outcome: 'redacted' as const,
        text: text.replaceAll(EMAIL, '[masked:email]'),
        spans: [],
        degraded: false,
      };
    },
    async runV4Tool() {
      return { resultText: '' };
    },
    async subAgentResultV4() {
      return { resultText: '' };
    },
    async takeRenderedAnswerV4() {
      return undefined;
    },
    v4ToolSpecs() {
      return [];
    },
    async finalizeTurn() {
      return undefined;
    },
  } as unknown as PrivacyGuardService;
}

function registryWith(name: string, behaviour: () => Promise<string>): NativeToolRegistry {
  const registry = new NativeToolRegistry();
  registry.register(name, {
    handler: behaviour,
    spec: {
      name,
      description: 'test tool',
      input_schema: { type: 'object' as const, properties: {}, required: [] },
    } as never,
    domain: 'test.pii',
  });
  return registry;
}

interface ResultBlock {
  readonly content: string;
  readonly isError: boolean;
}

function toolResultBlocks(messages: readonly unknown[][]): ResultBlock[] {
  const out: ResultBlock[] = [];
  for (const list of messages) {
    for (const message of list) {
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const b = block as {
          type?: string;
          content?: unknown;
          isError?: boolean;
          is_error?: boolean;
        };
        if (b.type === 'tool_result' && typeof b.content === 'string') {
          out.push({ content: b.content, isError: b.isError === true || b.is_error === true });
        }
      }
    }
  }
  return out;
}

function orchestratorWith(
  provider: LlmProvider,
  registry: NativeToolRegistry,
  privacy: PrivacyGuardService | undefined,
): Orchestrator {
  return new Orchestrator({
    provider,
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: [],
    nativeToolRegistry: registry,
    // The production seam: `runTurn` mints its own per-turn handle from this
    // and threads it through `turnContext` itself.
    ...(privacy ? { privacyGuard: () => privacy } : {}),
  });
}

/** Every console.error call's arguments, captured for the diagnostics checks. */
let errorCalls: unknown[][] = [];
beforeEach(() => {
  errorCalls = [];
  mock.method(console, 'error', (...args: unknown[]) => {
    errorCalls.push(args);
  });
});
afterEach(() => {
  mock.restoreAll();
});

function thrownLogLine(): { ref: string; err: unknown } {
  for (const args of errorCalls) {
    const line = typeof args[0] === 'string' ? args[0] : '';
    const m = /tool threw \(ref=([^)]+)\)/.exec(line);
    if (m) return { ref: m[1]!, err: args[1] };
  }
  throw new Error(`no "tool threw" log line in ${JSON.stringify(errorCalls.map((a) => a[0]))}`);
}

describe('chat path — a thrown tool exception is withheld from the model', () => {
  it('hands the model a notice with class name and ref, never the message', async () => {
    const recorded: PrivacyToolErrorRequest[] = [];
    const { provider, seen } = recordingProvider([
      toolCallResponse('odoo_search_partner'),
      textResponse('done'),
    ]);
    const orchestrator = orchestratorWith(
      provider,
      registryWith('odoo_search_partner', () => {
        throw new Error(PII_ERROR);
      }),
      maskingPrivacyService(recorded),
    );

    await orchestrator.runTurn({ userMessage: 'go' });

    const results = toolResultBlocks(seen);
    assert.equal(results.length, 1, 'exactly one tool_result should have reached the model');
    const notice = results[0]!.content;
    assert.equal(notice.includes(EMAIL), false, `the exception text reached the model: ${notice}`);
    assert.equal(notice.includes('Invalid field'), false, 'no fragment of the message');
    assert.match(notice, /^Error: tool `odoo_search_partner` failed with Error \[ref /);
    assert.equal(results[0]!.isError, true, 'the notice still drives is_error');

    // The protected diagnostics channel: same ref, full error.
    const logged = thrownLogLine();
    assert.ok(notice.includes(`[ref ${logged.ref}]`), 'the notice ref is the ref in the log');
    assert.match(logged.ref, UUID, 'the ref is the turn correlation id');
    assert.ok(logged.err instanceof Error && logged.err.message === PII_ERROR, 'full error logged');

    // The receipt entry.
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.carrier, 'thrown');
    assert.equal(recorded[0]!.outcome, 'withheld');
    assert.equal(recorded[0]!.turnId, logged.ref, 'the receipt entry belongs to the same turn');
    assert.equal(recorded[0]!.bytes, Buffer.byteLength(PII_ERROR, 'utf8'));
  });

  it('keeps a sanitised driver code in the notice', async () => {
    const { provider, seen } = recordingProvider([
      toolCallResponse('query_rows'),
      textResponse('done'),
    ]);
    const orchestrator = orchestratorWith(
      provider,
      registryWith('query_rows', () => {
        throw Object.assign(new Error(`invalid input syntax for type uuid: "${EMAIL}"`), {
          name: 'DatabaseError',
          code: '22P02',
        });
      }),
      maskingPrivacyService([]),
    );

    await orchestrator.runTurn({ userMessage: 'go' });

    const notice = toolResultBlocks(seen)[0]?.content ?? '';
    assert.match(notice, /^Error: tool `query_rows` failed with DatabaseError \(code 22P02\) \[ref /);
    assert.equal(notice.includes(EMAIL), false);
  });

  it('withholds the message on the legacy no-deadline path too (dispatch timeout 0)', async () => {
    const previous = process.env['OMADIA_TOOL_DISPATCH_TIMEOUT_MS'];
    process.env['OMADIA_TOOL_DISPATCH_TIMEOUT_MS'] = '0';
    try {
      const { provider, seen } = recordingProvider([
        toolCallResponse('odoo_search_partner'),
        textResponse('done'),
      ]);
      const orchestrator = orchestratorWith(
        provider,
        registryWith('odoo_search_partner', () => Promise.reject(new Error(PII_ERROR))),
        maskingPrivacyService([]),
      );

      await orchestrator.runTurn({ userMessage: 'go' });

      const notice = toolResultBlocks(seen)[0]?.content ?? '';
      assert.equal(notice.includes(EMAIL), false, `raw text on the no-deadline path: ${notice}`);
      assert.match(notice, /^Error: tool `odoo_search_partner` failed with Error \[ref /);
    } finally {
      if (previous === undefined) delete process.env['OMADIA_TOOL_DISPATCH_TIMEOUT_MS'];
      else process.env['OMADIA_TOOL_DISPATCH_TIMEOUT_MS'] = previous;
    }
  });

  it('control — a successful PII result in the same configuration is still interned', async () => {
    // Without this, the tests above would also pass if the handle were simply
    // never consulted.
    const { provider, seen } = recordingProvider([
      toolCallResponse('odoo_read_partner'),
      textResponse('done'),
    ]);
    const orchestrator = orchestratorWith(
      provider,
      registryWith('odoo_read_partner', () => Promise.resolve(PII_RESULT)),
      maskingPrivacyService([]),
    );

    await orchestrator.runTurn({ userMessage: 'go' });

    const results = toolResultBlocks(seen);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.content.includes(EMAIL), false, 'the chat path must still mask RESULTS');
    assert.match(results[0]!.content, /\[masked:email\]/);
  });

  it('parity — without a privacy provider the raw message still reaches the model', async () => {
    // Nothing is masked on an unshielded deployment, tool results included;
    // withholding only the exception text there would protect nothing and cost
    // the operator the driver message.
    const { provider, seen } = recordingProvider([
      toolCallResponse('odoo_search_partner'),
      textResponse('done'),
    ]);
    const orchestrator = orchestratorWith(
      provider,
      registryWith('odoo_search_partner', () => {
        throw new Error(PII_ERROR);
      }),
      undefined,
    );

    await orchestrator.runTurn({ userMessage: 'go' });

    const results = toolResultBlocks(seen);
    assert.equal(results[0]?.content, `Error: ${PII_ERROR}`);
    assert.equal(results[0]?.isError, true);
    assert.match(thrownLogLine().ref, UUID, 'the throw is logged even without a shield');
  });
});
