import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { NativeToolRegistry } from '../../packages/harness-orchestrator/src/nativeToolRegistry.js';
import type { PrivacyTurnHandle } from '../../packages/harness-orchestrator/src/privacyHandle.js';
import { ToolDispatchService } from '../../packages/harness-orchestrator/src/toolDispatchService.js';
import type { DomainTool } from '../../packages/harness-orchestrator/src/tools/domainQueryTool.js';
import {
  turnContext,
  type TurnContextValue,
} from '../../packages/harness-orchestrator/src/turnContext.js';

/**
 * `ToolDispatchService` — what a tool handler runs UNDER.
 *
 * The dispatcher used to apply its privacy handle only to the result a handler
 * returned. Code running inside the handler — a domain tool's `LocalSubAgent`
 * model loop, a plugin tool asking a sub-agent — reads the handle from
 * `turnContext`, which the standalone dispatcher never touched: on the public
 * MCP endpoint that code ran with no handle at all. These tests pin that the
 * handler now runs with the dispatch's handle as the ambient one, and that a
 * dispatcher that requires a handle runs no handler without one.
 *
 * Imported from SOURCE so a mutation in `src/` turns them red without a rebuild.
 */

type Seen = { handle: PrivacyTurnHandle | undefined; store: TurnContextValue | undefined };

function stubHandle(label: string, nested?: PrivacyTurnHandle): PrivacyTurnHandle {
  return {
    async internToolResultV4({ rawResult }: { toolName: string; rawResult: string }) {
      return { digestText: `«${label}» ${rawResult}`, datasetId: `ds-${label}` };
    },
    checkBypass: () => undefined,
    ...(nested !== undefined ? { forNestedCalls: () => nested } : {}),
  } as unknown as PrivacyTurnHandle;
}

function observe(seen: Seen[]): () => Promise<string> {
  return async () => {
    seen.push({ handle: turnContext.current()?.privacyHandle, store: turnContext.current() });
    return 'tool data';
  };
}

function nativeDispatcher(
  handler: () => Promise<string>,
  deps: Partial<ConstructorParameters<typeof ToolDispatchService>[0]> = {},
): ToolDispatchService {
  const nativeTools = new NativeToolRegistry();
  nativeTools.register('crm_lookup', {
    handler,
    spec: { name: 'crm_lookup', description: 'x', input_schema: { type: 'object', properties: {} } },
  });
  return new ToolDispatchService({ nativeTools, ...deps });
}

function domainDispatcher(
  handler: () => Promise<string>,
  deps: Partial<ConstructorParameters<typeof ToolDispatchService>[0]> = {},
): ToolDispatchService {
  const tool = {
    name: 'ask_hr',
    spec: { name: 'ask_hr', description: 'x', input_schema: { type: 'object', properties: {}, required: [] } },
    domain: 'test.hr',
    handle: handler,
  } as unknown as DomainTool;
  return new ToolDispatchService({ nativeTools: new NativeToolRegistry(), domainTools: [tool], ...deps });
}

const BRANCHES = [
  ['native', nativeDispatcher, 'crm_lookup'],
  ['domain', domainDispatcher, 'ask_hr'],
] as const;

for (const [branch, make, toolName] of BRANCHES) {
  describe(`ToolDispatchService (${branch} branch) — the handler runs under the dispatch handle`, () => {
    it('outside any turn: the explicit handle is the ambient one, with no turn id invented', async () => {
      const seen: Seen[] = [];
      const handle = stubHandle('outer');
      const service = make(observe(seen), { privacy: () => handle });

      const result = await service.dispatch(toolName, {});

      assert.equal(seen[0]?.handle, handle, 'code inside the handler ran without the handle');
      assert.equal(seen[0]?.store?.turnId, '', 'a turn-less scope keeps the turn-less placeholder');
      assert.equal(result.content, '«outer» tool data', 'the result is masked as before');
    });

    it("nested code gets the handle's forNestedCalls() variant; the result keeps the outer one", async () => {
      const seen: Seen[] = [];
      const nested = stubHandle('nested');
      const service = make(observe(seen), { privacy: () => stubHandle('outer', nested) });

      const result = await service.dispatch(toolName, {});

      assert.equal(seen[0]?.handle, nested);
      assert.equal(result.content, '«outer» tool data');
    });

    it("inside a turn: overrides only the handle and keeps the turn's other fields", async () => {
      const seen: Seen[] = [];
      const explicit = stubHandle('explicit');
      const service = make(observe(seen), { privacy: () => explicit });
      const turn: TurnContextValue = {
        turnId: 'turn-7',
        turnDate: '2026-10-01',
        agentSlug: 'sales',
        privacyHandle: stubHandle('turn'),
      };

      await turnContext.run(turn, () => service.dispatch(toolName, {}));

      assert.equal(seen[0]?.handle, explicit);
      assert.equal(seen[0]?.store?.turnId, 'turn-7');
      assert.equal(seen[0]?.store?.agentSlug, 'sales');
    });

    it('with no explicit handle, the ambient turn scope is left exactly as it is', async () => {
      const seen: Seen[] = [];
      const service = make(observe(seen));
      const turn: TurnContextValue = {
        turnId: 'turn-8',
        turnDate: '2026-10-01',
        privacyHandle: stubHandle('turn'),
      };

      await turnContext.run(turn, () => service.dispatch(toolName, {}));

      assert.equal(seen[0]?.store, turn, 'no re-scope when the ambient handle is the one in force');
    });

    it('requirePrivacyHandle: with no handle the handler never runs; a neutral notice answers', async () => {
      const seen: Seen[] = [];
      const service = make(observe(seen), { privacy: () => undefined, requirePrivacyHandle: true });

      const result = await service.dispatch(toolName, {});

      assert.equal(seen.length, 0, 'the handler ran without a privacy handle');
      assert.equal(result.origin, 'dispatcher');
      assert.equal(result.isError, true);
      assert.equal(
        result.content,
        `Error: tool \`${toolName}\` was not run: no privacy guard is active for this call.`,
      );
    });

    it('requirePrivacyHandle: with a handle the handler runs as usual', async () => {
      const seen: Seen[] = [];
      const handle = stubHandle('outer');
      const service = make(observe(seen), { privacy: () => handle, requirePrivacyHandle: true });

      const result = await service.dispatch(toolName, {});

      assert.equal(seen.length, 1);
      assert.equal(result.content, '«outer» tool data');
    });
  });
}
