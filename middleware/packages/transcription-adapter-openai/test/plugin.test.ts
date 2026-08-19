import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { PluginContext } from '@omadia/plugin-api';
import {
  TRANSCRIPTION_METERING_SERVICE_NAME,
  type TranscriptionMeteringConfig,
  type TranscriptionService,
} from '@omadia/transcription-api';

import { TRANSCRIPTION_SERVICE_NAME, activate } from '../src/plugin.js';

/** Minimal fake of the four PluginContext members `activate` touches
 *  (secrets, config, services, log) — the rest is never dereferenced. */
function fakeContext(setup: {
  apiKey?: string;
  baseUrl?: string;
  maxSourceMinutes?: unknown;
}): {
  ctx: PluginContext;
  provided: Map<string, unknown>;
  logs: string[];
  setMaxSourceMinutes: (value: unknown) => void;
} {
  const provided = new Map<string, unknown>();
  const logs: string[] = [];
  let maxSourceMinutes = setup.maxSourceMinutes;
  const ctx = {
    secrets: {
      get: async (key: string): Promise<string | undefined> =>
        key === 'api_key' ? setup.apiKey : undefined,
    },
    config: {
      get: <T,>(key: string): T | undefined => {
        if (key === 'base_url') return setup.baseUrl as T | undefined;
        if (key === 'max_source_minutes') {
          return maxSourceMinutes as T | undefined;
        }
        return undefined;
      },
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
  return {
    ctx: ctx as unknown as PluginContext,
    provided,
    logs,
    setMaxSourceMinutes: (value: unknown) => {
      maxSourceMinutes = value;
    },
  };
}

describe('transcription-adapter-openai activate', () => {
  it('publishes the transcription service (both capability methods) plus the metering config', async () => {
    const { ctx, provided } = fakeContext({ apiKey: 'sk-test' });
    const handle = await activate(ctx);

    assert.equal(provided.size, 2);
    const service = provided.get(TRANSCRIPTION_SERVICE_NAME) as
      | TranscriptionService
      | undefined;
    assert.ok(service);
    assert.equal(typeof service.transcribeFile, 'function');
    assert.equal(typeof service.transcribeStream, 'function');
    assert.ok(provided.get(TRANSCRIPTION_METERING_SERVICE_NAME));

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

  describe('#584 — metering config (duration cap + billed model)', () => {
    async function metering(setup: {
      maxSourceMinutes?: unknown;
    }): Promise<{
      config: TranscriptionMeteringConfig;
      setMaxSourceMinutes: (value: unknown) => void;
    }> {
      const { ctx, provided, setMaxSourceMinutes } = fakeContext({
        apiKey: 'sk-test',
        ...setup,
      });
      await activate(ctx);
      const config = provided.get(
        TRANSCRIPTION_METERING_SERVICE_NAME,
      ) as TranscriptionMeteringConfig;
      assert.ok(config);
      return { config, setMaxSourceMinutes };
    }

    it('reads max_source_minutes LIVE — an operator edit applies to the next call', async () => {
      const { config, setMaxSourceMinutes } = await metering({
        maxSourceMinutes: 30,
      });
      assert.equal(config.maxSourceMinutes(), 30);
      setMaxSourceMinutes(15);
      assert.equal(config.maxSourceMinutes(), 15);
    });

    it('falls back to the default 60 on unset or invalid values', async () => {
      for (const bad of [undefined, 0, -5, 'viele', Number.NaN]) {
        const { config } = await metering({ maxSourceMinutes: bad });
        assert.equal(
          config.maxSourceMinutes(),
          60,
          `expected default for ${String(bad)}`,
        );
      }
    });

    it('names the billed model per surface (ledger pricing key)', async () => {
      const { config } = await metering({});
      assert.equal(config.model('file'), 'gpt-transcribe');
      assert.equal(config.model('stream'), 'gpt-live-transcribe');
    });
  });
});
