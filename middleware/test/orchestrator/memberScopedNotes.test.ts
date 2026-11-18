/**
 * Member-scoped NOTES (W3): what an agent writes with the `memory` tool
 * belongs to the people present, exactly like the turn in the graph.
 *
 *   - The group's notes are its own tier: the same three people in another
 *     chat read them as their own.
 *   - Marcel alone, or Chris and Christian alone, read them — read-only, under
 *     `/memories/~g-<key>/`, because they are not theirs alone.
 *   - A newcomer's room, another agent and an unknown room never see them,
 *     and an unknown room can write nothing.
 *   - Purging a person removes every owner set they were part of.
 *
 * Real orchestrator turns; only the model is scripted. The model's next
 * request carries the tool result, so it shows what the model was given.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { purgeMemory } from '../../src/services/memoryPurge.js';
import {
  AGENT,
  CHRIS,
  CHRISTIAN,
  MARCEL,
  NEWBIE,
  OTHER_AGENT,
  answer,
  memoryCall,
  roster,
  teamsDm,
  teamsGroup,
  turn,
  world,
  type World,
} from './memberScopedWorld.js';

const NOTE = 'Zielkunde im Projekt Kranich ist die Hansa AG';
const INDEX_DIR = `/memories/contexts/${AGENT}/members-index`;

const sees = (requests: string[]): boolean => requests.some((r) => r.includes(NOTE));

/** Marcel, Chris and Christian in the group; the agent writes a note. */
async function groupNotes(w: World): Promise<string> {
  await turn(w, {
    from: MARCEL,
    origin: teamsGroup('conv-kranich'),
    scope: 'msteams::conv-kranich',
    text: 'Merk dir: Zielkunde ist die Hansa AG.',
    members: roster([MARCEL, CHRIS, CHRISTIAN]),
    script: [
      memoryCall({ command: 'create', path: '/memories/kranich.md', file_text: NOTE }),
      answer('Notiert.'),
    ],
  });
  return groupKey(w);
}

/** The group's tier key, read from the index the binder keeps. */
async function groupKey(w: World): Promise<string> {
  for (const entry of await w.root.list(INDEX_DIR)) {
    if (entry.isDirectory) continue;
    const owners = (JSON.parse(await w.root.readFile(entry.virtualPath)) as { owners: string[] }).owners;
    if (owners.length === 3) return /([a-f0-9]{32})\.json$/.exec(entry.virtualPath)![1]!;
  }
  throw new Error('the group owner set was not recorded');
}

const marcelAlone = (w: World, script: Parameters<typeof turn>[1]['script'], agent?: string) =>
  turn(w, {
    from: MARCEL,
    origin: teamsDm(MARCEL),
    scope: `msteams::dm-marcel-${agent ?? 'own'}`,
    text: 'Was weißt du zu Kranich?',
    script,
    ...(agent ? { agent } : {}),
  });

