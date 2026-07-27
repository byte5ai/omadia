/**
 * Issue #474 — a plugin whose `ctx.tools.register()`-contributed tools are
 * gated by `isPluginToolsReady` must be (a) excluded from the tool list
 * offered to the model, and (b) refused at dispatch time even if a call for
 * it arrives anyway (the race the list-only check would miss).
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import type { ChatStreamEvent } from '@omadia/channel-sdk';
import { adaptManifestV1 } from '../../src/plugins/manifestLoader.js';
import type { PluginCatalogEntry } from '../../src/plugins/manifestLoader.js';
import { PluginStatusRegistry } from '../../src/platform/pluginStatusRegistry.js';
import { OAuthReadinessTracker } from '../../src/plugins/oauth/oauthReadinessTracker.js';
import { writeStoredTokens } from '../../src/plugins/oauth/tokenStore.js';
import type { SecretVault } from '../../src/secrets/vault.js';
import {
  createDomainTool,
  NativeToolRegistry,
  Orchestrator,
} from '@omadia/orchestrator';

interface ScriptedStream {
  events: LlmStreamEvent[];
}

const providerCapabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

/** Records the `tools` array of every request it receives, then plays back
 *  the scripted streams in order. */
function fakeStreamProvider(
  streams: ScriptedStream[],
  seenRequests: LlmRequest[],
): LlmProvider {
  let idx = 0;
  const provider = {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: async (): Promise<LlmResponse> => {
      throw new Error('fakeStreamProvider: complete() not scripted');
    },
    stream: (req: LlmRequest): AsyncIterable<LlmStreamEvent> => {
      seenRequests.push(req);
      if (idx >= streams.length) {
        throw new Error(
          `fakeStreamProvider: no scripted stream for call ${String(idx + 1)}`,
        );
      }
      const fake = streams[idx]!;
      idx += 1;
      return {
        async *[Symbol.asyncIterator]() {
          for (const ev of fake.events) yield ev;
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  };
  return provider as unknown as LlmProvider;
}

function streamWithTools(
  toolUses: Array<{ id: string; name: string; input: unknown }>,
): ScriptedStream {
  const events: LlmStreamEvent[] = [];
  toolUses.forEach((u) => {
    events.push(
      { type: 'tool_use_start' },
      { type: 'tool_input_delta', text: JSON.stringify(u.input) },
    );
  });
  events.push({
    type: 'final',
    response: {
      content: toolUses.map((u) => ({
        type: 'tool_call',
        id: u.id,
        name: u.name,
        input: u.input,
      })),
      finishReason: 'tool_calls',
      providerFinishReason: 'tool_use',
      model: 'test',
      usage: {
        inputTokens: 50,
        outputTokens: 4,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
  });
  return { events };
}

const finalTextStream: ScriptedStream = {
  events: [
    { type: 'text_delta', text: 'done' },
    {
      type: 'final',
      response: {
        content: [{ type: 'text', text: 'done' }],
        finishReason: 'stop',
        providerFinishReason: 'end_turn',
        model: 'test',
        usage: {
          inputTokens: 100,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
    },
  ],
};

const minimalSpec = (name: string): Record<string, unknown> => ({
  name,
  description: `${name} for testing`,
  input_schema: { type: 'object' as const, properties: {}, required: [] },
});

describe('Orchestrator — issue #474 plugin tool-readiness gate', () => {
  it('excludes a not-ready plugin tool from the offered tool list, keeps a ready one', async () => {
    const registry = new NativeToolRegistry();
    registry.register('ready_tool', {
      handler: async () => 'ready-output',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: minimalSpec('ready_tool') as any,
      agentId: 'ready-plugin',
    });
    registry.register('gated_tool', {
      handler: async () => 'gated-output',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: minimalSpec('gated_tool') as any,
      agentId: 'gated-plugin',
    });

    const seenRequests: LlmRequest[] = [];
    const provider = fakeStreamProvider([finalTextStream], seenRequests);
    const orchestrator = new Orchestrator({
      provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 5,
      domainTools: [],
      nativeToolRegistry: registry,
      isPluginToolsReady: (agentId) => agentId !== 'gated-plugin',
    });

    for await (const _ev of orchestrator.chatStream({ userMessage: 'go' })) {
      // drain
    }

    const offered = (seenRequests[0]?.tools ?? []).map((t) => t.name);
    assert.ok(
      offered.includes('ready_tool'),
      `expected ready_tool in offered tools, got ${JSON.stringify(offered)}`,
    );
    assert.ok(
      !offered.includes('gated_tool'),
      `expected gated_tool to be excluded, got ${JSON.stringify(offered)}`,
    );
  });

  it('still offers every tool when isPluginToolsReady is not wired (pre-#474 behaviour)', async () => {
    const registry = new NativeToolRegistry();
    registry.register('plain_tool', {
      handler: async () => 'ok',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: minimalSpec('plain_tool') as any,
      agentId: 'some-plugin',
    });

    const seenRequests: LlmRequest[] = [];
    const provider = fakeStreamProvider([finalTextStream], seenRequests);
    const orchestrator = new Orchestrator({
      provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 5,
      domainTools: [],
      nativeToolRegistry: registry,
    });

    for await (const _ev of orchestrator.chatStream({ userMessage: 'go' })) {
      // drain
    }

    const offered = (seenRequests[0]?.tools ?? []).map((t) => t.name);
    assert.ok(offered.includes('plain_tool'));
  });

  it('refuses to invoke a not-ready plugin tool even if a call for it arrives (dispatch-time re-check)', async () => {
    const registry = new NativeToolRegistry();
    let handlerCalled = false;
    registry.register('gated_tool', {
      handler: async () => {
        handlerCalled = true;
        return 'should never run';
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: minimalSpec('gated_tool') as any,
      agentId: 'gated-plugin',
    });

    const stream0 = streamWithTools([
      { id: 'use-1', name: 'gated_tool', input: {} },
    ]);
    const seenRequests: LlmRequest[] = [];
    const provider = fakeStreamProvider([stream0, finalTextStream], seenRequests);
    const orchestrator = new Orchestrator({
      provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 5,
      domainTools: [],
      nativeToolRegistry: registry,
      isPluginToolsReady: () => false,
    });

    const events: ChatStreamEvent[] = [];
    for await (const ev of orchestrator.chatStream({ userMessage: 'go' })) {
      events.push(ev);
    }

    assert.equal(handlerCalled, false, 'the gated handler must never run');
    const result = events.find(
      (e) => e.type === 'tool_result' && e.id === 'use-1',
    );
    assert.ok(result, 'expected a tool_result for the gated call');
    assert.ok(
      result?.type === 'tool_result' &&
        result.isError === true &&
        /Error:/.test(result.output),
      `expected an Error: result, got ${JSON.stringify(result)}`,
    );
  });

  it('excludes a not-ready plugin tool promptDoc from the system prompt, keeps a ready one', async () => {
    const registry = new NativeToolRegistry();
    registry.register('ready_tool', {
      handler: async () => 'ready-output',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: minimalSpec('ready_tool') as any,
      agentId: 'ready-plugin',
      promptDoc: 'READY_TOOL_PROMPT_DOC_MARKER',
    });
    registry.register('gated_tool', {
      handler: async () => 'gated-output',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: minimalSpec('gated_tool') as any,
      agentId: 'gated-plugin',
      promptDoc: 'GATED_TOOL_PROMPT_DOC_MARKER',
    });

    const seenRequests: LlmRequest[] = [];
    const provider = fakeStreamProvider([finalTextStream], seenRequests);
    const orchestrator = new Orchestrator({
      provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 5,
      domainTools: [],
      nativeToolRegistry: registry,
      isPluginToolsReady: (agentId) => agentId !== 'gated-plugin',
    });

    for await (const _ev of orchestrator.chatStream({ userMessage: 'go' })) {
      // drain
    }

    const system = seenRequests[0]?.system;
    const systemText = typeof system === 'string' ? system : JSON.stringify(system);
    assert.ok(
      systemText?.includes('READY_TOOL_PROMPT_DOC_MARKER'),
      'expected the ready plugin promptDoc in the system prompt',
    );
    assert.ok(
      !systemText?.includes('GATED_TOOL_PROMPT_DOC_MARKER'),
      'expected the gated plugin promptDoc to be excluded from the system prompt',
    );
  });
});

/**
 * Issue #474 follow-up — the same readiness gate applies to the *second*
 * tool-registration path: DomainTools contributed by dynamic agent plugins
 * (`domainToolsByName`), as distinct from native tools registered via
 * `ctx.tools.register()`. Both paths carry an `agentId` and must be gated
 * identically, otherwise a not-ready plugin's domain tool (e.g.
 * `query_<slug>`) stays offered and invocable even though its native tools
 * are already hidden.
 */
describe('Orchestrator — issue #474 plugin tool-readiness gate (domain tools)', () => {
  const makeDomainTool = (
    name: string,
    agentId: string,
    onCall: () => void,
  ) =>
    createDomainTool({
      name,
      description: `${name} for testing`,
      domain: 'test.domain',
      agentId,
      agent: {
        ask: async (): Promise<string> => {
          onCall();
          return `${name}-output`;
        },
      },
    });

  it('excludes a not-ready plugin domain tool from the offered tool list, keeps a ready one', async () => {
    const readyTool = makeDomainTool('query_ready', 'ready-plugin', () => {});
    const gatedTool = makeDomainTool('query_gated', 'gated-plugin', () => {});

    const seenRequests: LlmRequest[] = [];
    const provider = fakeStreamProvider([finalTextStream], seenRequests);
    const orchestrator = new Orchestrator({
      provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 5,
      domainTools: [readyTool, gatedTool],
      nativeToolRegistry: new NativeToolRegistry(),
      isPluginToolsReady: (agentId) => agentId !== 'gated-plugin',
    });

    for await (const _ev of orchestrator.chatStream({ userMessage: 'go' })) {
      // drain
    }

    const offered = (seenRequests[0]?.tools ?? []).map((t) => t.name);
    assert.ok(
      offered.includes('query_ready'),
      `expected query_ready in offered tools, got ${JSON.stringify(offered)}`,
    );
    assert.ok(
      !offered.includes('query_gated'),
      `expected query_gated to be excluded, got ${JSON.stringify(offered)}`,
    );
  });

  it('still offers every domain tool when isPluginToolsReady is not wired (pre-#474 behaviour)', async () => {
    const plainTool = makeDomainTool('query_plain', 'some-plugin', () => {});

    const seenRequests: LlmRequest[] = [];
    const provider = fakeStreamProvider([finalTextStream], seenRequests);
    const orchestrator = new Orchestrator({
      provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 5,
      domainTools: [plainTool],
      nativeToolRegistry: new NativeToolRegistry(),
    });

    for await (const _ev of orchestrator.chatStream({ userMessage: 'go' })) {
      // drain
    }

    const offered = (seenRequests[0]?.tools ?? []).map((t) => t.name);
    assert.ok(offered.includes('query_plain'));
  });

  it('refuses to invoke a not-ready plugin domain tool even if a call for it arrives (dispatch-time re-check)', async () => {
    let handlerCalled = false;
    const gatedTool = makeDomainTool('query_gated', 'gated-plugin', () => {
      handlerCalled = true;
    });

    const stream0 = streamWithTools([
      { id: 'use-1', name: 'query_gated', input: { question: 'hi' } },
    ]);
    const seenRequests: LlmRequest[] = [];
    const provider = fakeStreamProvider([stream0, finalTextStream], seenRequests);
    const orchestrator = new Orchestrator({
      provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 5,
      domainTools: [gatedTool],
      nativeToolRegistry: new NativeToolRegistry(),
      isPluginToolsReady: () => false,
    });

    const events: ChatStreamEvent[] = [];
    for await (const ev of orchestrator.chatStream({ userMessage: 'go' })) {
      events.push(ev);
    }

    assert.equal(handlerCalled, false, 'the gated domain tool must never run');
    const result = events.find(
      (e) => e.type === 'tool_result' && e.id === 'use-1',
    );
    assert.ok(result, 'expected a tool_result for the gated call');
    assert.ok(
      result?.type === 'tool_result' &&
        result.isError === true &&
        /Error:/.test(result.output),
      `expected an Error: result, got ${JSON.stringify(result)}`,
    );
  });

  it('round-3 fix: excludes a not-ready plugin domain tool from the Fach-Agenten roster in the system prompt, keeps a ready one', async () => {
    const readyTool = makeDomainTool(
      'query_ready',
      'ready-plugin',
      () => {},
    );
    const gatedTool = makeDomainTool(
      'query_gated',
      'gated-plugin',
      () => {},
    );

    const seenRequests: LlmRequest[] = [];
    const provider = fakeStreamProvider([finalTextStream], seenRequests);
    const orchestrator = new Orchestrator({
      provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 5,
      domainTools: [readyTool, gatedTool],
      nativeToolRegistry: new NativeToolRegistry(),
      isPluginToolsReady: (agentId) => agentId !== 'gated-plugin',
    });

    for await (const _ev of orchestrator.chatStream({ userMessage: 'go' })) {
      // drain
    }

    const system = seenRequests[0]?.system;
    const systemText =
      typeof system === 'string' ? system : JSON.stringify(system);
    assert.ok(
      systemText?.includes('query_ready'),
      'expected the ready domain tool in the Fach-Agenten roster',
    );
    assert.ok(
      !systemText?.includes('query_gated'),
      'expected the gated domain tool to be excluded from the Fach-Agenten roster',
    );
  });
});

/**
 * Issue #474 review round 5 — the generic install/Connect flow never calls
 * `ctx.status.report(...)` on the plugin's behalf: `installService.ts`
 * activates a `type:'oauth'` plugin (registering its tools) BEFORE the
 * operator has completed the Connect flow. This block proves the automatic
 * OAuth-connection signal (`OAuthReadinessTracker`) gates the orchestrator's
 * tool list and dispatch by itself, with NO `ctx.status.report(...)` call
 * anywhere in the test — mirroring the explicit-report tests above but
 * exercising only the new automatic path — and that composing it with
 * `PluginStatusRegistry` (as `index.ts` wires the real gate) is a true AND:
 * either signal alone can withhold readiness.
 */
class FakeVault implements SecretVault {
  readonly store = new Map<string, string>();
  async get(agentId: string, key: string): Promise<string | undefined> {
    return this.store.get(`${agentId}::${key}`);
  }
  async set(agentId: string, key: string, value: string): Promise<void> {
    this.store.set(`${agentId}::${key}`, value);
  }
  async setMany(agentId: string, entries: Record<string, string>): Promise<void> {
    for (const [k, v] of Object.entries(entries)) await this.set(agentId, k, v);
  }
  async listKeys(): Promise<string[]> {
    return [];
  }
  async purge(): Promise<void> {}
  async deleteKey(agentId: string, key: string): Promise<void> {
    this.store.delete(`${agentId}::${key}`);
  }
}

function oauthPluginEntry(pluginId: string): PluginCatalogEntry {
  const plugin = adaptManifestV1({
    schema_version: '1',
    identity: {
      id: pluginId,
      kind: 'tool',
      domain: 'test',
      name: 'OAuth Tool Plugin',
      version: '0.1.0',
    },
    setup: {
      fields: [
        { key: 'connection', type: 'oauth', label: 'Connect', provider: 'github' },
      ],
    },
  })!;
  return { plugin, manifest: {}, source_path: '/dev/null', source_kind: 'manifest-v1' };
}

describe('Orchestrator — issue #474 round 5: automatic OAuth-connection signal', () => {
  it('excludes an installed-but-not-connected oauth plugin tool from the offered tool list — no ctx.status.report() involved', async () => {
    const oauthTracker = new OAuthReadinessTracker();
    const vault = new FakeVault();
    // The concrete repro: activate() ran (tools registered) but Connect was
    // never completed, so the vault has no tokens for the declared field.
    await oauthTracker.refresh('gated-plugin', oauthPluginEntry('gated-plugin'), vault);

    const registry = new NativeToolRegistry();
    registry.register('ready_tool', {
      handler: async () => 'ready-output',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: minimalSpec('ready_tool') as any,
      agentId: 'ready-plugin',
    });
    registry.register('github_search', {
      handler: async () => 'gated-output',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: minimalSpec('github_search') as any,
      agentId: 'gated-plugin',
    });

    const seenRequests: LlmRequest[] = [];
    const provider = fakeStreamProvider([finalTextStream], seenRequests);
    const orchestrator = new Orchestrator({
      provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 5,
      domainTools: [],
      nativeToolRegistry: registry,
      // Composed exactly like index.ts's `installedPluginToolsReadyReader` —
      // but pluginStatusRegistry never received a report() call for either
      // plugin, so readiness here comes ENTIRELY from oauthTracker.
      isPluginToolsReady: (agentId) => oauthTracker.isConnected(agentId),
    });

    for await (const _ev of orchestrator.chatStream({ userMessage: 'go' })) {
      // drain
    }

    const offered = (seenRequests[0]?.tools ?? []).map((t) => t.name);
    assert.ok(
      offered.includes('ready_tool'),
      `expected ready_tool in offered tools, got ${JSON.stringify(offered)}`,
    );
    assert.ok(
      !offered.includes('github_search'),
      `expected github_search to be excluded (not connected), got ${JSON.stringify(offered)}`,
    );
  });

  it('refuses to invoke an installed-but-not-connected oauth plugin tool even if a call for it arrives', async () => {
    const oauthTracker = new OAuthReadinessTracker();
    const vault = new FakeVault();
    await oauthTracker.refresh('gated-plugin', oauthPluginEntry('gated-plugin'), vault);

    const registry = new NativeToolRegistry();
    let handlerCalled = false;
    registry.register('github_search', {
      handler: async () => {
        handlerCalled = true;
        return 'should never run';
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: minimalSpec('github_search') as any,
      agentId: 'gated-plugin',
    });

    const stream0 = streamWithTools([
      { id: 'use-1', name: 'github_search', input: {} },
    ]);
    const seenRequests: LlmRequest[] = [];
    const provider = fakeStreamProvider([stream0, finalTextStream], seenRequests);
    const orchestrator = new Orchestrator({
      provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 5,
      domainTools: [],
      nativeToolRegistry: registry,
      isPluginToolsReady: (agentId) => oauthTracker.isConnected(agentId),
    });

    const events: ChatStreamEvent[] = [];
    for await (const ev of orchestrator.chatStream({ userMessage: 'go' })) {
      events.push(ev);
    }

    assert.equal(handlerCalled, false, 'the not-connected oauth tool must never run');
    const result = events.find(
      (e) => e.type === 'tool_result' && e.id === 'use-1',
    );
    assert.ok(result, 'expected a tool_result for the gated call');
    assert.ok(
      result?.type === 'tool_result' &&
        result.isError === true &&
        /Error:/.test(result.output),
      `expected an Error: result, got ${JSON.stringify(result)}`,
    );
  });

  it('becomes ready again once the oauth field connects — an explicit ctx.status.report() is not required', async () => {
    const oauthTracker = new OAuthReadinessTracker();
    const vault = new FakeVault();
    const entry = oauthPluginEntry('reconnected-plugin');
    // First activation: not connected yet.
    await oauthTracker.refresh('reconnected-plugin', entry, vault);
    assert.equal(oauthTracker.isConnected('reconnected-plugin'), false);

    // Connect flow completes (brokerService.callback → writeStoredTokens),
    // then reactivate() re-runs activate() → refresh() picks it up.
    await writeStoredTokens(vault, 'reconnected-plugin', 'connection', {
      accessToken: 'tok',
      refreshToken: '',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      scope: '',
    });
    await oauthTracker.refresh('reconnected-plugin', entry, vault);

    const registry = new NativeToolRegistry();
    registry.register('github_search', {
      handler: async () => 'now-connected-output',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: minimalSpec('github_search') as any,
      agentId: 'reconnected-plugin',
    });

    const seenRequests: LlmRequest[] = [];
    const provider = fakeStreamProvider([finalTextStream], seenRequests);
    const orchestrator = new Orchestrator({
      provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 5,
      domainTools: [],
      nativeToolRegistry: registry,
      isPluginToolsReady: (agentId) => oauthTracker.isConnected(agentId),
    });

    for await (const _ev of orchestrator.chatStream({ userMessage: 'go' })) {
      // drain
    }

    const offered = (seenRequests[0]?.tools ?? []).map((t) => t.name);
    assert.ok(
      offered.includes('github_search'),
      `expected github_search back in offered tools once connected, got ${JSON.stringify(offered)}`,
    );
  });

  it('composed gate (as wired in index.ts) is a true AND — either signal alone withholds readiness', async () => {
    const statusRegistry = new PluginStatusRegistry();
    const oauthTracker = new OAuthReadinessTracker();
    const vault = new FakeVault();
    const isReady = (agentId: string): boolean =>
      statusRegistry.isReady(agentId) && oauthTracker.isConnected(agentId);

    // Neither signal reported anything — ready by default (most plugins).
    assert.equal(isReady('plain-plugin'), true);

    // Explicit report says needs_action; oauth signal never touched (no
    // oauth field on this plugin) — must stay not-ready.
    statusRegistry.set('explicit-only', {
      state: 'needs_action',
      title: 'Nicht verbunden',
    });
    assert.equal(isReady('explicit-only'), false);

    // Explicit report says OK, but the automatic oauth signal says
    // not-connected — the explicit 'ok' must NOT hide the real oauth gap.
    statusRegistry.set('explicit-ok-oauth-pending', { state: 'ok' });
    await oauthTracker.refresh(
      'explicit-ok-oauth-pending',
      oauthPluginEntry('explicit-ok-oauth-pending'),
      vault,
    );
    assert.equal(isReady('explicit-ok-oauth-pending'), false);

    // Connect the oauth field — both signals now agree ready.
    await writeStoredTokens(vault, 'explicit-ok-oauth-pending', 'connection', {
      accessToken: 'tok',
      refreshToken: '',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      scope: '',
    });
    await oauthTracker.refresh(
      'explicit-ok-oauth-pending',
      oauthPluginEntry('explicit-ok-oauth-pending'),
      vault,
    );
    assert.equal(isReady('explicit-ok-oauth-pending'), true);
  });
});

/**
 * Issue #474 review round 8 — `NativeToolRegistry.registerHandler()` (the
 * handler-only path used for tools whose spec the kernel emits itself, e.g.
 * the Anthropic-native `memory` tool that `harness-memory` /
 * `harness-memory-postgres` register via `ctx.tools.registerHandler()`)
 * never stored an `agentId` on its entry, so the `agentId === undefined ⇒
 * always-available` default meant for genuinely kernel-internal
 * registrations silently applied to ANY plugin using this path instead of
 * `register()`. Mirrors the `register()` gate tests above, but exercises
 * `registerHandler()` specifically.
 */
describe('Orchestrator — issue #474 round 8: registerHandler() readiness gate', () => {
  it('excludes a not-ready plugin registerHandler() tool promptDoc from the system prompt, keeps a ready one', async () => {
    const registry = new NativeToolRegistry();
    registry.registerHandler('ready_handler_tool', {
      handler: async () => 'ready-output',
      agentId: 'ready-plugin',
      promptDoc: 'READY_HANDLER_TOOL_PROMPT_DOC_MARKER',
    });
    registry.registerHandler('gated_handler_tool', {
      handler: async () => 'gated-output',
      agentId: 'gated-plugin',
      promptDoc: 'GATED_HANDLER_TOOL_PROMPT_DOC_MARKER',
    });

    const seenRequests: LlmRequest[] = [];
    const provider = fakeStreamProvider([finalTextStream], seenRequests);
    const orchestrator = new Orchestrator({
      provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 5,
      domainTools: [],
      nativeToolRegistry: registry,
      isPluginToolsReady: (agentId) => agentId !== 'gated-plugin',
    });

    for await (const _ev of orchestrator.chatStream({ userMessage: 'go' })) {
      // drain
    }

    const system = seenRequests[0]?.system;
    const systemText = typeof system === 'string' ? system : JSON.stringify(system);
    assert.ok(
      systemText?.includes('READY_HANDLER_TOOL_PROMPT_DOC_MARKER'),
      'expected the ready plugin registerHandler() promptDoc in the system prompt',
    );
    assert.ok(
      !systemText?.includes('GATED_HANDLER_TOOL_PROMPT_DOC_MARKER'),
      'expected the gated plugin registerHandler() promptDoc to be excluded from the system prompt',
    );
  });

  it('refuses to invoke a not-ready plugin registerHandler() tool even if a call for it arrives (dispatch-time re-check)', async () => {
    const registry = new NativeToolRegistry();
    let handlerCalled = false;
    registry.registerHandler('gated_handler_tool', {
      handler: async () => {
        handlerCalled = true;
        return 'should never run';
      },
      agentId: 'gated-plugin',
    });

    const stream0 = streamWithTools([
      { id: 'use-1', name: 'gated_handler_tool', input: {} },
    ]);
    const seenRequests: LlmRequest[] = [];
    const provider = fakeStreamProvider([stream0, finalTextStream], seenRequests);
    const orchestrator = new Orchestrator({
      provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 5,
      domainTools: [],
      nativeToolRegistry: registry,
      isPluginToolsReady: () => false,
    });

    const events: ChatStreamEvent[] = [];
    for await (const ev of orchestrator.chatStream({ userMessage: 'go' })) {
      events.push(ev);
    }

    assert.equal(handlerCalled, false, 'the gated registerHandler() handler must never run');
    const result = events.find(
      (e) => e.type === 'tool_result' && e.id === 'use-1',
    );
    assert.ok(result, 'expected a tool_result for the gated call');
    assert.ok(
      result?.type === 'tool_result' &&
        result.isError === true &&
        /Error:/.test(result.output),
      `expected an Error: result, got ${JSON.stringify(result)}`,
    );
  });

  it('a kernel-internal registerHandler() call (no agentId) stays always-available regardless of isPluginToolsReady', async () => {
    const registry = new NativeToolRegistry();
    let handlerCalled = false;
    // No `agentId` — the genuinely kernel-internal convention `register()`
    // already follows for marker-only entries.
    registry.registerHandler('kernel_internal_handler_tool', {
      handler: async () => {
        handlerCalled = true;
        return 'kernel-output';
      },
      promptDoc: 'KERNEL_INTERNAL_HANDLER_TOOL_PROMPT_DOC_MARKER',
    });

    const stream0 = streamWithTools([
      { id: 'use-1', name: 'kernel_internal_handler_tool', input: {} },
    ]);
    const seenRequests: LlmRequest[] = [];
    const provider = fakeStreamProvider([stream0, finalTextStream], seenRequests);
    const orchestrator = new Orchestrator({
      provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 5,
      domainTools: [],
      nativeToolRegistry: registry,
      // Would gate every plugin-owned tool — must NOT affect this
      // agentId-less, kernel-internal entry.
      isPluginToolsReady: () => false,
    });

    const events: ChatStreamEvent[] = [];
    for await (const ev of orchestrator.chatStream({ userMessage: 'go' })) {
      events.push(ev);
    }

    assert.equal(handlerCalled, true, 'the kernel-internal handler must still run');
    const result = events.find(
      (e) => e.type === 'tool_result' && e.id === 'use-1',
    );
    assert.ok(result, 'expected a tool_result for the kernel-internal call');
    assert.ok(
      result?.type === 'tool_result' && result.isError !== true,
      `expected a successful result, got ${JSON.stringify(result)}`,
    );

    const system = seenRequests[0]?.system;
    const systemText = typeof system === 'string' ? system : JSON.stringify(system);
    assert.ok(
      systemText?.includes('KERNEL_INTERNAL_HANDLER_TOOL_PROMPT_DOC_MARKER'),
      'expected the kernel-internal registerHandler() promptDoc in the system prompt',
    );
  });
});
