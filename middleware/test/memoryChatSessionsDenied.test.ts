import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { InMemoryMemoryStore, MemoryToolHandler } from '@omadia/memory';
import { MemoryBinder, type ContextMemoryMode } from '@omadia/orchestrator';
import {
  MemoryPathDenied,
  OrchestratorMemoryNamespacer,
} from '../packages/harness-orchestrator/src/orchestratorMemoryNamespacer.js';
import type { TurnOrigin } from '../packages/harness-channel-sdk/src/turnOrigin.js';
import { parseSessionScope } from '../packages/harness-channel-sdk/src/scopeId.js';

/**
 * #1102 — `/memories/chat-sessions/<id>.json` is the web UI's copy of a chat,
 * including answers Privacy Shield rendered from a dataset: real rows that
 * never went to the model. `memory` is intern-exempt, so a `view` there handed
 * them to the model in clear — on the API path, and on the subscription CLI
 * once it got the tool. The memory tool must not reach that tree in any mode;
 * the kernel's own writers (ChatSessionStore) go around the namespacer.
 */

const CHAT = '/memories/chat-sessions/sess-1.json';
const RENDERED = '{"messages":[{"role":"assistant","content":"| Kunde | Offen |\\n| Müller GmbH | 12.400 € |","systemData":true}]}';
const TRANSCRIPT = '/memories/sessions/sess-1/2026-10-16.md';

const telegram: TurnOrigin = {
  channelType: 'telegram',
  scope: parseSessionScope('telegram::-1009876543210'),
};

async function seeded(): Promise<InMemoryMemoryStore> {
  const root = new InMemoryMemoryStore();
  await root.createFile(CHAT, RENDERED);
  await root.createFile(TRANSCRIPT, '**User:** offene Posten?');
  return root;
}

describe('memory tool and chat-sessions (#1102)', () => {
  it('the agent namespacer refuses every operation on chat-sessions', async () => {
    const nsr = new OrchestratorMemoryNamespacer('agent-a', await seeded());
    await assert.rejects(() => nsr.readFile(CHAT), MemoryPathDenied);
    await assert.rejects(() => nsr.list('/memories/chat-sessions'), MemoryPathDenied);
    await assert.rejects(() => nsr.fileExists(CHAT), MemoryPathDenied);
    await assert.rejects(() => nsr.writeFile(CHAT, '{}'), MemoryPathDenied);
    await assert.rejects(() => nsr.delete(CHAT), MemoryPathDenied);
    await assert.rejects(() => nsr.rename('/memories/x.md', CHAT), MemoryPathDenied);
  });

  it('a view through the memory tool returns an error, never the rendered rows', async () => {
    const handler = new MemoryToolHandler(
      new OrchestratorMemoryNamespacer('agent-a', await seeded()),
    );
    const viewed = await handler.handle({ command: 'view', path: CHAT });
    assert.match(viewed, /not available to the memory tool/);
    assert.doesNotMatch(viewed, /Müller/);
    const dir = await handler.handle({ command: 'view', path: '/memories/chat-sessions' });
    assert.doesNotMatch(dir, /sess-1/);
  });

  for (const mode of ['off', 'enforce', 'enforce-strict'] as const satisfies readonly ContextMemoryMode[]) {
    it(`no context-memory mode reaches chat-sessions (${mode})`, async () => {
      const handler = new MemoryBinder({ agentSlug: 'agent-a', root: await seeded(), mode })
        .forOrigin(telegram).handler;
      assert.doesNotMatch(await handler.handle({ command: 'view', path: CHAT }), /Müller/);
    });
  }

  it('CONTROL: session transcripts stay readable outside strict mode', async () => {
    const handler = new MemoryToolHandler(
      new OrchestratorMemoryNamespacer('agent-a', await seeded()),
    );
    assert.match(await handler.handle({ command: 'view', path: TRANSCRIPT }), /offene Posten/);
  });
});
