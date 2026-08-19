import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { PluginContext } from '@omadia/plugin-api';

import { activate } from '../src/plugin.js';

/** Minimal fake of the PluginContext members `activate` touches (routes,
 *  tools, services, operatorAuth, log) — the rest is never dereferenced. */
function fakeContext(opts: { operatorAuth?: boolean }): {
  ctx: PluginContext;
  registered: Map<string, unknown>;
  registeredTools: string[];
  logs: string[];
} {
  const registered = new Map<string, unknown>();
  const registeredTools: string[] = [];
  const logs: string[] = [];
  const ctx = {
    routes: {
      register: (prefix: string, router: unknown): (() => void) => {
        if (registered.has(prefix)) {
          throw new Error(`duplicate route prefix '${prefix}'`);
        }
        registered.set(prefix, router);
        return () => {
          registered.delete(prefix);
        };
      },
    },
    tools: {
      register: (spec: { name: string }): (() => void) => {
        registeredTools.push(spec.name);
        return () => {
          const idx = registeredTools.indexOf(spec.name);
          if (idx >= 0) registeredTools.splice(idx, 1);
        };
      },
    },
    services: {
      get: (): undefined => undefined,
    },
    ...(opts.operatorAuth
      ? { operatorAuth: { hasValidSession: async (): Promise<boolean> => true } }
      : {}),
    log: (...args: unknown[]): void => {
      logs.push(args.map(String).join(' '));
    },
  };
  return { ctx: ctx as unknown as PluginContext, registered, registeredTools, logs };
}

describe('plugin-transcription activate', () => {
  it('mounts the upload router at /transcriptions and unmounts on close', async () => {
    const { ctx, registered } = fakeContext({ operatorAuth: true });
    const handle = await activate(ctx);

    assert.equal(registered.size, 1);
    assert.ok(registered.get('/transcriptions'), 'router registered under /transcriptions');

    await handle.close();
    assert.equal(registered.size, 0);
  });

  it('registers the transcribe_recording tool and disposes it on close', async () => {
    const { ctx, registeredTools } = fakeContext({ operatorAuth: true });
    const handle = await activate(ctx);

    assert.deepEqual(registeredTools, ['transcribe_recording']);

    await handle.close();
    assert.deepEqual(registeredTools, []);
  });

  it('activates without an operatorAuth accessor (router serves 503 fail-closed) and logs it loudly', async () => {
    const { ctx, registered, logs } = fakeContext({});
    const handle = await activate(ctx);

    assert.equal(registered.size, 1, 'the route still mounts — refusal happens per request');
    assert.ok(logs.some((line) => line.includes('fail-closed')));

    await handle.close();
  });
});
