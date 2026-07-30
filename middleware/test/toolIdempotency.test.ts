import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { ToolDispatchService } from '../packages/harness-orchestrator/src/toolDispatchService.js';
import {
  ToolIdempotencyStore,
  currentIdempotencyScope,
  fingerprintToolInput,
  idempotencyCacheKey,
} from '../packages/harness-orchestrator/src/toolIdempotency.js';
import type { WriteCapability } from '../packages/plugin-api/src/writeCapabilities.js';
import { isWriteCapableTool } from '../packages/plugin-api/src/writeCapabilities.js';

/**
 * #542 prerequisite — idempotency for write-capable tool dispatch.
 *
 * MUTATION-CHECK DISCIPLINE: the assertions count REAL EXECUTIONS of the
 * underlying handler (a counter the handler itself increments), never mock
 * invocation counts on a dedupe helper. A test that asserted "the store was
 * consulted" would stay green over a store that always misses.
 */

const CREATE_INVOICE: readonly WriteCapability[] = [
  { dataClass: 'odoo.invoice', operation: 'create' },
];

/** A write-capable tool whose handler counts how many times it really ran. */
function writeToolService(options?: {
  readonly capabilities?: readonly WriteCapability[];
  readonly store?: ToolIdempotencyStore;
  readonly failWith?: () => never;
}): { service: ToolDispatchService; executions: () => number } {
  let executions = 0;
  const nativeTools = new NativeToolRegistry();
  nativeTools.register('odoo_create_invoice', {
    handler: async (input) => {
      executions += 1;
      options?.failWith?.();
      return `invoice-created:${JSON.stringify(input)}`;
    },
    spec: {
      name: 'odoo_create_invoice',
      description: 'creates an invoice — mutates data',
      input_schema: { type: 'object', properties: {} },
    },
    domain: 'test.odoo',
    ...(options?.capabilities !== undefined
      ? { writeCapabilities: options.capabilities }
      : {}),
  });
  return {
    service: new ToolDispatchService({
      nativeTools,
      domainTools: [],
      ...(options?.store !== undefined ? { idempotency: options.store } : {}),
    }),
    executions: () => executions,
  };
}

describe('write-capability declaration', () => {
  it('treats a tool with declared write capabilities as write-capable', () => {
    assert.equal(isWriteCapableTool(CREATE_INVOICE), true);
  });

  it('treats an unannotated or empty declaration as read-only', () => {
    assert.equal(isWriteCapableTool(undefined), false);
    assert.equal(isWriteCapableTool([]), false);
  });

  it('surfaces the declaration through the registry onto the dispatcher', () => {
    const { service } = writeToolService({ capabilities: CREATE_INVOICE });
    assert.equal(service.isWriteCapable('odoo_create_invoice'), true);
    assert.equal(service.isWriteCapable('nope'), false);
  });

  it('reaches the dispatcher through the PLUGIN-facing accessor, not just kernel calls', async () => {
    // The declaration is worthless if a real plugin cannot make it. This walks
    // the actual `ctx.tools.register(spec, handler, options)` shim the kernel
    // gives plugins and asserts the capability survives the hop into the
    // registry — a shim that silently drops the field would leave every real
    // Odoo/M365 write unprotected while all the unit tests stayed green.
    const { createPluginContext } = await import('../src/platform/pluginContext.js');
    const { ServiceRegistry } = await import('../src/platform/serviceRegistry.js');
    type Opts = Parameters<typeof createPluginContext>[0];
    const stub = (): (() => void) => (): void => {};
    const nativeTools = new NativeToolRegistry();
    const ctx = createPluginContext({
      agentId: '@omadia/integration-odoo',
      vault: {
        get: async () => undefined,
        listKeys: async () => [],
      } as unknown as Opts['vault'],
      registry: {
        has: () => true,
        list: () => [],
        get: () => undefined,
      } as unknown as Opts['registry'],
      catalog: new Map() as unknown as Opts['catalog'],
      serviceRegistry: new ServiceRegistry(),
      nativeToolRegistry: nativeTools,
      routeRegistry: {
        register: stub,
        disposeBySource: () => 0,
      } as unknown as Opts['routeRegistry'],
      jobScheduler: {
        register: stub,
        stopForPlugin: () => {},
      } as unknown as Opts['jobScheduler'],
      logger: () => {},
    });

    ctx.tools.register(
      {
        name: 'odoo_post_invoice',
        description: 'posts an invoice',
        input_schema: { type: 'object', properties: {} },
      },
      async () => 'posted',
      { writeCapabilities: CREATE_INVOICE },
    );

    assert.deepEqual(
      nativeTools.get('odoo_post_invoice')?.writeCapabilities,
      CREATE_INVOICE,
      'the plugin-facing shim dropped writeCapabilities',
    );
    const service = new ToolDispatchService({ nativeTools, domainTools: [] });
    assert.equal(service.isWriteCapable('odoo_post_invoice'), true);
  });
});

