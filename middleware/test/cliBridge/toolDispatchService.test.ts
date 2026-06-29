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
    assert.deepEqual(
      specs.map((spec) => spec.name),
      ['echo_native', 'shared_name', 'domain_ping'],
    );
    assert.equal(specs[0]?.input_schema.type, 'object');
    assert.equal(specs[2]?.input_schema.type, 'object');
    assert.equal(specs[1]?.description, 'native shared');
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
