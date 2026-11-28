/**
 * #2338 / ADR-0299 — a tool's effect decided at activation
 * (`ToolRegistrationOptions.sideEffects`), and Diagrams' use of it: the
 * Kroki renderer counts as a reader inside the instance only when its
 * endpoint is internal, so `render_diagram` declares `none` only then.
 *
 * Walks the plugin-facing `ctx.tools.register` shim into the registry and the
 * orchestrator's tool-system lookup the integration egress reads.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { configFlag, isInternalKrokiEndpoint } from '../../packages/harness-diagrams/src/krokiEndpoint.js';
import { NativeToolRegistry } from '../../packages/harness-orchestrator/src/nativeToolRegistry.js';
import type { ToolSystem } from '../../packages/harness-orchestrator/src/discretion/toolFlow.js';
import { createPluginContext } from '../../src/platform/pluginContext.js';
import { ServiceRegistry } from '../../src/platform/serviceRegistry.js';
import { CREATE_INVOICE, text, verifiedTurn } from '../_helpers/replayTurnFixture.js';
import { approved } from '../_helpers/verifierVerdictFixtures.js';

type Opts = Parameters<typeof createPluginContext>[0];

function pluginContext(agentId: string, nativeTools: NativeToolRegistry) {
  const stub = (): (() => void) => (): void => {};
  return createPluginContext({
    agentId,
    vault: { get: async () => undefined, listKeys: async () => [] } as unknown as Opts['vault'],
    registry: { has: () => true, list: () => [], get: () => undefined } as unknown as Opts['registry'],
    catalog: new Map() as unknown as Opts['catalog'],
    serviceRegistry: new ServiceRegistry(),
    // src and dist each have a NativeToolRegistry class; the shim only calls its methods.
    nativeToolRegistry: nativeTools as unknown as Opts['nativeToolRegistry'],
    routeRegistry: { register: stub, disposeBySource: () => 0 } as unknown as Opts['routeRegistry'],
    jobScheduler: { register: stub, stopForPlugin: () => {} } as unknown as Opts['jobScheduler'],
    logger: () => {},
    // Only what `ctx.tools` touches; the rest of the options is irrelevant here.
  } as unknown as Opts);
}

const spec = (name: string) => ({ name, description: name, input_schema: { type: 'object' as const, properties: {} } });

describe('Kroki endpoint inside the instance (#2338, ADR-0299)', () => {
  it('internal by address: loopback, private ranges, Fly private network, private names', () => {
    for (const url of [
      'http://localhost:8000',
      'http://127.0.0.1:8000',
      'http://10.0.0.5',
      'http://172.20.1.1',
      'http://192.168.1.10',
      'http://[fdaa:6b:7409:0:1::3]:8000',
      'http://[::1]:8000',
      'http://odoo-bot-kroki.flycast:8000',
      'http://odoo-bot-kroki.internal:8000',
      'http://kroki:8000',
      'http://kroki.default.svc.cluster.local',
    ]) {
      assert.equal(isInternalKrokiEndpoint(url, false), true, url);
    }
  });

  it('a public host is internal only on the operator flag; kroki.io never', () => {
    assert.equal(isInternalKrokiEndpoint('https://kroki.example.com', false), false);
    assert.equal(isInternalKrokiEndpoint('https://kroki.example.com', true), true);
    assert.equal(isInternalKrokiEndpoint('https://kroki.io', true), false);
    assert.equal(isInternalKrokiEndpoint('https://eu.kroki.io', true), false);
    assert.equal(isInternalKrokiEndpoint('http://172.32.0.1', false), false, 'outside 172.16/12');
    assert.equal(isInternalKrokiEndpoint('not a url', true), false);
  });

  it('reads the boolean setup value in both shapes', () => {
    assert.equal(configFlag(true), true);
    assert.equal(configFlag('true'), true);
    assert.equal(configFlag('false'), false);
    assert.equal(configFlag(undefined), false);
  });
});

describe('effect declared at registration (#2338, ADR-0299)', () => {
  it('reaches the registry through the plugin-facing shim', () => {
    const nativeTools = new NativeToolRegistry();
    const ctx = pluginContext('@omadia/diagrams', nativeTools);
    ctx.tools.register(spec('render_diagram'), async () => 'ok', { sideEffects: 'none' });
    assert.equal(nativeTools.get('render_diagram')?.sideEffects, 'none');
  });

  it('the egress sees it; a write capability still wins; nothing declared leaves it to the manifest', () => {
    const nativeTools = new NativeToolRegistry();
    const ctx = pluginContext('@omadia/diagrams', nativeTools);
    ctx.tools.register(spec('render_diagram'), async () => 'ok', { sideEffects: 'none' });
    ctx.tools.register(spec('legacy_tool'), async () => 'ok');
    ctx.tools.register(spec('posting_tool'), async () => 'ok', {
      sideEffects: 'none',
      writeCapabilities: CREATE_INVOICE,
    });
    const { orchestrator } = verifiedTurn({ responses: [text('ok')], verdicts: [approved()], registry: nativeTools });
    const systemOf = (name: string): ToolSystem | undefined =>
      (orchestrator as unknown as { toolSystemOf(n: string): ToolSystem | undefined }).toolSystemOf(name);
    assert.deepEqual(systemOf('render_diagram'), { system: '@omadia/diagrams', effect: 'none' });
    assert.deepEqual(systemOf('legacy_tool'), { system: '@omadia/diagrams', effect: 'unknown' });
    assert.equal(systemOf('posting_tool')?.effect, 'write');
  });
});

describe('a kernel tool that declares its system (#2319)', () => {
  it('is checked as that system with its declared effect; a plain kernel tool belongs to none', () => {
    const nativeTools = new NativeToolRegistry();
    const handler = async (): Promise<string> => 'ok';
    nativeTools.register('credential_request', {
      handler,
      spec: spec('credential_request'),
      sideEffects: 'write',
      kernelSystem: (input) => `credential:${String((input as { credential?: string }).credential)}`,
      modelDispatchOnly: true,
    });
    nativeTools.register('static_kernel_tool', { handler, spec: spec('static_kernel_tool'), kernelSystem: 'some-system' });
    nativeTools.register('plain_kernel_tool', { handler, spec: spec('plain_kernel_tool') });
    assert.equal(nativeTools.get('credential_request')?.modelDispatchOnly, true);
    const { orchestrator } = verifiedTurn({ responses: [text('ok')], verdicts: [approved()], registry: nativeTools });
    const systemOf = (name: string, input?: unknown): ToolSystem | undefined =>
      (orchestrator as unknown as { toolSystemOf(n: string, i?: unknown): ToolSystem | undefined }).toolSystemOf(name, input);
    // One system per named credential: what one read is checked before it leaves through another.
    assert.deepEqual(systemOf('credential_request', { credential: 'hr-api' }), { system: 'credential:hr-api', effect: 'write' });
    assert.deepEqual(systemOf('credential_request', { credential: 'crm' }), { system: 'credential:crm', effect: 'write' });
    assert.deepEqual(systemOf('static_kernel_tool'), { system: 'some-system', effect: 'unknown' });
    assert.equal(systemOf('plain_kernel_tool'), undefined);
  });
});
