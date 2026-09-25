import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { AgentPluginBindingStore } from '../src/plugins/installService.js';
import { createPendingBindingPurge } from '../src/plugins/pendingBindingPurge.js';

/**
 * #1070 (OM-95 follow-up) — bootstrap removes plugins before the orchestrator
 * has provided its `configStore`, so the `agent_plugins` purge is queued and
 * drained later. These tests pin the queue's contract: nothing is lost while
 * the store is absent, every id is purged exactly once when it appears, and a
 * failing DELETE is logged with the plugin id instead of being swallowed.
 */

function recordingStore(
  impl: (pluginId: string) => Promise<number> = async () => 1,
): { store: AgentPluginBindingStore; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    store: {
      deleteAgentPluginsForPlugin: async (pluginId) => {
        calls.push(pluginId);
        return impl(pluginId);
      },
    },
  };
}

describe('createPendingBindingPurge (#1070)', () => {
  it('keeps the queue and warns with every id while the store is absent on a DB host', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const queue = createPendingBindingPurge({
      getStore: () => undefined,
      hasDatabase: true,
      isInstalled: () => false,
    });
    queue.enqueue('a');
    queue.enqueue('b');

    await queue.flush();

    assert.deepEqual([...queue.pending()], ['a', 'b']);
    assert.equal(warn.mock.callCount(), 1);
    const line = String(warn.mock.calls[0]?.arguments[0]);
    assert.ok(line.includes('a') && line.includes('b'), line);
    assert.ok(line.includes('@omadia/orchestrator'), line);
  });

  it('purges every queued id once the store appears, then is a silent no-op', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const log = t.mock.method(console, 'log', () => {});
    const { store, calls } = recordingStore();
    let current: AgentPluginBindingStore | undefined;
    const queue = createPendingBindingPurge({
      getStore: () => current,
      hasDatabase: true,
      isInstalled: () => false,
    });
    queue.enqueue('a');
    queue.enqueue('b');
    await queue.flush();
    assert.deepEqual(calls, []);

    current = store;
    await queue.flush();
    assert.deepEqual(calls, ['a', 'b']);
    assert.deepEqual([...queue.pending()], []);

    const logsBefore = log.mock.callCount();
    await queue.flush();
    assert.deepEqual(calls, ['a', 'b'], 'third flush must not purge again');
    assert.equal(log.mock.callCount(), logsBefore, 'third flush must not log');
  });

  it('on a DB-less host logs at info level and keeps the ids for a late store', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const log = t.mock.method(console, 'log', () => {});
    const { store, calls } = recordingStore();
    let current: AgentPluginBindingStore | undefined;
    const queue = createPendingBindingPurge({
      getStore: () => current,
      hasDatabase: false,
      isInstalled: () => false,
    });
    queue.enqueue('a');

    await queue.flush();

    assert.equal(warn.mock.callCount(), 0);
    assert.equal(log.mock.callCount(), 1);
    assert.ok(String(log.mock.calls[0]?.arguments[0]).includes('a'));
    assert.deepEqual(calls, []);
    // The KG can still publish a graphPool from a vault-stored DSN without
    // DATABASE_URL, so the orchestrator store may appear later on this host.
    assert.deepEqual([...queue.pending()], ['a']);

    current = store;
    await queue.flush();
    assert.deepEqual(calls, ['a']);
    assert.deepEqual([...queue.pending()], []);
  });

  it('logs a failed purge loudly with the plugin id and never rejects', async (t) => {
    const error = t.mock.method(console, 'error', () => {});
    const { store } = recordingStore(() => Promise.reject(new Error('db down')));
    const queue = createPendingBindingPurge({
      getStore: () => store,
      hasDatabase: true,
      isInstalled: () => false,
    });
    queue.enqueue('a');

    await assert.doesNotReject(queue.flush());

    assert.deepEqual(error.mock.calls.map((call) => call.arguments), [
      ['[install] agent-plugin binding purge failed for a:', 'db down'],
    ]);
  });

  it('collapses a duplicate enqueue into one purge', async (t) => {
    t.mock.method(console, 'log', () => {});
    const { store, calls } = recordingStore();
    const queue = createPendingBindingPurge({
      getStore: () => store,
      hasDatabase: true,
      isInstalled: () => false,
    });
    queue.enqueue('a');
    queue.enqueue('a');

    await queue.flush();

    assert.deepEqual(calls, ['a']);
  });

  it('an empty flush touches neither the store nor the console', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const log = t.mock.method(console, 'log', () => {});
    let lookups = 0;
    const queue = createPendingBindingPurge({
      getStore: () => {
        lookups += 1;
        return undefined;
      },
      hasDatabase: true,
      isInstalled: () => false,
    });

    await queue.flush();

    assert.equal(lookups, 0);
    assert.equal(warn.mock.callCount(), 0);
    assert.equal(log.mock.callCount(), 0);
  });

  it('never purges an id that was reinstalled before the store appeared', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const log = t.mock.method(console, 'log', () => {});
    const { store, calls } = recordingStore();
    let current: AgentPluginBindingStore | undefined;
    const installed = new Set<string>();
    const queue = createPendingBindingPurge({
      getStore: () => current,
      hasDatabase: true,
      isInstalled: (id) => installed.has(id),
    });
    queue.enqueue('reinstalled');
    queue.enqueue('gone');
    await queue.flush();

    // The operator reinstalls one of them while the orchestrator store is
    // still missing; the bindings it gets from here on are fresh consent.
    installed.add('reinstalled');
    current = store;
    await queue.flush();

    assert.deepEqual(calls, ['gone'], 'only the still-removed plugin is purged');
    assert.deepEqual([...queue.pending()], [], 'a skipped id is not retried');
    assert.ok(
      log.mock.calls.some((c) =>
        String(c.arguments[0]).includes('purge SKIPPED for reinstalled'),
      ),
    );
  });
});