describe('ToolIdempotencyStore', () => {
  it('executes once and REPLAYS the stored result for a duplicate key', async () => {
    const store = new ToolIdempotencyStore();
    let runs = 0;
    const exec = async () => {
      runs += 1;
      return { content: `run-${String(runs)}` };
    };

    const a = await store.run('k1', 'tool', { x: 1 }, exec);
    const b = await store.run('k1', 'tool', { x: 1 }, exec);

    assert.equal(runs, 1, 'the executor must run exactly once');
    assert.equal(a.result.content, 'run-1');
    assert.equal(b.result.content, 'run-1', 'the duplicate must see the FIRST result');
    assert.equal(b.replayed, true);
  });

  it('COLLAPSES concurrent duplicates onto one execution', async () => {
    const store = new ToolIdempotencyStore();
    let runs = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const exec = async () => {
      runs += 1;
      await gate;
      return { content: 'once' };
    };

    const both = Promise.all([
      store.run('k1', 'tool', { x: 1 }, exec),
      store.run('k1', 'tool', { x: 1 }, exec),
    ]);
    release?.();
    const [a, b] = await both;

    assert.equal(runs, 1, 'a concurrent duplicate must not start a second execution');
    assert.equal(a.result.content, 'once');
    assert.equal(b.result.content, 'once');
  });

  it('REJECTS a reused key carrying a different payload instead of executing', async () => {
    const store = new ToolIdempotencyStore();
    let runs = 0;
    const exec = async () => {
      runs += 1;
      return { content: 'ok' };
    };

    await store.run('k1', 'tool', { amount: 100 }, exec);
    const conflict = await store.run('k1', 'tool', { amount: 999 }, exec);

    assert.equal(runs, 1, 'a conflicting payload must NOT execute');
    assert.equal(conflict.result.isError, true);
    assert.match(conflict.result.content, /idempotency key reused/);
  });

  it('treats key-equal payloads with reordered object keys as the SAME call', async () => {
    assert.equal(
      fingerprintToolInput({ a: 1, b: 2 }),
      fingerprintToolInput({ b: 2, a: 1 }),
      'key order must not change the fingerprint, or a benign re-serialisation looks like a conflict',
    );
    const store = new ToolIdempotencyStore();
    let runs = 0;
    const exec = async () => {
      runs += 1;
      return { content: 'ok' };
    };
    await store.run('k1', 'tool', { a: 1, b: 2 }, exec);
    await store.run('k1', 'tool', { b: 2, a: 1 }, exec);
    assert.equal(runs, 1);
  });

  it('re-executes after the TTL window expires (bounded, not permanent)', async () => {
    let now = 1_000;
    const store = new ToolIdempotencyStore({ ttlMs: 500, now: () => now });
    let runs = 0;
    const exec = async () => {
      runs += 1;
      return { content: `run-${String(runs)}` };
    };

    await store.run('k1', 'tool', {}, exec);
    now += 499;
    await store.run('k1', 'tool', {}, exec);
    assert.equal(runs, 1, 'still inside the window — must replay');

    now += 2;
    const after = await store.run('k1', 'tool', {}, exec);
    assert.equal(runs, 2, 'past the window — must execute again');
    assert.equal(after.result.content, 'run-2');
  });

  it('does NOT retain an isError outcome, so a caller may legitimately retry', async () => {
    const store = new ToolIdempotencyStore();
    let runs = 0;
    const exec = async () => {
      runs += 1;
      return runs === 1
        ? { content: 'Error: downstream refused', isError: true }
        : { content: 'ok' };
    };

    const first = await store.run('k1', 'tool', {}, exec);
    assert.equal(first.result.isError, true);
    const second = await store.run('k1', 'tool', {}, exec);

    assert.equal(runs, 2, 'a failed call must not be cached as the final answer');
    assert.equal(second.result.content, 'ok');
  });

  it('does NOT retain a thrown outcome', async () => {
    const store = new ToolIdempotencyStore();
    let runs = 0;
    const exec = async (): Promise<{ content: string }> => {
      runs += 1;
      if (runs === 1) throw new Error('boom');
      return { content: 'ok' };
    };

    await assert.rejects(() => store.run('k1', 'tool', {}, exec), /boom/);
    const second = await store.run('k1', 'tool', {}, exec);

    assert.equal(runs, 2);
    assert.equal(second.result.content, 'ok');
    assert.equal(store.size(), 1, 'the rejected entry must not linger alongside the good one');
  });

  it('does not let a key containing the separator collide with another tool', async () => {
    // `("a:b", "t")` and `("b", "t:a")` must stay distinct. A naive
    // `${toolName}:${key}` composition maps BOTH to `t:a:b`, which would let one
    // caller's key replay another tool's stored write result.
    assert.notEqual(
      idempotencyCacheKey('a:b', 't'),
      idempotencyCacheKey('b', 't:a'),
      'cache-key composition is ambiguous — one tool could replay another tool result',
    );

    const store = new ToolIdempotencyStore();
    let runs = 0;
    const exec = async () => {
      runs += 1;
      return { content: `run-${String(runs)}` };
    };
    const a = await store.run('a:b', 't', {}, exec);
    const b = await store.run('b', 't:a', {}, exec);

    assert.equal(runs, 2, 'two distinct (key, tool) pairs must both execute');
    assert.equal(a.result.content, 'run-1');
    assert.equal(b.result.content, 'run-2');
  });

  it('bounds retained records', async () => {
    const store = new ToolIdempotencyStore({ maxEntries: 3 });
    for (let i = 0; i < 10; i += 1) {
      await store.run(`k${String(i)}`, 'tool', {}, async () => ({ content: 'ok' }));
    }
    assert.equal(store.size(), 3);
  });
});

