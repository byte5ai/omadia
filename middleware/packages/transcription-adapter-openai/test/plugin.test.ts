import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { PluginContext } from '@omadia/plugin-api';
import type { TranscriptionService } from '@omadia/transcription-api';

import { TRANSCRIPTION_SERVICE_NAME, activate } from '../src/plugin.js';

/** Minimal fake of the four PluginContext members `activate` touches
 *  (secrets, config, services, log) — the rest is never dereferenced. */
function fakeContext(setup: { apiKey?: string; baseUrl?: string }): {
  ctx: PluginContext;
  provided: Map<string, unknown>;
  logs: string[];
} {
  const provided = new Map<string, unknown>();
  const logs: string[] = [];
  const ctx = {
    secrets: {
      get: async (key: string): Promise<string | undefined> =>
        key === 'api_key' ? setup.apiKey : undefined,
    },
    config: {
      get: <T,>(key: string): T | undefined =>
        key === 'base_url' ? (setup.baseUrl as T | undefined) : undefined,
    },
    services: {
      provide: (name: string, impl: unknown): (() => void) => {
        if (provided.has(name)) {
          throw new Error(`duplicate provider for '${name}'`);
        }
        provided.set(name, impl);
        return () => {
          provided.delete(name);
        };
      },
    },
    log: (...args: unknown[]): void => {
      logs.push(args.map(String).join(' '));
    },
  };
  return { ctx: ctx as unknown as PluginContext, provided, logs };
}

describe('transcription-adapter-openai activate', () => {
  it('publishes one transcription service with both capability methods', async () => {
    const { ctx, provided } = fakeContext({ apiKey: 'sk-test' });
    const handle = await activate(ctx);

    assert.equal(provided.size, 1);
    const service = provided.get(TRANSCRIPTION_SERVICE_NAME) as
      | TranscriptionService
      | undefined;
    assert.ok(service);
    assert.equal(typeof service.transcribeFile, 'function');
    assert.equal(typeof service.transcribeStream, 'function');

    await handle.close();
    assert.equal(provided.size, 0);
  });

  it('activates without an api_key but publishes nothing (degrade, no boot failure)', async () => {
    const { ctx, provided, logs } = fakeContext({});
    const handle = await activate(ctx);

    assert.equal(provided.size, 0);
    assert.ok(logs.some((line) => line.includes('no api_key')));

    await handle.close();
  });

  it('treats a whitespace-only api_key as absent', async () => {
    const { ctx, provided } = fakeContext({ apiKey: '   ' });
    await activate(ctx);
    assert.equal(provided.size, 0);
  });
});
