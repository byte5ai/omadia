import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { NativeToolRegistry } from '../../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { ToolDispatchService } from '../../packages/harness-orchestrator/src/toolDispatchService.js';
import { AskUserChoiceTool } from '../../packages/harness-orchestrator/src/tools/askUserChoiceTool.js';
import {
  KERNEL_NATIVE_TOOL_NAMES,
  registerKernelNativeTools,
  type KernelNativeInstances,
} from '../../packages/harness-orchestrator/src/orchestrator.js';

// Issue #1102 — on the subscription-CLI path the only way a spawned CLI learns
// about a tool is the loopback MCP server, which lists exactly what carries a
// spec AND a handler (toolDispatchService.listDispatchableToolSpecs). Before
// this change the seven kernel natives were registered marker-only, so none
// reached the CLI and the model invented "Gespeichert!". These tests lock the
// wiring: the five safe natives are advertised + dispatchable; memory and
// get_chat_participants deliberately stay marker-only.

const WIRED = [
  'query_knowledge_graph',
  'ask_user_choice',
  'suggest_follow_ups',
  'find_free_slots',
  'book_meeting',
];
const MARKER_ONLY = ['memory', 'get_chat_participants'];

/** A stub instance that records the input it was dispatched with. */
function stubInstance(tag: string, seen: Array<[string, unknown]>) {
  return {
    handle: async (input: unknown): Promise<string> => {
      seen.push([tag, input]);
      return `${tag}:${JSON.stringify(input)}`;
    },
  };
}

function allInstances(seen: Array<[string, unknown]>): KernelNativeInstances {
  return {
    knowledgeGraphTool: stubInstance('query_knowledge_graph', seen),
    askUserChoiceTool: stubInstance('ask_user_choice', seen),
    suggestFollowUpsTool: stubInstance('suggest_follow_ups', seen),
    findFreeSlotsTool: stubInstance('find_free_slots', seen),
    bookMeetingTool: stubInstance('book_meeting', seen),
  };
}

describe('registerKernelNativeTools (#1102 parity)', () => {
  it('registers all seven kernel natives', () => {
    const registry = new NativeToolRegistry();
    registerKernelNativeTools(registry, allInstances([]));
    for (const name of KERNEL_NATIVE_TOOL_NAMES) {
      assert.ok(registry.has(name), `expected ${name} registered`);
    }
  });

  it('gives the wired five a handler AND a schema', () => {
    const registry = new NativeToolRegistry();
    registerKernelNativeTools(registry, allInstances([]));

    const withHandler = new Set(
      registry.listWithHandler().map((r) => r.name),
    );
    for (const name of WIRED) {
      assert.ok(withHandler.has(name), `${name} must carry a handler`);
      const reg = registry.get(name);
      assert.ok(reg?.spec, `${name} must carry a spec`);
      assert.equal(reg?.spec?.name, name);
      assert.equal(reg?.spec?.input_schema.type, 'object');
    }
  });

  it('keeps memory and get_chat_participants marker-only', () => {
    const registry = new NativeToolRegistry();
    registerKernelNativeTools(registry, allInstances([]));
    for (const name of MARKER_ONLY) {
      const reg = registry.get(name);
      assert.ok(reg, `${name} must still be registered`);
      assert.equal(reg?.handler, undefined, `${name} must have no handler`);
      assert.equal(reg?.spec, undefined, `${name} must have no spec`);
    }
  });

  it('advertises the wired five over the loopback listing, not the marker-only two', () => {
    const registry = new NativeToolRegistry();
    registerKernelNativeTools(registry, allInstances([]));
    const service = new ToolDispatchService({
      nativeTools: registry,
      domainTools: [],
    });

    const advertised = new Set(
      service.listDispatchableToolSpecs().map((t) => t.name),
    );
    for (const name of WIRED) {
      assert.ok(advertised.has(name), `${name} must be advertised`);
    }
    for (const name of MARKER_ONLY) {
      assert.ok(!advertised.has(name), `${name} must NOT be advertised`);
    }
  });

  it('dispatches a wired native through to its instance handler', async () => {
    const seen: Array<[string, unknown]> = [];
    const registry = new NativeToolRegistry();
    registerKernelNativeTools(registry, allInstances(seen));
    const service = new ToolDispatchService({
      nativeTools: registry,
      domainTools: [],
    });

    const result = await service.dispatch('ask_user_choice', { question: 'q' });
    assert.equal(result.isError, undefined);
    assert.match(result.content, /ask_user_choice/);
    assert.deepEqual(seen, [['ask_user_choice', { question: 'q' }]]);
  });

  it('falls back to marker-only when an instance is absent', () => {
    const registry = new NativeToolRegistry();
    // No calendar this Agent — find_free_slots/book_meeting must not advertise.
    registerKernelNativeTools(registry, {
      knowledgeGraphTool: stubInstance('kg', []),
      askUserChoiceTool: stubInstance('choice', []),
      suggestFollowUpsTool: stubInstance('follow', []),
      findFreeSlotsTool: undefined,
      bookMeetingTool: undefined,
    });

    assert.equal(registry.get('find_free_slots')?.handler, undefined);
    assert.equal(registry.get('book_meeting')?.handler, undefined);
    assert.ok(registry.get('query_knowledge_graph')?.handler);
  });

  it('dispatching ask_user_choice schedules the real card on the tool instance', async () => {
    // The other half of the card path (drain → done event) is covered in
    // cliChatAgent.test.ts with a stub. This closes the loop with a REAL
    // AskUserChoiceTool: a loopback dispatch must land in `handle` and leave a
    // pending card the orchestrator's drain will pick up — no stub in between.
    const choiceTool = new AskUserChoiceTool();
    const registry = new NativeToolRegistry();
    registerKernelNativeTools(registry, {
      knowledgeGraphTool: undefined,
      askUserChoiceTool: choiceTool,
      suggestFollowUpsTool: undefined,
      findFreeSlotsTool: undefined,
      bookMeetingTool: undefined,
    });
    const service = new ToolDispatchService({
      nativeTools: registry,
      domainTools: [],
    });

    const res = await service.dispatch('ask_user_choice', {
      question: 'Umsatz wonach?',
      options: [{ label: 'Nach Kunde' }, { label: 'Nach Monat' }],
    });
    assert.equal(res.isError, undefined);

    const pending = choiceTool.takePending();
    assert.ok(pending, 'dispatch must leave a pending choice card');
    assert.equal(pending?.question, 'Umsatz wonach?');
    assert.equal(pending?.options.length, 2);
  });

  it('leaves a name a plugin already registered untouched', () => {
    const registry = new NativeToolRegistry();
    const pluginHandler = async (): Promise<string> => 'plugin';
    registry.register('ask_user_choice', {
      handler: pluginHandler,
      spec: {
        name: 'ask_user_choice',
        description: 'plugin-owned',
        input_schema: { type: 'object', properties: {} },
      },
    });

    registerKernelNativeTools(registry, allInstances([]));

    // The plugin's registration wins; the kernel did not overwrite it.
    assert.equal(registry.get('ask_user_choice')?.spec?.description, 'plugin-owned');
  });
});
