import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { InMemoryMemoryStore } from '@omadia/memory';
import { MemoryBinder, type ContextMemoryMode } from '@omadia/orchestrator';
import type { TurnOrigin } from '../packages/harness-channel-sdk/src/turnOrigin.js';
import { parseSessionScope } from '../packages/harness-channel-sdk/src/scopeId.js';

/**
 * Session transcripts under `enforce-strict`.
 *
 * `SessionLogger` writes every conversation's transcript into one flat tree,
 * `/memories/sessions/<scope>/<day>.md`, keyed by conversation and not by
 * context or agent. A context turn in strict mode could still read all of it
 * through the `memory` tool, because strict granted `ro:core` and `core`
 * includes the transcript trees. Strict now grants `ro:core-notes`: the shared
 * notes stay readable, the transcripts do not. `enforce` is unchanged.
 */

const TRANSCRIPT = '/memories/sessions/msteams__conv-kranich/2026-10-05.md';
const CHAT_SESSION = '/memories/chat-sessions/abc.json';
const NOTE = '/memories/core/glossary.md';

const telegram: TurnOrigin = {
  channelType: 'telegram',
  scope: parseSessionScope('telegram::-1009876543210'),
};

async function bound(mode: ContextMemoryMode): Promise<{
  view: (path: string) => Promise<string>;
}> {
  const root = new InMemoryMemoryStore();
  await root.createFile(TRANSCRIPT, 'Projekt Kranich hat ein Budget von 4,2 Mio Euro.');
  await root.createFile(CHAT_SESSION, '{"turns":["Kranich"]}');
  await root.createFile(NOTE, 'Kranich = interner Projektname');
  const handler = new MemoryBinder({ agentSlug: 'strict-agent', root, mode }).forOrigin(telegram).handler;
  return { view: (path) => handler.handle({ command: 'view', path }) };
}

describe('session transcripts and enforce-strict', () => {
  it('a strict context turn cannot read or list another conversation’s transcript', async () => {
    const { view } = await bound('enforce-strict');
    assert.doesNotMatch(await view(TRANSCRIPT), /4,2 Mio/);
    assert.doesNotMatch(await view('/memories/sessions'), /conv-kranich/);
    assert.doesNotMatch(await view(CHAT_SESSION), /Kranich/);
  });

  it('a strict context turn still reads the shared notes', async () => {
    const { view } = await bound('enforce-strict');
    assert.match(await view(NOTE), /interner Projektname/);
  });

  it('CONTROL: enforce (not strict) keeps reading the transcripts', async () => {
    const { view } = await bound('enforce');
    assert.match(await view(TRANSCRIPT), /4,2 Mio/);
  });
});
