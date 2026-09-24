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
import type { DelegatedTokenSet } from '../src/platform/teamsDelegatedSignIn.js';
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

/**
 * The connector's verdict on a token it will not use.
 *
 * `recoverableByRefresh` is the WHOLE distinction this file cares about: true
 * means a machine fixes it, false means a human does. Reporting the first one
 * as "sign in" is the bug the suite below exists for.
 */
function expiredError(recoverable = true): Error {
  return Object.assign(new Error('access token expired'), {
    name: 'DelegatedTokenExpiredError',
    reason: recoverable ? 'access-token-expired' : 'refresh-token-invalid',
    recoverableByRefresh: recoverable,
  });
}

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-08-31T12:00:00.000Z');

function tokenSet(expiresAt: Date, accessToken = 'access-1'): DelegatedTokenSet {
  return {
    accessToken,
    refreshToken: 'refresh-1',
    expiresAt: expiresAt.toISOString(),
    scopes: ['AppCatalog.ReadWrite.All'],
    clientId: 'client-1',
    tenantId: 'tenant-1',
  };
}

/** A live token: an hour of life left, well outside the refresh margin. */
const FRESH = tokenSet(new Date(NOW.getTime() + HOUR));
/** The field-test token: issued long ago, spent. */
const SPENT = tokenSet(new Date(NOW.getTime() - HOUR));

interface RefreshingCustody {
  read(): Promise<DelegatedTokenSet | undefined>;
  write(tokens: DelegatedTokenSet): Promise<void>;
  readonly written: DelegatedTokenSet[];
  readonly refreshes: DelegatedTokenSet[];
}

/**
 * A tenant sign-in with a working vault behind it, plus the connector's
 * `refreshDelegatedToken`.
 *
 * Modelled rather than scripted: the refresh really does hand back a new
 * access token with a new expiry, so a test can assert that the SECOND call
 * carried the rotated value instead of replaying the spent one.
 */
