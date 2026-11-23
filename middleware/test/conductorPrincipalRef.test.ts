import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { channelUserPrincipal } from '@omadia/channel-sdk';

import { conductorPrincipalRef } from '../src/channels/coreApi.js';

/**
 * A people-directory entry and a turn meet on one Conductor binding key. Slack
 * lists people in the canonical principal form (`slack-user:<id>` or the
 * e-mail), so the turn registers the same form.
 */
describe('conductorPrincipalRef', () => {
  it('prefers a verified e-mail on every channel', () => {
    assert.equal(conductorPrincipalRef({ kind: 'slack-user', id: 'U1', email: 'anna@example.com' }), 'anna@example.com');
    assert.equal(conductorPrincipalRef({ kind: 'telegram-chat', id: '42', email: 'anna@example.com' }), 'anna@example.com');
  });

  it('gives a Slack user without e-mail the canonical form, matching the turn principal', () => {
    const ref = { kind: 'slack-user' as const, id: 'U1ABC' };
    assert.equal(conductorPrincipalRef(ref), 'slack-user:u1abc');
    assert.equal(`user:${conductorPrincipalRef(ref)}`, channelUserPrincipal(ref));
  });

  it('keeps the channel-native id for the other channels', () => {
    assert.equal(conductorPrincipalRef({ kind: 'teams-aad', id: 'aad-1' }), undefined);
    assert.equal(conductorPrincipalRef({ kind: 'telegram-chat', id: '42' }), undefined);
  });
});
