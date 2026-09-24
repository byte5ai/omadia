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
  // #1014 — `NODE_OPTIONS` can `--require` arbitrary code into the child, so
  // it belongs with the credentials rather than with the harmless env.
  'NODE_OPTIONS',
] as const;

describe('CLI env scrubbing', () => {
  it('exports the complete canonical scrub-key list', () => {
    assert.deepEqual([...CLI_ENV_SCRUB_KEYS].sort(), [...EXPECTED_SCRUB_KEYS].sort());
  });

  /**
   * #1014 — the policy changed from "remove the dangerous names" to "keep only
   * the needed ones", so an unrelated variable no longer survives into the
   * child. That is the point: the deny list could only ever remove what
   * somebody had thought of, and it had not thought of `NODE_OPTIONS`.
   *
   * This test used to assert the opposite (`MARKER` survives). It is inverted
   * deliberately, not relaxed: the scrub keys must still all be gone, and now
   * everything outside the allowlist must be gone too.
   */
  it('CliChatAgent.buildEnv keeps only allowlisted env, scrub keys included', () => {
    const rawEnv = Object.fromEntries(
      EXPECTED_SCRUB_KEYS.map((key) => [key, `${key.toLowerCase()}-secret`]),
    ) as NodeJS.ProcessEnv;
    rawEnv['MARKER'] = 'keep-me';
    rawEnv['PATH'] = '/usr/bin';
    rawEnv['CLAUDE_CONFIG_DIR'] = '/Users/tester/.claude';

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
    // Not allowlisted, so not passed on — even though it is harmless.
    assert.equal(env['MARKER'], undefined, 'a non-allowlisted var must not reach the child');
    // Allowlisted, because the CLI cannot run or authenticate without them.
    assert.equal(env['PATH'], '/usr/bin');
    assert.equal(env['CLAUDE_CONFIG_DIR'], '/Users/tester/.claude');
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
