import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  CLI_ENV_SCRUB_KEYS,
  CliChatAgent,
  TurnSemaphore,
} from '../../packages/harness-orchestrator/src/cliChatAgent.js';
import type { CliChatAgentDeps } from '../../packages/harness-orchestrator/src/cliChatAgent.js';

const EXPECTED_SCRUB_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
] as const;

describe('CLI env scrubbing', () => {
  it('exports the complete canonical scrub-key list', () => {
    assert.deepEqual([...CLI_ENV_SCRUB_KEYS].sort(), [...EXPECTED_SCRUB_KEYS].sort());
  });

  it('CliChatAgent.buildEnv strips every scrubbed key and preserves unrelated env', () => {
    const rawEnv = Object.fromEntries(
      EXPECTED_SCRUB_KEYS.map((key) => [key, `${key.toLowerCase()}-secret`]),
    ) as NodeJS.ProcessEnv;
    rawEnv['MARKER'] = 'keep-me';

    const agent = new CliChatAgent({
      dispatch: {
        listDispatchableToolSpecs: () => [],
      } as CliChatAgentDeps['dispatch'],
      buildEnv: () => ({ ...rawEnv }),
    });

    const env = (agent as unknown as { buildEnv(): NodeJS.ProcessEnv }).buildEnv();
    for (const key of CLI_ENV_SCRUB_KEYS) {
      assert.equal(env[key], undefined, `${key} must be scrubbed`);
    }
    assert.equal(env['MARKER'], 'keep-me');
  });
});

describe('TurnSemaphore', () => {
  it('queues waiters in FIFO order and throws on over-release', async () => {
    const semaphore = new TurnSemaphore(2);
    await semaphore.acquire();
    await semaphore.acquire();

    const order: string[] = [];
    const thirdAcquire = semaphore.acquire().then(() => {
      order.push('third');
    });
    const fourthAcquire = semaphore.acquire().then(() => {
      order.push('fourth');
    });

    await Promise.resolve();
    assert.deepEqual(order, []);

    semaphore.release();
    await thirdAcquire;
    assert.deepEqual(order, ['third']);

    semaphore.release();
    await fourthAcquire;
    assert.deepEqual(order, ['third', 'fourth']);

    semaphore.release();
    semaphore.release();
    assert.throws(() => semaphore.release(), /matching acquire/);
  });
});
