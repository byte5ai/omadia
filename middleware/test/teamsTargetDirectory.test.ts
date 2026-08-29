/**
 * The target directory degrades; it never lies.
 *
 * THE ONE RULE UNDER TEST. An empty list and an unavailable list must not look
 * the same. `available: true, items: []` is a claim about the tenant ("you
 * have no teams"); `available: false` means we could not look. Collapsing the
 * two would send an operator hunting through a Teams admin centre for teams
 * that are right there.
 *
 * The second rule: the two halves degrade INDEPENDENTLY. `listTeams` is
 * app-only and essentially always works; `listChats` is delegated-only —
 * Graph publishes no tenant-wide application route for chats — and needs
 * `Chat.ReadBasic`, which a credential stored before connector 0.8.0 does not
 * carry and cannot pick up by refreshing. A missing chat scope must never be
 * able to hide the team list.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  loadTeamsTargetDirectory,
  type TeamsTargetDirectoryProvisioner,
} from '../src/services/teamsTargetDirectoryService.js';
import {
  isDelegatedScopeRequiredError,
  supportsChatListing,
  supportsTeamListing,
  teamsChatTargetKind,
} from '../src/platform/teamsTargetDirectory.js';
import { classifyTeamsInstallTarget } from '../src/platform/teamsInstallTarget.js';

const TEAM = { id: '2f1a9c44-1f0e-4f2c-8f1a-9c441f0e4f2c', displayName: 'Acme' };
const CHAT = {
  id: '19:a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6@thread.v2',
  topic: 'Support',
  chatType: 'group' as const,
};

const TOKENS = { accessToken: 'x' } as unknown as never;

function scopeError(): Error {
  return Object.assign(new Error('Chat.ReadBasic is missing'), {
    name: 'DelegatedScopeRequiredError',
    reason: 'scope-missing',
    missingScopes: ['Chat.ReadBasic'],
  });
}

function signInError(): Error {
  return Object.assign(new Error('sign in first'), {
    name: 'DelegatedSignInRequiredError',
  });
}

function directoryOf(
  provisioner: TeamsTargetDirectoryProvisioner | undefined,
  tokens: unknown = TOKENS,
): ReturnType<typeof loadTeamsTargetDirectory> {
  return loadTeamsTargetDirectory({
    getProvisioner: () => provisioner,
    delegatedTokens: { read: async () => tokens as never },
  });
}

describe('teams target directory — the happy path', () => {
  it('returns both listings when the connector can enumerate', async () => {
    const result = await directoryOf({
      listTeams: async () => [TEAM],
      listChats: async () => [CHAT],
    });

    assert.deepEqual(result.teams, { available: true, items: [TEAM] });
    assert.deepEqual(result.chats, { available: true, items: [CHAT] });
  });

  it('every listed id classifies UNAMBIGUOUSLY — the point of the whole feature', async () => {
    // The field test behind migration 0054 was a bare 32-hex id, which reads
    // as both a team group id and the stem of a chat id. Nothing that comes
    // out of this endpoint can be that string.
    const result = await directoryOf({
      listTeams: async () => [TEAM],
      listChats: async () => [CHAT],
    });

    assert.ok(result.teams.available && result.chats.available);
    assert.equal(classifyTeamsInstallTarget(result.teams.items[0]!.id).kind, 'team');
    assert.equal(classifyTeamsInstallTarget(result.chats.items[0]!.id).kind, 'group-chat');
  });

  it('passes the delegated token set to the chat listing', async () => {
    const seen: unknown[] = [];
    await directoryOf({
      listTeams: async () => [],
      listChats: async (input) => {
        seen.push(input);
        return [];
      },
    });

    assert.deepEqual(seen, [{ tokens: TOKENS }]);
  });

  it('an EMPTY tenant is available with no items — not unavailable', async () => {
    const result = await directoryOf({
      listTeams: async () => [],
      listChats: async () => [],
    });

    assert.deepEqual(result.teams, { available: true, items: [] });
    assert.deepEqual(result.chats, { available: true, items: [] });
  });
});

describe('teams target directory — degradation', () => {
  it('reports connector_unavailable for both halves with no connector', async () => {
    const result = await directoryOf(undefined);

    assert.deepEqual(result.teams, {
      available: false,
      reason: 'connector_unavailable',
    });
    assert.deepEqual(result.chats, {
      available: false,
      reason: 'connector_unavailable',
    });
  });

  it('reports connector_unsupported per method, not for the pair', async () => {
    // An older connector may publish one and not the other; each is detected
    // on its own so the half that works keeps working.
    const result = await directoryOf({ listTeams: async () => [TEAM] });

    assert.deepEqual(result.teams, { available: true, items: [TEAM] });
    assert.deepEqual(result.chats, {
      available: false,
      reason: 'connector_unsupported',
    });
  });

  it('a missing chat SCOPE never hides the team list', async () => {
    // The 0.8.0 case: someone IS signed in, with a credential that predates
    // `Chat.ReadBasic` and cannot obtain it by refreshing.
    const result = await directoryOf({
      listTeams: async () => [TEAM],
      listChats: async () => {
        throw scopeError();
      },
    });

    assert.deepEqual(result.teams, { available: true, items: [TEAM] });
    assert.deepEqual(result.chats, { available: false, reason: 'scope_missing' });
  });

  it('keeps scope_missing apart from sign_in_required', async () => {
    // They look identical to the code and completely different to the person:
    // one means "sign in", the other "you ARE signed in and it still is not
    // enough". A retry fixes neither, but only one of them is fixed by the
    // sign-in button the operator has already used once.
    const missing = await directoryOf({
      listTeams: async () => [],
      listChats: async () => {
        throw signInError();
      },
    });

    assert.deepEqual(missing.chats, { available: false, reason: 'sign_in_required' });
    assert.ok(isDelegatedScopeRequiredError(scopeError()));
    assert.ok(!isDelegatedScopeRequiredError(signInError()));
  });

  it('never turns a thrown listing into an empty one', async () => {
    // THE REGRESSION THIS FILE EXISTS FOR. `[]` here would tell the operator
    // their tenant has no teams.
    const result = await directoryOf({
      listTeams: async () => {
        throw new Error('graph exploded');
      },
      listChats: async () => {
        throw new Error('graph exploded');
      },
    });

    assert.equal(result.teams.available, false);
    assert.equal(result.chats.available, false);
    assert.equal(
      result.teams.available === false ? result.teams.reason : null,
      'lookup_failed',
    );
  });

  it('does not throw when the token read itself fails', async () => {
    const result = await loadTeamsTargetDirectory({
      getProvisioner: () => ({
        listTeams: async () => [TEAM],
        listChats: async () => [CHAT],
      }),
      delegatedTokens: {
        read: async () => {
          throw new Error('vault is down');
        },
      },
    });

    assert.deepEqual(result.teams, { available: true, items: [TEAM] });
  });
});

describe('teams target directory — the mirrored contract', () => {
  it('feature detection reads the object the call would go to', () => {
    assert.equal(supportsTeamListing(undefined), false);
    assert.equal(supportsChatListing({}), false);
    assert.equal(supportsTeamListing({ listTeams: async () => [] }), true);
    assert.equal(supportsChatListing({ listChats: async () => [] }), true);
  });

  it('maps Graph chat types onto the stored target kinds', () => {
    // A meeting chat installs through the same `POST /chats/{id}/installedApps`
    // as a group chat, and `target_kind` records WHICH ENDPOINT installed the
    // app — so inventing a fourth kind would widen a CHECK constraint to record
    // a distinction nothing branches on.
    assert.equal(teamsChatTargetKind('oneOnOne'), 'one-on-one-chat');
    assert.equal(teamsChatTargetKind('group'), 'group-chat');
    assert.equal(teamsChatTargetKind('meeting'), 'group-chat');
  });
});
