/**
 * ADR-0017 — the subscription-CLI path cannot mask, so while a privacy guard
 * runs every CLI turn is refused before anything is spawned, not only under
 * the org policy `OMADIA_PRIVACY_FORCE_GUARDED`.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  CLI_PRIVACY_GUARD_ACTIVE_LOG,
  CLI_PRIVACY_SHIELD_REQUIRED_ANSWER_DE,
  CliChatAgent,
} from '../packages/harness-orchestrator/src/cliChatAgent.js';
import type { ToolDispatchService } from '../packages/harness-orchestrator/src/toolDispatchService.js';

function agent(privacyGuarded: () => boolean) {
  const state = { spawned: 0, warned: [] as string[] };
  const cli = new CliChatAgent({
    dispatch: {} as unknown as ToolDispatchService,
    policyEnv: {},
    privacyGuarded,
    logger: { warn: (message: string) => state.warned.push(message), info: () => undefined, error: () => undefined } as never,
    spawnFn: (() => {
      state.spawned += 1;
      throw new Error('must not spawn');
    }) as never,
  });
  return { cli, state };
}

describe('CLI turn under an installed privacy guard', () => {
  it('is refused before any spawn and logs the guard as the cause', async () => {
    const { cli, state } = agent(() => true);
    const answer = await cli.chat({ userMessage: 'Wer ist Marc Demo?', sessionScope: 's-1' });
    assert.equal(answer.text, CLI_PRIVACY_SHIELD_REQUIRED_ANSWER_DE);
    const events = [];
    for await (const event of cli.chatStream({ userMessage: 'x', sessionScope: 's-1' })) events.push(event.type);
    assert.deepEqual(events, ['done']);
    assert.equal(state.spawned, 0);
    assert.ok(state.warned.includes(CLI_PRIVACY_GUARD_ACTIVE_LOG), state.warned.join('\n'));
  });

  it('fails closed when the guard check throws', async () => {
    const { cli, state } = agent(() => {
      throw new Error('registry gone');
    });
    const answer = await cli.chat({ userMessage: 'x', sessionScope: 's-2' });
    assert.equal(answer.text, CLI_PRIVACY_SHIELD_REQUIRED_ANSWER_DE);
    assert.equal(state.spawned, 0);
  });
});