describe('member-scoped notes — whose notes reach which chat', () => {
  it('the same three people in another chat read the group’s notes as their own', async () => {
    const w = world();
    await groupNotes(w);
    const requests = await turn(w, {
      from: CHRIS,
      origin: teamsGroup('conv-kranich-2'),
      scope: 'msteams::conv-kranich-2',
      text: 'Kranich?',
      members: roster([CHRISTIAN, MARCEL, CHRIS]),
      script: [memoryCall({ command: 'view', path: '/memories/kranich.md' }), answer('Hansa.')],
    });
    assert.ok(sees(requests), 'the same owner set did not get its own notes');
  });

  it('Marcel alone sees the group’s notes under ~g-<key>, read-only', async () => {
    const w = world();
    const key = await groupNotes(w);
    const listing = await marcelAlone(w, [memoryCall({ command: 'view', path: '/memories' }), answer('.')]);
    assert.ok(listing.some((r) => r.includes(`/memories/~g-${key}`)), 'the group tier is not listed');

    const read = await marcelAlone(w, [
      memoryCall({ command: 'view', path: `/memories/~g-${key}/kranich.md` }),
      answer('Hansa.'),
    ]);
    assert.ok(sees(read), 'Marcel could not read the group’s note');

    await marcelAlone(w, [
      memoryCall({ command: 'create', path: `/memories/~g-${key}/marcel.md`, file_text: 'nur Marcel' }),
      answer('.'),
    ]);
    assert.equal(
      await w.root.fileExists(`/memories/contexts/${AGENT}/members/${key}/marcel.md`),
      false,
      'Marcel alone wrote into the tier he shares with Chris and Christian',
    );
  });

  it('Chris and Christian without Marcel read them', async () => {
    const w = world();
    const key = await groupNotes(w);
    const requests = await turn(w, {
      from: CHRIS,
      origin: teamsGroup('conv-chris-christian'),
      scope: 'msteams::conv-chris-christian',
      text: 'Kranich?',
      members: roster([CHRIS, CHRISTIAN]),
      script: [memoryCall({ command: 'view', path: `/memories/~g-${key}/kranich.md` }), answer('Hansa.')],
    });
    assert.ok(sees(requests), 'Chris and Christian did not get the notes they own');
  });

  it('a newcomer’s room sees neither the tier nor the note', async () => {
    const w = world();
    const key = await groupNotes(w);
    const requests = await turn(w, {
      from: MARCEL,
      origin: teamsGroup('conv-kranich'),
      scope: 'msteams::conv-kranich',
      text: 'Kranich?',
      members: roster([MARCEL, CHRIS, CHRISTIAN, NEWBIE]),
      script: [
        memoryCall({ command: 'view', path: '/memories' }),
        memoryCall({ command: 'view', path: '/memories/kranich.md' }),
        memoryCall({ command: 'view', path: `/memories/~g-${key}/kranich.md` }),
        answer('Nichts.'),
      ],
    });
    assert.ok(!sees(requests), 'the newcomer’s room received the group’s note');
    assert.ok(!requests.some((r) => r.includes(`~g-${key}`) && r.includes('directory')), 'the group tier was listed');
  });

  it('another agent never sees them', async () => {
    const w = world();
    const key = await groupNotes(w);
    const requests = await marcelAlone(
      w,
      [memoryCall({ command: 'view', path: `/memories/~g-${key}/kranich.md` }), answer('Nein.')],
      OTHER_AGENT,
    );
    assert.ok(!sees(requests), 'another agent read the group’s note');
  });

  it('an unknown room reads nothing and writes nothing', async () => {
    const w = world();
    const key = await groupNotes(w);
    const requests = await turn(w, {
      from: MARCEL,
      origin: teamsGroup('conv-kranich'),
      scope: 'msteams::conv-kranich',
      text: 'Kranich?',
      members: roster([MARCEL, CHRIS, CHRISTIAN], false),
      script: [
        memoryCall({ command: 'view', path: `/memories/~g-${key}/kranich.md` }),
        memoryCall({ command: 'create', path: '/memories/orphan.md', file_text: 'gehört niemandem' }),
        answer('Nichts.'),
      ],
    });
    assert.ok(!sees(requests), 'an unknown room read the group’s note');
    const written = (await w.root.list('/memories/contexts')).some((e) => e.virtualPath.endsWith('orphan.md'));
    assert.equal(written, false, 'an unknown room wrote a note nobody owns');
    assert.ok(
      requests[0]?.includes('nicht feststellen, wer anwesend ist'),
      'the unknown room was not told that notes are unavailable',
    );
  });

  it('purging one of the group removes every owner set they were part of', async () => {
    const w = world();
    const key = await groupNotes(w);
    const owners = (JSON.parse(await w.root.readFile(`${INDEX_DIR}/${key}.json`)) as { owners: string[] }).owners;
    const removed = await purgeMemory(w.root, 'user', owners[0]!);
    assert.ok(removed >= 2, `expected the tier and its index entry, removed ${String(removed)}`);
    assert.equal(await w.root.directoryExists(`/memories/contexts/${AGENT}/members/${key}`), false);
    assert.equal(await w.root.fileExists(`${INDEX_DIR}/${key}.json`), false);
  });
});
