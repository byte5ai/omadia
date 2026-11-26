import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { composeDisclosureText, stripKnownAiDisclosureLines } from '@omadia/channel-sdk';
import { turnChannelKind } from '@omadia/orchestrator';

/**
 * W16 — plugin channel turns carry their channel kind (#1994), and replayed
 * answers lose the AI-disclosure line (#2003).
 */

describe('turnChannelKind (#1994)', () => {
  const origin = (channelType: string) =>
    ({ channelType, scope: 'scope-1' }) as unknown as NonNullable<
      Parameters<typeof turnChannelKind>[0]['origin']
    >;

  it('prefers the minted channel identity', () => {
    assert.equal(
      turnChannelKind({
        channelIdentity: { channelKind: 'api', channelUserId: 'key:1' },
        origin: origin('telegram'),
      }),
      'api',
    );
  });

  it('falls back to the origin for plugin channel turns', () => {
    assert.equal(turnChannelKind({ origin: origin('telegram') }), 'telegram');
    assert.equal(turnChannelKind({ origin: origin('teams') }), 'teams');
  });

  it('is undefined for an unknown origin or none', () => {
    assert.equal(turnChannelKind({ origin: origin('http') }), undefined);
    assert.equal(turnChannelKind({}), undefined);
  });
});

describe('stripKnownAiDisclosureLines (#2003)', () => {
  const lines = [
    composeDisclosureText('de', 'standard'),
    composeDisclosureText('en', 'standard'),
    composeDisclosureText('de', 'standard', { assistantName: 'Karen' }),
    composeDisclosureText('en', 'standard', { assistantName: 'Karen Smith' }),
    composeDisclosureText('de', 'concise'),
    composeDisclosureText('en', 'concise'),
  ];

  for (const line of lines) {
    it(`strips "${line}" folded at the end`, () => {
      assert.equal(stripKnownAiDisclosureLines(`Hier ist die Antwort.\n\n${line}`), 'Hier ist die Antwort.');
    });
  }

  it('strips an italic line at the start and keeps the operator note', () => {
    const text = `_${lines[0]!}_\n\nAntwort.\n\nHinweis des Betreibers.`;
    assert.equal(stripKnownAiDisclosureLines(text), 'Antwort.\n\nHinweis des Betreibers.');
  });

  it('leaves prose that mentions AI untouched', () => {
    const text = 'An AI system generated this report for you, see below.';
    assert.equal(stripKnownAiDisclosureLines(text), text);
  });

  it('returns empty for an answer that was only the line', () => {
    assert.equal(stripKnownAiDisclosureLines(lines[1]!), '');
  });
});