describe('ToolDispatchService — idempotent write dispatch', () => {
  it('executes a write tool ONCE across duplicate dispatches sharing a key', async () => {
    const store = new ToolIdempotencyStore();
    const { service, executions } = writeToolService({
      capabilities: CREATE_INVOICE,
      store,
    });

    const a = await service.dispatch(
      'odoo_create_invoice',
      { amount: 100 },
      { idempotencyKey: 'req-1' },
    );
    const b = await service.dispatch(
      'odoo_create_invoice',
      { amount: 100 },
      { idempotencyKey: 'req-1' },
    );

    assert.equal(executions(), 1, 'the write executed twice — duplicate customer data');
    assert.equal(a.content, b.content);
  });

  it('executes a write tool TWICE under DIFFERENT keys (dedupe is per key, not per tool)', async () => {
    const store = new ToolIdempotencyStore();
    const { service, executions } = writeToolService({
      capabilities: CREATE_INVOICE,
      store,
    });

    await service.dispatch('odoo_create_invoice', { amount: 1 }, { idempotencyKey: 'req-1' });
    await service.dispatch('odoo_create_invoice', { amount: 2 }, { idempotencyKey: 'req-2' });

    assert.equal(executions(), 2, 'two distinct requests must both run');
  });

  it('does NOT dedupe a READ tool — a cached read would serve stale data', async () => {
    const store = new ToolIdempotencyStore();
    // Same tool, no write-capability declaration ⇒ read-only.
    const { service, executions } = writeToolService({ store });

    await service.dispatch('odoo_create_invoice', {}, { idempotencyKey: 'req-1' });
    await service.dispatch('odoo_create_invoice', {}, { idempotencyKey: 'req-1' });

    assert.equal(executions(), 2, 'a read tool must not be deduplicated');
  });

  it('is INERT without a store (legacy behaviour preserved)', async () => {
    const { service, executions } = writeToolService({ capabilities: CREATE_INVOICE });

    await service.dispatch('odoo_create_invoice', {}, { idempotencyKey: 'req-1' });
    await service.dispatch('odoo_create_invoice', {}, { idempotencyKey: 'req-1' });

    assert.equal(executions(), 2);
  });

  it('publishes an exactlyOnce scope to layers beneath the handler — for writes only', async () => {
    const store = new ToolIdempotencyStore();
    const seen: Array<{ key: string; exactlyOnce: boolean } | undefined> = [];
    const nativeTools = new NativeToolRegistry();
    const record = async (): Promise<string> => {
      const scope = currentIdempotencyScope();
      seen.push(
        scope === undefined
          ? undefined
          : { key: scope.key, exactlyOnce: scope.exactlyOnce },
      );
      return 'ok';
    };
    nativeTools.register('write_tool', {
      handler: record,
      spec: {
        name: 'write_tool',
        description: 'd',
        input_schema: { type: 'object', properties: {} },
      },
      domain: 'test.x',
      writeCapabilities: CREATE_INVOICE,
    });
    nativeTools.register('read_tool', {
      handler: record,
      spec: {
        name: 'read_tool',
        description: 'd',
        input_schema: { type: 'object', properties: {} },
      },
      domain: 'test.x',
    });
    const service = new ToolDispatchService({
      nativeTools,
      domainTools: [],
      idempotency: store,
    });

    await service.dispatch('write_tool', {}, { idempotencyKey: 'req-1' });
    await service.dispatch('read_tool', {}, { idempotencyKey: 'req-2' });

    assert.deepEqual(seen, [{ key: 'req-1', exactlyOnce: true }, undefined]);
  });
});

