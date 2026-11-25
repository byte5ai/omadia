import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { ChatTurnInput } from '@omadia/channel-sdk';

import { RealStepEffects } from '../src/conductor/realStepEffects.js';

// #2217 / ADR 0043 — a draft preview runs an agent step as a real turn without
// tools, so a guard on the agent's answer routes as it would live. Nobody in
// a chat sees the rehearsal: no say, no typing indicator, no transcript.

function harness() {
  const turns: ChatTurnInput[] = [];
  const said: unknown[] = [];
  let typingStarted = 0;
  const effects = new RealStepEffects({
    getRegistry: () =>
      ({
        get: () => ({
          built: {
            bundle: {
              agent: {
                chat: async (input: ChatTurnInput) => {
                  turns.push(input);
                  return { text: 'Passt.\n\n```json\n{"ok": true}\n```' };
                },
              },
            },
          },
        }),
      }) as never,
    say: {
      say: async (payload: unknown) => {
        said.push(payload);
        return { said: true };
      },
      startTyping: () => {
        typingStarted += 1;
        return () => undefined;
      },
    } as never,
  });
  return { effects, turns, said, typing: () => typingStarted };
}

const sayStep = {
  id: 'speak',
  kind: 'agent' as const,
  agentId: 'hr',
  prompt: 'p',
  say: { channel: 'teams' },
};

describe('RealStepEffects — preview turns (#2217)', () => {
  it('runs the turn without tools and without a session scope', async () => {
    const { effects, turns } = harness();
    await effects.runAgentStep(sayStep, { conversationId: 'conv-1' }, { runId: 'preview:wf', preview: true });
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.toolsOff, true);
    assert.equal(turns[0]?.sessionScope, undefined, 'a preview turn leaves no transcript row');
  });

  it('keeps the structured verdict, so guards route as live', async () => {
    const { effects } = harness();
    const exec = await effects.runAgentStep(sayStep, { conversationId: 'conv-1' }, { runId: 'preview:wf', preview: true });
    const result = exec.result as Record<string, unknown>;
    assert.deepEqual(result.data, { ok: true });
    assert.equal(result.previewed, true);
  });

  it('neither publishes nor shows typing, and says so in the result', async () => {
    const { effects, said, typing } = harness();
    const exec = await effects.runAgentStep(sayStep, { conversationId: 'conv-1' }, { runId: 'preview:wf', preview: true });
    assert.deepEqual(said, []);
    assert.equal(typing(), 0);
    const result = exec.result as Record<string, unknown>;
    assert.equal(result.say, 'skipped_in_preview');
    assert.equal('said' in result, false);
  });

  it('leaves a live step as it was: tools on, session scope, published', async () => {
    const { effects, turns, said, typing } = harness();
    const exec = await effects.runAgentStep(sayStep, { conversationId: 'conv-1' }, { runId: 'run-1', workflowId: 'wf-1' });
    assert.equal(turns[0]?.toolsOff, undefined);
    assert.equal(turns[0]?.sessionScope, 'conductor:run-1:speak');
    assert.equal(said.length, 1);
    assert.equal(typing(), 1);
    const result = exec.result as Record<string, unknown>;
    assert.equal(result.said, true);
    assert.equal('previewed' in result, false);
  });
});