function refreshingSetup(opts: {
  readonly stored?: DelegatedTokenSet;
  readonly refresh?: (tokens: DelegatedTokenSet) => Promise<DelegatedTokenSet>;
} = {}): {
  readonly custody: RefreshingCustody;
  readonly refreshDelegatedToken: (input: {
    readonly tokens: DelegatedTokenSet;
  }) => Promise<DelegatedTokenSet>;
} {
  let stored: DelegatedTokenSet | undefined = opts.stored ?? SPENT;
  const written: DelegatedTokenSet[] = [];
  const refreshes: DelegatedTokenSet[] = [];
  const custody: RefreshingCustody = {
    read: async () => stored,
    write: async (tokens) => {
      written.push(tokens);
      stored = tokens;
    },
    written,
    refreshes,
  };
  const refreshDelegatedToken = async ({
    tokens,
  }: {
    readonly tokens: DelegatedTokenSet;
  }): Promise<DelegatedTokenSet> => {
    refreshes.push(tokens);
    if (opts.refresh) return opts.refresh(tokens);
    return tokenSet(new Date(NOW.getTime() + HOUR), 'access-2');
  };
  return { custody, refreshDelegatedToken };
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

/**
 * THE FIELD-TEST BUG. An operator whose tenant sign-in stood, whose account
 * was on screen, and whose chat picker said "sign in once".
 *
 * The chain that produced it: the stored access token was hours past its
 * expiry, so the connector refused the enumeration on the token alone and
 * never reached its own scope check; this service classified that refusal as
 * `sign_in_required`; and the UI rendered the one sentence that could not
 * possibly help — sign in, to someone already signed in.
 *
 * Two rules come out of it, and every test here pins one of them:
 *
 *   1. AN EXPIRED ACCESS TOKEN IS NOT A MISSING SIGN-IN. It is one silent
 *      refresh away from working, and the listing now performs that refresh
 *      itself — the same refresh the catalogue upload has always done.
 *   2. `sign_in_required` NOW MEANS EXACTLY ONE THING: nobody is signed in.
 *      An expiry whose refresh failed is `sign_in_expired`, which sends the
 *      operator to the same button for a reason worth knowing.
 */
describe('teams target directory — an expired sign-in is not a missing one', () => {
  it('refreshes a spent access token instead of reporting it as signed out', async () => {
    // RED BEFORE THE FIX: `isDelegatedTokenExpiredError` mapped straight to
    // `sign_in_required` and the listing never even tried to refresh.
    const { custody, refreshDelegatedToken } = refreshingSetup();
    const seen: unknown[] = [];

    const result = await loadTeamsTargetDirectory({
      now: () => NOW,
      getProvisioner: () => ({
        listTeams: async () => [TEAM],
        listChats: async (input?: { tokens?: unknown }) => {
          seen.push((input?.tokens as { accessToken?: string } | undefined)?.accessToken);
          return [CHAT];
        },
        refreshDelegatedToken,
      }),
      delegatedTokens: custody,
    });

    assert.deepEqual(result.chats, { available: true, items: [CHAT] });
    // The ROTATED token went to Graph, not the spent one it replaced.
    assert.deepEqual(seen, ['access-2']);
  });

  it('persists the rotated set the moment the connector hands it over', async () => {
    // A rotation the vault has not seen is a refresh token already spent —
    // the tenant would be silently signed out on the next restart.
    const { custody, refreshDelegatedToken } = refreshingSetup();

    await loadTeamsTargetDirectory({
      now: () => NOW,
      getProvisioner: () => ({
        listTeams: async () => [TEAM],
        listChats: async () => [CHAT],
        refreshDelegatedToken,
      }),
      delegatedTokens: custody,
    });

    assert.equal(custody.written.length, 1);
    assert.equal(
      (custody.written[0] as { accessToken: string }).accessToken,
      'access-2',
    );
  });

  it('recovers from the connector`s own expiry verdict, not just from our clock', async () => {
    // The reactive half: our clock said the token was fine, Microsoft
    // disagreed. That verdict is the authoritative one — a revoked session or
    // a password change is invisible to any expiry arithmetic.
    const { custody, refreshDelegatedToken } = refreshingSetup({ stored: FRESH });
    let attempts = 0;

    const result = await loadTeamsTargetDirectory({
      now: () => NOW,
      getProvisioner: () => ({
        listTeams: async () => [TEAM],
        listChats: async () => {
          attempts += 1;
          if (attempts === 1) throw expiredError();
          return [CHAT];
        },
        refreshDelegatedToken,
      }),
      delegatedTokens: custody,
    });

    assert.deepEqual(result.chats, { available: true, items: [CHAT] });
    assert.equal(attempts, 2, 'retried exactly once');
  });

  it('reports sign_in_expired — never sign_in_required — when the refresh fails', async () => {
    // The admin really does have to sign in again here, but for a DIFFERENT
    // reason than "you never signed in", and the copy has to be able to say
    // which. Note the refresh fails with untyped prose (`invalid_grant`), and
    // it must still not degrade into `lookup_failed` and a retry button.
    const { custody, refreshDelegatedToken } = refreshingSetup({
      stored: FRESH,
      refresh: async () => {
        throw new Error('invalid_grant');
      },
    });

    const result = await loadTeamsTargetDirectory({
      now: () => NOW,
      getProvisioner: () => ({
        listTeams: async () => [TEAM],
        listChats: async () => {
          throw expiredError();
        },
        refreshDelegatedToken,
      }),
      delegatedTokens: custody,
    });

    assert.deepEqual(result.chats, { available: false, reason: 'sign_in_expired' });
    // And the half that never needed the sign-in is untouched.
    assert.deepEqual(result.teams, { available: true, items: [TEAM] });
  });

  it('an expiry the connector calls unrecoverable is not retried', async () => {
    const { custody, refreshDelegatedToken } = refreshingSetup({ stored: FRESH });
    let attempts = 0;

    const result = await loadTeamsTargetDirectory({
      now: () => NOW,
      getProvisioner: () => ({
        listTeams: async () => [TEAM],
        listChats: async () => {
          attempts += 1;
          throw expiredError(false);
        },
        refreshDelegatedToken,
      }),
      delegatedTokens: custody,
    });

    assert.deepEqual(result.chats, { available: false, reason: 'sign_in_expired' });
    assert.equal(attempts, 1);
    assert.equal(custody.refreshes.length, 0, 'a dead refresh token is not spent again');
  });

  it('THE FIELD-TEST CASE: a spent token that also predates the scope says scope_missing', async () => {
    // RED BEFORE THE FIX, and this is the one the operator actually hit.
    //
    // Both faults are present at once: the access token is hours stale AND
    // the credential predates `Chat.ReadBasic` (connector 0.8.0). The
    // connector checks the token before it checks what the token is allowed
    // to do, so the expiry is the only error that was ever thrown — the
    // scope branch of `classifyListingFailure` was unreachable, however
    // correctly it was ordered.
    //
    // Refreshing first is what makes the SECOND fault observable: with a
    // valid access token the connector gets far enough to notice the missing
    // scope, and the operator is finally told the true thing.
    const { custody, refreshDelegatedToken } = refreshingSetup();
    let attempts = 0;

    const result = await loadTeamsTargetDirectory({
      now: () => NOW,
      getProvisioner: () => ({
        listTeams: async () => [TEAM],
        listChats: async (input?: { tokens?: { accessToken?: string } }) => {
          attempts += 1;
          // Exactly the connector's order: a token it cannot authenticate
          // with is refused before its scopes are ever considered.
          if (input?.tokens?.accessToken !== 'access-2') throw expiredError();
          throw scopeError();
        },
        refreshDelegatedToken,
      }),
      delegatedTokens: custody,
    });

    assert.deepEqual(result.chats, { available: false, reason: 'scope_missing' });
    assert.equal(attempts, 1, 'the proactive refresh spared the wasted call');
    assert.deepEqual(result.teams, { available: true, items: [TEAM] });
  });

  it('still says sign_in_required when there is genuinely no sign-in', async () => {
    // The narrowing must not go so far that the real thing loses its name.
    const result = await loadTeamsTargetDirectory({
      now: () => NOW,
      getProvisioner: () => ({
        listTeams: async () => [TEAM],
        listChats: async () => {
          throw signInError();
        },
      }),
      delegatedTokens: { read: async () => undefined, write: async () => {} },
    });

    assert.deepEqual(result.chats, { available: false, reason: 'sign_in_required' });
  });

  it('NEVER refreshes without somewhere to persist the result', async () => {
    // The safety rule of `platform/teamsDelegatedRefresh.ts`: a rotation the
    // vault cannot record spends the refresh token for good. Not refreshing
    // costs one bad sentence; refreshing without custody costs the tenant its
    // sign-in.
    let refreshed = 0;

    const result = await loadTeamsTargetDirectory({
      now: () => NOW,
      getProvisioner: () => ({
        listTeams: async () => [TEAM],
        listChats: async () => {
          throw expiredError();
        },
        refreshDelegatedToken: async () => {
          refreshed += 1;
          return FRESH as never;
        },
      }),
      // READ ONLY — a pre-#949 mount, and the shape the old tests still use.
      delegatedTokens: { read: async () => SPENT as never },
    });

    assert.equal(refreshed, 0);
    assert.deepEqual(result.chats, { available: false, reason: 'sign_in_expired' });
  });

  it('a healthy token is left alone — no rotation on every poll', async () => {
    // This screen polls. Refreshing a token with an hour of life left would
    // rotate the refresh token continuously for no reason.
    const { custody, refreshDelegatedToken } = refreshingSetup({ stored: FRESH });

    await loadTeamsTargetDirectory({
      now: () => NOW,
      getProvisioner: () => ({
        listTeams: async () => [TEAM],
        listChats: async () => [CHAT],
        refreshDelegatedToken,
      }),
      delegatedTokens: custody,
    });

    assert.equal(custody.refreshes.length, 0);
    assert.equal(custody.written.length, 0);
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
