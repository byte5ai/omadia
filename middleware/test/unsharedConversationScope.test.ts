import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  formatSessionScope,
  parseSessionScope,
  unsharedConversationScope,
} from '@omadia/channel-sdk';

// #575 D7 — a channel turn must never land in a SHARED scope.
//
// Measured live producer (specs/575-scope-and-identity-foundation/spec.md §2.2):
// `omadia-byte5-plugins` channel-teams/src/teamsBot.ts:440-441 does
// `conversation?.id ?? 'unknown'` folded into `teams-${conversationId}`, so a
// Teams activity with no conversation id yields the literal `teams-unknown` —
// one bucket that every such caller shares, for conversation history AND for
// the knowledge-graph partition.
//
// This helper is the fix, and it lives here rather than in the plugin because
// the plugin repository has no test runner wired: the risky decision belongs
// where it can be proven.

const ACTIVITY = 'activity-1';

describe('#575 D7 unsharedConversationScope', () => {
  it('passes a real conversation scope through untouched, byte for byte', () => {
    // The wire form MUST NOT move — moving it moves the graph partition and
    // orphans that conversation's accumulated memory.
    for (const scope of [
      'teams-19:abc@thread.tacv2',
      'telegram:12345',
      'teams::19:abc@thread.tacv2',
      'my-chat-tab',
    ]) {
      const out = formatSessionScope(
        unsharedConversationScope({ scope, uniqueSuffix: ACTIVITY }),
      );
      assert.equal(out, scope, `scope moved: ${scope} -> ${out}`);
    }
  });

  it('replaces the shared teams-unknown bucket with a per-turn scope', () => {
    const out = formatSessionScope(
      unsharedConversationScope({ scope: 'teams-unknown', uniqueSuffix: ACTIVITY }),
    );
    assert.notEqual(out, 'teams-unknown');
    assert.ok(out.includes(ACTIVITY), `expected the unique suffix in ${out}`);
  });

  it('replaces every known shared token, not just the Teams one', () => {
    for (const shared of ['http-default', 'teams-unknown', 'unknown']) {
      const out = formatSessionScope(
        unsharedConversationScope({ scope: shared, uniqueSuffix: ACTIVITY }),
      );
      assert.notEqual(out, shared, `${shared} still shared`);
    }
  });

  it('replaces an absent scope too', () => {
    for (const scope of [undefined, '', '   ']) {
      const out = formatSessionScope(
        unsharedConversationScope({ scope, uniqueSuffix: ACTIVITY }),
      );
      assert.ok(out.length > 0, 'expected a concrete scope');
      assert.ok(out.includes(ACTIVITY));
    }
  });

  it('gives two different turns two different scopes — the whole point', () => {
    const a = formatSessionScope(
      unsharedConversationScope({ scope: 'teams-unknown', uniqueSuffix: 'act-a' }),
    );
    const b = formatSessionScope(
      unsharedConversationScope({ scope: 'teams-unknown', uniqueSuffix: 'act-b' }),
    );
    assert.notEqual(a, b);
  });

  it('is still unique when the channel supplies no id to key on', () => {
    const a = formatSessionScope(unsharedConversationScope({ scope: undefined }));
    const b = formatSessionScope(unsharedConversationScope({ scope: undefined }));
    assert.notEqual(a, b, 'two id-less turns must not share a scope');
  });

  it('produces a scope that parses back as an addressable conversation', () => {
    const out = formatSessionScope(
      unsharedConversationScope({ scope: 'teams-unknown', uniqueSuffix: ACTIVITY }),
    );
    const reparsed = parseSessionScope(out);
    assert.equal(reparsed.kind, 'conversation');
  });

  it('never hands back a machine scope disguised as a conversation', () => {
    // A routine scope reaching a channel ingress would be a routing bug; the
    // helper must not silently launder it into a conversation.
    const scope = unsharedConversationScope({ scope: 'routine:daily', uniqueSuffix: ACTIVITY });
    assert.equal(scope.kind, 'system');
  });
});