/**
 * W4 — an in-flight entry used to be exempt from BOTH expiry and eviction, with
 * no upper bound at all. The reasoning ("it never expires out from under its own
 * execution") holds only while the execution finishes. A handler that hangs
 * forever — the exact failure the dispatch deadline exists for, and the deadline
 * resolves the SLOT, it does not make the underlying promise settle — pinned its
 * key permanently: every later call under that key awaited a promise that never
 * resolved, and the entry could not be evicted, so the map grew past
 * `maxEntries` unchecked.
 */
describe('ToolIdempotencyStore — in-flight entries are bounded (W4)', () => {
  /** A promise that never settles: a hung executor, not a slow one. */
  function hung(): Promise<{ content: string }> {
    return new Promise<{ content: string }>(() => undefined);
  }

  it('MUTATION CHECK: a hung execution stops pinning its key once the TTL passes', async () => {
    let clock = 0;
    const store = new ToolIdempotencyStore({ ttlMs: 1_000, now: () => clock });

    // Fire and DO NOT await — this one never settles.
    void store.run('k1', 'write_tool', { a: 1 }, hung).catch(() => undefined);

    clock += 2_000;

    // Under the bug this call collapsed onto the hung promise and never
    // resolved, so the test would time out rather than fail — which is why the
    // assertion below is guarded by an explicit race instead of a bare await.
    let executed = 0;
    const fresh = store.run('k1', 'write_tool', { a: 1 }, async () => {
      executed += 1;
      return { content: 'fresh result' };
    });
    const settled = await Promise.race([
      fresh,
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 250)),
    ]);

    assert.notEqual(settled, 'hung', 'the expired in-flight entry still pinned the key');
    assert.equal(executed, 1, 'the replacement execution must actually run');
    assert.deepEqual(
      (settled as Awaited<typeof fresh>).result,
      { content: 'fresh result' },
    );
    assert.equal((settled as Awaited<typeof fresh>).replayed, false);
  });

  it('collapses a concurrent duplicate onto a still-live in-flight execution', async () => {
    // The property the expiry must NOT break: inside the TTL, duplicates share
    // one execution instead of racing.
    let clock = 0;
    const store = new ToolIdempotencyStore({ ttlMs: 10_000, now: () => clock });
    let executed = 0;
    let release!: (value: { content: string }) => void;
    const gate = new Promise<{ content: string }>((r) => {
      release = r;
    });

    const first = store.run('k1', 'write_tool', { a: 1 }, () => {
      executed += 1;
      return gate;
    });
    clock += 500;
    const second = store.run('k1', 'write_tool', { a: 1 }, () => {
      executed += 1;
      return gate;
    });

    release({ content: 'once' });
    const [a, b] = await Promise.all([first, second]);

    assert.equal(executed, 1, 'the duplicate must not get its own execution');
    assert.equal(a.replayed, false);
    assert.equal(b.replayed, true);
    assert.deepEqual(b.result, { content: 'once' });
  });

  it('MUTATION CHECK: hung executions cannot grow the map without bound', async () => {
    let clock = 0;
    const store = new ToolIdempotencyStore({
      ttlMs: 1_000,
      maxEntries: 2,
      now: () => clock,
    });

    for (let i = 0; i < 5; i += 1) {
      void store.run(`k${String(i)}`, 'write_tool', { i }, hung).catch(() => undefined);
    }
    // While genuinely live, in-flight entries are correctly protected from
    // eviction — losing one would break duplicate collapsing.
    assert.equal(store.size(), 5);

    clock += 2_000;

    // One more dispatch. Its own entry is live; the five stale ones are not, and
    // the evictor now runs on the in-flight path too (it used to run only after
    // a SUCCESSFUL completion, so a burst of hung calls never triggered it).
    void store.run('k-new', 'write_tool', { n: 1 }, hung).catch(() => undefined);

    assert.ok(
      store.size() <= 2,
      `stale in-flight entries were never evicted — map holds ${String(store.size())} entries with maxEntries=2`,
    );
  });

  it('a late completion does not clobber a newer execution installed under the same key', async () => {
    // Direct consequence of making in-flight entries expirable: two executions
    // can legitimately exist for one key. The older one's outcome must not
    // overwrite the newer one's entry.
    let clock = 0;
    const store = new ToolIdempotencyStore({ ttlMs: 1_000, now: () => clock });
    let releaseOld!: (value: { content: string }) => void;
    const old = new Promise<{ content: string }>((r) => {
      releaseOld = r;
    });

    const first = store.run('k1', 'write_tool', { a: 1 }, () => old);
    clock += 2_000;
    const second = await store.run('k1', 'write_tool', { a: 1 }, async () => ({
      content: 'newer',
    }));
    assert.deepEqual(second.result, { content: 'newer' });

    releaseOld({ content: 'stale' });
    await first;

    // The newer result is what a replay gets.
    const replay = await store.run('k1', 'write_tool', { a: 1 }, async () => {
      assert.fail('a live cached entry must not re-execute');
    });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.result, { content: 'newer' });
  });
});
