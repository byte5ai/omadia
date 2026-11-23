import { describe, expect, it } from 'vitest';

import { parseTeamsLink } from '../teamsInstallTarget';

/**
 * #2043 (D8): "Copy link" is what Teams hands people; nobody has a chat id at
 * hand. A pasted link becomes the install target it carries.
 */
describe('parseTeamsLink', () => {
  it('reads a chat, a message and a meeting link as their chat', () => {
    expect(
      parseTeamsLink('https://teams.microsoft.com/l/chat/19:9cdb0cd5c91049ad99667e30b0795de6@thread.v2/conversations?context=%7B%7D'),
    ).toEqual({ id: '19:9cdb0cd5c91049ad99667e30b0795de6@thread.v2', kind: 'group-chat' });
    expect(
      parseTeamsLink('https://teams.microsoft.com/l/message/19%3Aabc123%40thread.skype/1795012345678?tenantId=t'),
    ).toEqual({ id: '19:abc123@thread.skype', kind: 'group-chat' });
    expect(
      parseTeamsLink('https://teams.microsoft.com/l/meetup-join/19%3ameeting_Mzc1NTYtYWJj%40thread.v2/0?context=x'),
    ).toEqual({ id: '19:meeting_Mzc1NTYtYWJj@thread.v2', kind: 'group-chat' });
    expect(
      parseTeamsLink('https://teams.microsoft.com/l/chat/19:aaaa_bbbb@unq.gbl.spaces/conversations'),
    ).toEqual({ id: '19:aaaa_bbbb@unq.gbl.spaces', kind: 'one-on-one-chat' });
  });

  it('reads a team or channel link as the TEAM: an app is installed into a team, not a channel', () => {
    const team = { id: 'c6031502-025c-4297-92c6-b734e17e46c5', kind: 'team' };
    expect(
      parseTeamsLink(
        'https://teams.microsoft.com/l/channel/19%3a0a1b2c%40thread.tacv2/General?groupId=C6031502-025C-4297-92C6-B734E17E46C5&tenantId=t',
      ),
    ).toEqual(team);
    expect(
      parseTeamsLink('https://teams.microsoft.com/l/team/19%3a0a1b2c%40thread.tacv2/conversations?groupId=c6031502-025c-4297-92c6-b734e17e46c5'),
    ).toEqual(team);
    // A channel link without its team id names no target.
    expect(parseTeamsLink('https://teams.microsoft.com/l/channel/19%3a0a1b2c%40thread.tacv2/General')).toBeNull();
  });

  it('leaves everything else to the classifier: ids, other sites, broken links', () => {
    for (const input of [
      '19:abc@thread.v2',
      'c6031502-025c-4297-92c6-b734e17e46c5',
      'https://example.com/l/chat/19:abc@thread.v2/x',
      'https://teams.microsoft.com.evil.example/l/chat/19:abc@thread.v2/x',
      'https://teams.microsoft.com/v2/',
      'https://teams.microsoft.com/l/chat/%E0%A4%A/x',
      'https://teams.microsoft.com/l/app/abc',
      'not a link',
      '',
    ]) {
      expect(parseTeamsLink(input)).toBeNull();
    }
  });
});
