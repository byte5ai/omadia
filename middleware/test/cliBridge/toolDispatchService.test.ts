import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { DomainTool } from '../../packages/harness-orchestrator/src/tools/domainQueryTool.js';
import { NativeToolRegistry } from '../../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { ToolDispatchService } from '../../packages/harness-orchestrator/src/toolDispatchService.js';

describe('ToolDispatchService', () => {
  it('routes to native handlers first', async () => {
    const nativeTools = new NativeToolRegistry();
    nativeTools.register('echo_native', {
      handler: async (input) => `native:${JSON.stringify(input)}`,
      spec: {
        name: 'echo_native',
        description: 'd',
        input_schema: { type: 'object', properties: {} },
      },
      domain: 'test.x',
    });

    const service = new ToolDispatchService({ nativeTools, domainTools: [] });
    const result = await service.dispatch('echo_native', { ok: true });

    assert.equal(result.content, 'native:{"ok":true}');
    assert.equal(result.isError, undefined);
  });

  it('routes to domain tools when native is absent', async () => {
    const nativeTools = new NativeToolRegistry();
    const seen: unknown[] = [];
    const domainTool: DomainTool = {
      name: 'domain_ping',
      spec: {
        name: 'domain_ping',
        description: 'domain',
        input_schema: {
          type: 'object',
          properties: {
            msg: { type: 'string', description: 'message' },
          },
          required: ['msg'],
        },
      },
      domain: 'domain.test',
      async handle(input) {
        seen.push(input);
        return `domain:${JSON.stringify(input)}`;
      },
    };

    const service = new ToolDispatchService({
      nativeTools,
      domainTools: [domainTool],
    });
    const result = await service.dispatch('domain_ping', { msg: 'hi' });

    assert.equal(result.content, 'domain:{"msg":"hi"}');
    assert.deepEqual(seen, [{ msg: 'hi' }]);
  });

  it('keeps native precedence on name collisions', async () => {
    const nativeTools = new NativeToolRegistry();
    nativeTools.register('shared_name', {
      handler: async () => 'native wins',
      spec: {
        name: 'shared_name',
        description: 'native',
        input_schema: { type: 'object', properties: {} },
      },
      domain: 'test.x',
    });

    const domainTool: DomainTool = {
      name: 'shared_name',
      spec: {
        name: 'shared_name',
        description: 'domain',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
      domain: 'domain.test',
      async handle() {
        return 'domain loses';
      },
    };

    const service = new ToolDispatchService({
      nativeTools,
      domainTools: [domainTool],
    });

    const result = await service.dispatch('shared_name', {});
    assert.equal(result.content, 'native wins');
  });

  it('returns an error for unknown tools', async () => {
    const service = new ToolDispatchService({
      nativeTools: new NativeToolRegistry(),
      domainTools: [],
    });

    const result = await service.dispatch('missing_tool', {});

    assert.equal(result.isError, true);
    assert.match(result.content, /missing_tool/);
  });

  it('returns handler errors as error content', async () => {
    const nativeTools = new NativeToolRegistry();
    nativeTools.register('boom', {
      handler: async () => {
        throw new Error('native broke');
      },
      spec: {
        name: 'boom',
        description: 'boom',
        input_schema: { type: 'object', properties: {} },
      },
      domain: 'test.x',
    });

    const service = new ToolDispatchService({ nativeTools, domainTools: [] });
    const result = await service.dispatch('boom', {});

    assert.equal(result.isError, true);
    assert.equal(result.content, 'native broke');
  });

  it('lists advertised native and domain specs with native precedence', async () => {
    const nativeTools = new NativeToolRegistry();
    nativeTools.register('echo_native', {
      handler: async () => 'ok',
      spec: {
        name: 'echo_native',
        description: 'native spec',
        input_schema: { type: 'object', properties: { a: { type: 'string' } } },
      },
      domain: 'test.x',
    });
    nativeTools.register('shared_name', {
      handler: async () => 'ok',
      spec: {
        name: 'shared_name',
        description: 'native shared',
        input_schema: { type: 'object', properties: {} },
      },
      domain: 'test.x',
    });

    const domainTool: DomainTool = {
      name: 'domain_ping',
      spec: {
        name: 'domain_ping',
        description: 'domain spec',
        input_schema: {
          type: 'object',
          properties: { msg: { type: 'string' } },
          required: ['msg'],
        },
      },
      domain: 'domain.test',
      async handle() {
        return 'domain';
      },
    };
    const collidingDomainTool: DomainTool = {
      name: 'shared_name',
      spec: {
        name: 'shared_name',
        description: 'domain shared',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
      domain: 'domain.test',
      async handle() {
        return 'domain';
      },
    };

    const service = new ToolDispatchService({
      nativeTools,
      domainTools: [domainTool, collidingDomainTool],
    });

    const specs = service.listDispatchableToolSpecs();
    // W0-3 — advertised name-sorted (this used to be registration order:
    // natives in Map order, then domain tools). Order is the only thing the
    // sort changed; the precedence assertion below is unchanged.
    assert.deepEqual(
      specs.map((spec) => spec.name),
      ['domain_ping', 'echo_native', 'shared_name'],
    );
    // Look specs up by name so this stays honest if the ordering ever moves.
    const byName = new Map(specs.map((spec) => [spec.name, spec]));
    assert.equal(byName.get('echo_native')?.input_schema.type, 'object');
    assert.equal(byName.get('domain_ping')?.input_schema.type, 'object');
    // Native still wins the `shared_name` collision.
    assert.equal(byName.get('shared_name')?.description, 'native shared');
  });

  it('issue #474: refuses to dispatch a not-ready plugin tool and excludes it from the list', async () => {
    const nativeTools = new NativeToolRegistry();
    let handlerCalled = false;
    nativeTools.register('gated_tool', {
      handler: async () => {
        handlerCalled = true;
        return 'should never run';
      },
      spec: {
        name: 'gated_tool',
        description: 'gated',
        input_schema: { type: 'object', properties: {} },
      },
      domain: 'test.x',
      agentId: 'gated-plugin',
    });

    const service = new ToolDispatchService({
      nativeTools,
      domainTools: [],
      isPluginToolsReady: (agentId) => agentId !== 'gated-plugin',
    });

    const result = await service.dispatch('gated_tool', {});
    assert.equal(handlerCalled, false);
    assert.equal(result.isError, true);
    assert.match(result.content, /gated_tool/);

    assert.deepEqual(
      service.listDispatchableToolSpecs().map((s) => s.name),
      [],
    );
  });

  it('issue #474 follow-up: refuses to dispatch a not-ready plugin domain tool and excludes it from the list', async () => {
    const nativeTools = new NativeToolRegistry();
    let handlerCalled = false;
    const gatedDomainTool: DomainTool = {
      name: 'query_gated',
      spec: {
        name: 'query_gated',
        description: 'gated domain tool',
        input_schema: { type: 'object', properties: {} },
      },
      domain: 'test.domain',
      agentId: 'gated-plugin',
      async handle() {
        handlerCalled = true;
        return 'should never run';
      },
    };

    const service = new ToolDispatchService({
      nativeTools,
      domainTools: [gatedDomainTool],
      isPluginToolsReady: (agentId) => agentId !== 'gated-plugin',
    });

    const result = await service.dispatch('query_gated', {});
    assert.equal(handlerCalled, false);
    assert.equal(result.isError, true);
    assert.match(result.content, /query_gated/);

    assert.deepEqual(
      service.listDispatchableToolSpecs().map((s) => s.name),
      [],
    );
  });

  it('issue #474: still dispatches every tool when isPluginToolsReady is not wired', async () => {
    const nativeTools = new NativeToolRegistry();
    nativeTools.register('plain_tool', {
      handler: async () => 'ok',
      spec: {
        name: 'plain_tool',
        description: 'plain',
        input_schema: { type: 'object', properties: {} },
      },
      domain: 'test.x',
      agentId: 'some-plugin',
    });

    const service = new ToolDispatchService({ nativeTools, domainTools: [] });
    const result = await service.dispatch('plain_tool', {});
    assert.equal(result.content, 'ok');
    assert.equal(result.isError, undefined);
    assert.deepEqual(
      service.listDispatchableToolSpecs().map((s) => s.name),
      ['plain_tool'],
    );
  });

  it('does not advertise handler-only native entries but still dispatches them', async () => {
    const nativeTools = new NativeToolRegistry();
    nativeTools.registerHandler('mem', {
      handler: async () => 'handler-only',
    });

    const service = new ToolDispatchService({ nativeTools, domainTools: [] });
    const result = await service.dispatch('mem', {});

    assert.equal(result.content, 'handler-only');
    assert.deepEqual(service.listDispatchableToolSpecs(), []);
  });
});
