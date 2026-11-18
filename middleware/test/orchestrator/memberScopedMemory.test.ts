/**
 * Member-scoped memory (`members` context memory), end to end.
 *
 * The rule Marcel set: knowledge belongs to the people present when it came
 * up; a chat may use it when everyone present is one of them.
 *
 *   - Marcel, Chris and Christian build knowledge in a group →
 *     Marcel alone with the agent has it.
 *   - Someone new joins the group → while they are present, it stays out.
 *   - Chris and Christian without Marcel → they have it.
 *   - Person-based, not channel-based: Teams group → Marcel's Telegram DM has
 *     it, once his Telegram identity is linked to the same person.
 *   - Agents keep their own knowledge: another agent never has it.
 *   - A group whose member list is not known complete gets none, and what it
 *     says belongs to nobody.
 *
 * Every test runs real orchestrator turns — binder, session logger, graph,
 * recall assembler and graph tool are the production classes, only the model
 * is scripted — and reads what actually reached the model.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  CHRIS,
  CHRISTIAN,
  MARCEL,
  NEWBIE,
  OTHER_AGENT,
  QUESTION,
  SECRET,
  answer,
  groupLearns,
  kgSearch,
  roster,
  teamsDm,
  teamsGroup,
  turn,
  world,
} from './memberScopedWorld.js';

const sees = (requests: string[]): boolean => requests.some((r) => r.includes(SECRET));

describe('member-scoped memory — whose knowledge reaches which chat', () => {
  it('the group turn is stored with its three owners', async () => {
    const w = world();
    await groupLearns(w);
    const [hit] = await w.graph.searchTurns({ query: QUESTION, limit: 5 });
    assert.ok(hit, 'the group turn was not stored');
    const session = await w.graph.getSession(hit.scope);
    const owners = session?.turns[0]?.turn.props['owners'] as string[] | undefined;
    assert.equal(owners?.length, 3, `owners: ${JSON.stringify(owners)}`);
  });

  it('Marcel alone with the agent has the group knowledge', async () => {
    const w = world();
    await groupLearns(w);
    const requests = await turn(w, {
      from: MARCEL,
      origin: teamsDm(MARCEL),
      scope: 'msteams::dm-marcel',
      text: QUESTION,
      script: [answer('Ja.')],
    });
    assert.ok(sees(requests), 'the group knowledge did not reach Marcel’s direct chat');
  });

  it('a new member in the group: the knowledge stays out while they are present', async () => {
    const w = world();
    await groupLearns(w);
    const requests = await turn(w, {
      from: MARCEL,
      origin: teamsGroup('conv-kranich'),
      scope: 'msteams::conv-kranich',
      text: QUESTION,
      members: roster([MARCEL, CHRIS, CHRISTIAN, NEWBIE]),
      script: [kgSearch(), answer('Dazu habe ich nichts.')],
    });
    assert.ok(!sees(requests), 'the new member’s room received the group knowledge (tail, recall or graph tool)');
  });

  it('Chris and Christian without Marcel have it', async () => {
    const w = world();
    await groupLearns(w);
    const requests = await turn(w, {
      from: CHRIS,
      origin: teamsGroup('conv-chris-christian'),
      scope: 'msteams::conv-chris-christian',
      text: QUESTION,
      members: roster([CHRIS, CHRISTIAN]),
      script: [answer('Ja.')],
    });
    assert.ok(sees(requests), 'Chris and Christian did not get the knowledge they own');
  });

  it('it is person-based: Marcel’s linked Telegram DM has it', async () => {
    const w = world();
    // Marcel's Teams and Telegram identities are known to be the same person
    // (verified email on both) — the cluster merge the identity layer does.
    await w.graph.resolveOrCreateChannelIdentity({
      channelKind: 'teams',
      channelUserId: MARCEL.aad,
      aadObjectId: MARCEL.aad,
      email: 'marcel@example.com',
      emailVerified: true,
    });
    await w.graph.resolveOrCreateChannelIdentity({
      channelKind: 'telegram',
      channelUserId: 'telegram:4711',
      email: 'marcel@example.com',
      emailVerified: true,
    });
    await groupLearns(w);
    const requests = await turn(w, {
      from: MARCEL,
      userId: 'telegram:4711',
      origin: { channelType: 'telegram', scope: { kind: 'personal', userId: '4711' } },
      scope: 'telegram::4711',
      text: QUESTION,
      script: [answer('Ja.')],
    });
    assert.ok(sees(requests), 'the Teams group knowledge did not reach the same person on Telegram');
  });

  it('another agent never has it', async () => {
    const w = world();
    await groupLearns(w);
    const requests = await turn(w, {
      from: MARCEL,
      agent: OTHER_AGENT,
      origin: teamsDm(MARCEL),
      scope: 'msteams::dm-marcel-other',
      text: QUESTION,
      script: [kgSearch(), answer('Nein.')],
    });
    assert.ok(!sees(requests), 'another agent received the group knowledge');
  });

  it('a group without a complete member list gets nothing, and owns nothing', async () => {
    const w = world();
    await groupLearns(w);
    const requests = await turn(w, {
      from: MARCEL,
      origin: teamsGroup('conv-kranich'),
      scope: 'msteams::conv-kranich',
      text: QUESTION,
      members: roster([MARCEL, CHRIS, CHRISTIAN], false),
      script: [kgSearch(), answer('Nichts.')],
    });
    assert.ok(!sees(requests), 'an unknown room received member-scoped knowledge');
    // The group's graph scope, as the session logger wrote it (sanitised).
    const [group] = await w.graph.listSessions();
    const session = group ? await w.graph.getSession(group.scope) : null;
    const last = session?.turns.at(-1)?.turn.props['owners'];
    assert.deepEqual(last, [], 'a turn from an unknown room must be owned by nobody');
  });
});
