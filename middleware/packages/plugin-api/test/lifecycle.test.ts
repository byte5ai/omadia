/**
 * US1 — verifies the `@omadia/plugin-api` lifecycle contract: a
 * reference plugin type-checks against `Plugin`/`PluginScope` (the
 * compile is enforced by `tsconfig.test.json`) and survives the
 * mandatory init → dispose roundtrip without leaking process handles.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Disposable, PluginScope, ScopeLogger } from '../src/index.js';
import { referencePlugin, type ReferenceConfig } from './referencePlugin.js';

function testLogger(): ScopeLogger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function testScope(): PluginScope & { flush(): Promise<void> } {
  const disposables: Disposable[] = [];
  return {
    agentId: 'test-agent',
    pluginId: 'reference-plugin',
    services: {
      get<T>(capability: string): T {
        throw new Error(`capability not provided in test scope: ${capability}`);
      },
      has: () => false,
    },
    logger: testLogger(),
    registerDisposable(d: Disposable): void {
      disposables.push(d);
    },
    async flush(): Promise<void> {
      for (const d of disposables.reverse()) await d.dispose();
      disposables.length = 0;
    },
  };
}

const testConfig = (): ReferenceConfig => ({ greeting: 'hi' });

function activeHandleCount(): number {
  return (
    process as unknown as { _getActiveHandles(): unknown[] }
  )._getActiveHandles().length;
}

test('reference plugin exposes the Plugin contract surface', () => {
  assert.equal(typeof referencePlugin.init, 'function');
  assert.equal(typeof referencePlugin.dispose, 'function');
  assert.equal(typeof referencePlugin.reconfigure, 'function');
  assert.equal(referencePlugin.manifest.id, 'reference-plugin');
});

test('survives init → dispose → init → dispose without leaking handles', async () => {
  const before = activeHandleCount();
  for (let i = 0; i < 3; i++) {
    const scope = testScope();
    const handle = await referencePlugin.init(scope, testConfig());
    await referencePlugin.dispose(handle);
    await scope.flush();
  }
  assert.equal(activeHandleCount(), before);
});

test('reconfigure returns an updated handle without a full dispose cycle', async () => {
  const reconfigure = referencePlugin.reconfigure;
  assert.ok(reconfigure, 'reference plugin provides reconfigure');

  const scope = testScope();
  const handle = await referencePlugin.init(scope, { greeting: 'one' });
  assert.equal(handle.greeting, 'one');

  const next = await reconfigure(handle, { greeting: 'two' });
  assert.equal(next.greeting, 'two');

  await referencePlugin.dispose(next);
  await scope.flush();
});
