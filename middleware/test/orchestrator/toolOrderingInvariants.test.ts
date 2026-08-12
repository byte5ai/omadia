/**
 * W0-3 — ordering invariants for the other three surfaces that feed a tool
 * block: the standalone dispatch service (advertised to the loopback MCP
 * server / CLI bridge), sub-agent tool lists, and the persisted MCP
 * discovered-tools column.
 *
 * The load-bearing assertion is the negative one: sorting changes the
 * advertised ARRAY ORDER only. Which spec wins a duplicate name — native tools
 * take precedence over domain tools — is decided by Map insertion, and must be
 * unchanged.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { LocalSubAgentTool } from '@omadia/plugin-api';
import type { DomainTool } from '../../packages/harness-orchestrator/src/tools/domainQueryTool.js';
import type { ToolGrantRow } from '../../packages/harness-orchestrator/src/registry/agentGraphStore.js';
import { NativeToolRegistry } from '../../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { ToolDispatchService } from '../../packages/harness-orchestrator/src/toolDispatchService.js';
import { resolveSubAgentTools } from '../../packages/harness-orchestrator/src/registry/subAgentTools.js';
import {
  normalizeDiscoveredToolOrder,
  sortByToolName,
} from '../../packages/harness-orchestrator/src/toolOrdering.js';

const schema = {
  type: 'object' as const,
  properties: {},
  required: [] as string[],
};

function domainTool(name: string, description = name): DomainTool {
  return {
    name,
    spec: { name, description, input_schema: schema },
    domain: `domain.${name}`,
    async handle() {
      return `${name}-output`;
    },
  } as unknown as DomainTool;
}

describe('W0-3 — ToolDispatchService.listDispatchableToolSpecs', () => {
  it('advertises name-sorted regardless of registration order', () => {
    const nativeTools = new NativeToolRegistry();
    for (const name of ['n_zulu', 'n_alpha', 'n_mike']) {
      nativeTools.register(name, {
        handler: async () => name,
        spec: { name, description: name, input_schema: schema },
        domain: 'test.x',
      });
    }

    const service = new ToolDispatchService({
      nativeTools,
      domainTools: [domainTool('d_yankee'), domainTool('d_bravo')],
    });

    assert.deepEqual(
      service.listDispatchableToolSpecs().map((spec) => spec.name),
      ['d_bravo', 'd_yankee', 'n_alpha', 'n_mike', 'n_zulu'],
    );
  });

  it('keeps native precedence on a name collision — only the order changes', () => {
    const nativeTools = new NativeToolRegistry();
    // `zzz_shared` sorts last, so if sorting were driving collision resolution
    // the domain spec (registered later) could plausibly win. It must not.
    nativeTools.register('zzz_shared', {
      handler: async () => 'native wins',
      spec: {
        name: 'zzz_shared',
        description: 'native',
        input_schema: schema,
      },
      domain: 'test.x',
    });
    nativeTools.register('aaa_native_only', {
      handler: async () => 'ok',
      spec: {
        name: 'aaa_native_only',
        description: 'native-only',
        input_schema: schema,
      },
      domain: 'test.x',
    });

    const service = new ToolDispatchService({
      nativeTools,
      domainTools: [
        domainTool('zzz_shared', 'domain'),
        domainTool('mmm_domain_only', 'domain-only'),
      ],
    });

    const advertised = service.listDispatchableToolSpecs();

    // Sorted…
    assert.deepEqual(
      advertised.map((spec) => spec.name),
      ['aaa_native_only', 'mmm_domain_only', 'zzz_shared'],
    );
    // …deduplicated to one entry for the colliding name…
    assert.equal(
      advertised.filter((spec) => spec.name === 'zzz_shared').length,
      1,
    );
    // …and it is still the NATIVE spec that survives.
    assert.equal(
      advertised.find((spec) => spec.name === 'zzz_shared')?.description,
      'native',
    );
  });

  it('dispatch still resolves a collision to the native handler', async () => {
    const nativeTools = new NativeToolRegistry();
    nativeTools.register('zzz_shared', {
      handler: async () => 'native wins',
      spec: {
        name: 'zzz_shared',
        description: 'native',
        input_schema: schema,
      },
      domain: 'test.x',
    });

    const service = new ToolDispatchService({
      nativeTools,
      domainTools: [domainTool('zzz_shared', 'domain')],
    });

    const result = await service.dispatch('zzz_shared', {});
    assert.equal(result.content, 'native wins');
  });
});

describe('W0-3 — resolveSubAgentTools', () => {
  const grant = (toolRef: string, index: number): ToolGrantRow => ({
    id: `grant-${String(index)}`,
    agentId: null,
    subAgentId: 'sub-1',
    toolKind: 'native',
    toolRef,
    mcpServerId: null,
    config: {},
    // Grants arrive in `created_at` order — deliberately the inverse of
    // alphabetical here, so an unsorted implementation is visible.
    createdAt: new Date(2026, 0, 100 - index),
  });

  const nativeTool = (toolRef: string): LocalSubAgentTool =>
    ({
      spec: { name: toolRef, description: toolRef, input_schema: schema },
      async handle() {
        return `${toolRef}-output`;
      },
    }) as unknown as LocalSubAgentTool;

  it('returns the granted tools name-sorted', () => {
    const grants = ['s_zulu', 's_alpha', 's_papa', 's_bravo'].map(grant);

    const resolved = resolveSubAgentTools(grants, { nativeTool });

    assert.deepEqual(
      resolved.map((tool) => tool.spec.name),
      ['s_alpha', 's_bravo', 's_papa', 's_zulu'],
    );
  });

  it('drops unresolvable grants without disturbing the order', () => {
    const grants = ['s_zulu', 's_missing', 's_alpha'].map(grant);

    const resolved = resolveSubAgentTools(grants, {
      nativeTool: (ref) => (ref === 's_missing' ? undefined : nativeTool(ref)),
    });

    assert.deepEqual(
      resolved.map((tool) => tool.spec.name),
      ['s_alpha', 's_zulu'],
    );
  });
});

describe('W0-3 — normalizeDiscoveredToolOrder', () => {
  it('sorts discovered tools by name so rediscovery does not churn the JSONB', () => {
    const fromServer = [
      { name: 'search', description: 'b' },
      { name: 'create', description: 'a' },
      { name: 'update', description: 'c' },
    ];

    // Same set, different wire order — must normalize to identical bytes.
    const shuffled = [fromServer[2], fromServer[0], fromServer[1]];

    assert.equal(
      JSON.stringify(normalizeDiscoveredToolOrder(fromServer)),
      JSON.stringify(normalizeDiscoveredToolOrder(shuffled)),
    );
    assert.deepEqual(
      normalizeDiscoveredToolOrder(fromServer).map(
        (tool) => (tool as { name: string }).name,
      ),
      ['create', 'search', 'update'],
    );
  });

  it('degrades rather than throwing on entries without a usable name', () => {
    const malformed = [
      { name: 'beta' },
      null,
      { name: 42 },
      'not-an-object',
      { name: 'alpha' },
    ];

    const normalized = normalizeDiscoveredToolOrder(malformed);

    // Named entries sort first, unnamed keep their relative order.
    assert.equal(normalized.length, malformed.length);
    assert.deepEqual(normalized.slice(0, 2), [
      { name: 'alpha' },
      { name: 'beta' },
    ]);
    assert.deepEqual(normalized.slice(2), [null, { name: 42 }, 'not-an-object']);
  });

  it('sortByToolName does not mutate its input', () => {
    const input = [{ name: 'b' }, { name: 'a' }];
    const sorted = sortByToolName(input);

    assert.deepEqual(
      input.map((item) => item.name),
      ['b', 'a'],
    );
    assert.deepEqual(
      sorted.map((item) => item.name),
      ['a', 'b'],
    );
  });
});
