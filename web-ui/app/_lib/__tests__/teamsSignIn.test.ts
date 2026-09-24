import { describe, expect, it } from 'vitest';

import { ApiError } from '../api';
import {
  parsePendingFlow,
  parsePollResult,
  parseSignInState,
  parseSignInStatus,
  parseTeamsSignInErrorCode,
  secondsRemaining,
  SIGNED_OUT_VIEW,
} from '../teamsSignIn';

/**
 * The client boundary of the tenant Teams sign-in (byte5ai/omadia#924).
 *
 * These parsers sit between a middleware that may be older or newer than this
 * build and a panel an operator opens precisely when something is wrong. So
 * the contract they owe is TOTALITY: no input takes the page down, and the
 * fallback for every unreadable shape is the one that cannot mislead.
 *
 * Two of the assertions here are not shape checks but POLICY:
 *
 *   - SIGNED OUT IS THE SAFE DEFAULT. Claiming a sign-in that does not exist
 *     would leave an operator waiting for provisioning that will never move.
 *     Offering a sign-in button to someone already signed in costs one click.
 *   - `accessTokenStale` SURVIVES PARSING AS ITS OWN FIELD, separate from
 *     `signedIn`. Collapsing the two would turn a self-healing condition into
 *     a signed-out state and send an operator to re-authenticate for nothing.
 */

describe('parseSignInState', () => {
  it('projects a full state', () => {
    const state = parseSignInState({
      signedIn: true,
      signedInAt: '2026-08-01T09:00:00.000Z',
      expiresAt: '2026-08-28T18:00:00.000Z',
      accessTokenStale: false,
      scopes: ['AppCatalog.Submit'],
      tenantId: 'tenant-1',
      clientId: 'client-1',
      account: { username: 'admin@contoso.test', displayName: 'Ada Admin' },
    });
    expect(state.signedIn).toBe(true);
    expect(state.account?.displayName).toBe('Ada Admin');
    expect(state.scopes).toEqual(['AppCatalog.Submit']);
  });

  it('falls back to SIGNED OUT for anything it cannot read', () => {
    for (const value of [null, undefined, 42, 'nope', {}, { signedIn: 'yes' }]) {
      expect(parseSignInState(value)).toEqual(SIGNED_OUT_VIEW);
    }
  });

  it('keeps accessTokenStale separate from signedIn', () => {
    // A stale access token with a live refresh token is a WORKING sign-in.
    const state = parseSignInState({ signedIn: true, accessTokenStale: true });
    expect(state.signedIn).toBe(true);
    expect(state.accessTokenStale).toBe(true);
  });

  it('drops an account with neither a name nor a username', () => {
    // Rendering an empty "signed in as ―" line is worse than omitting it.
    const state = parseSignInState({ signedIn: true, account: { objectId: 'x' } });
    expect(state.account).toBeNull();
  });

  it('keeps only string scopes rather than rejecting the whole list', () => {
    const state = parseSignInState({
      signedIn: true,
      scopes: ['AppCatalog.Submit', 7, null],
    });
    expect(state.scopes).toEqual(['AppCatalog.Submit']);
  });
});

describe('parsePendingFlow', () => {
  it('projects a usable flow', () => {
    const flow = parsePendingFlow({
      userCode: 'GH7K-QW2P',
      verificationUri: 'https://microsoft.com/devicelogin',
      expiresAt: '2026-08-28T18:00:00.000Z',
      intervalSeconds: 5,
      scopes: ['AppCatalog.Submit'],
      adminConsentUrl: 'https://login.microsoftonline.com/t/adminconsent',
    });
    expect(flow?.userCode).toBe('GH7K-QW2P');
    expect(flow?.adminConsentUrl).toBe(
      'https://login.microsoftonline.com/t/adminconsent',
    );
  });

  it('drops a flow with a code but nowhere to type it', () => {
    // Half a flow is a dead end, not a partial success — the panel is better
    // off offering the start button again.
    expect(parsePendingFlow({ userCode: 'ABCD', verificationUri: '' })).toBeNull();
    expect(
      parsePendingFlow({ userCode: '', verificationUri: 'https://example.test' }),
    ).toBeNull();
    expect(parsePendingFlow(null)).toBeNull();
  });

  it('never yields a zero poll interval, which would be a hot loop', () => {
    for (const interval of [0, -3, Number.NaN, 'soon', undefined]) {
      const flow = parsePendingFlow({
        userCode: 'A',
        verificationUri: 'https://example.test',
        intervalSeconds: interval,
      });
      expect(flow?.intervalSeconds).toBeGreaterThan(0);
    }
  });
});

describe('parseSignInStatus', () => {
  it('treats a missing supported flag as unsupported', () => {
    // Optimism here would light up a button that answers 503.
    expect(parseSignInStatus({}).supported).toBe(false);
    expect(parseSignInStatus(undefined).signIn).toEqual(SIGNED_OUT_VIEW);
  });
});

describe('parsePollResult', () => {
  it('narrows each verdict', () => {
    expect(parsePollResult({ status: 'pending', retryAfterSeconds: 7 })).toEqual({
      status: 'pending',
      retryAfterSeconds: 7,
    });
    expect(parsePollResult({ status: 'expired', reason: 'code expired' })).toEqual({
      status: 'expired',
      reason: 'code expired',
    });
    expect(parsePollResult({ status: 'no_flow' }).status).toBe('no_flow');
  });

  it('carries the reason of a declined poll', () => {
    // THE field that tells "the admin cancelled" apart from "Conditional
    // Access blocked it". Dropping it makes the panel narrate an intent.
    const result = parsePollResult({
      status: 'declined',
      reason: 'AADSTS53003: blocked by Conditional Access',
    });
    expect(result).toEqual({
      status: 'declined',
      reason: 'AADSTS53003: blocked by Conditional Access',
    });
  });

  it('turns an unknown verdict into no_flow rather than an endless spinner', () => {
    expect(parsePollResult({ status: 'quantum' }).status).toBe('no_flow');
    expect(parsePollResult('nope').status).toBe('no_flow');
  });
});

describe('secondsRemaining', () => {
  it('counts down and clamps at zero', () => {
    const now = Date.parse('2026-08-28T12:00:00.000Z');
    expect(secondsRemaining('2026-08-28T12:01:00.000Z', now)).toBe(60);
    // A countdown that runs into "-14s" reads as a bug; "expired" is honest.
    expect(secondsRemaining('2026-08-28T11:59:00.000Z', now)).toBe(0);
  });

  it('answers null for an unusable expiry instead of NaN on screen', () => {
    expect(secondsRemaining('', Date.now())).toBeNull();
    expect(secondsRemaining('soon', Date.now())).toBeNull();
  });
});

describe('parseTeamsSignInErrorCode', () => {
  it('recognises the closed vocabulary the middleware answers with', () => {
    const err = new ApiError(
      503,
      'failed',
      JSON.stringify({ error: 'delegated_sign_in_unsupported' }),
    );
    expect(parseTeamsSignInErrorCode(err)).toBe('delegated_sign_in_unsupported');
  });

  it('returns null for anything else, so the panel uses its localized fallback', () => {
    expect(parseTeamsSignInErrorCode(new Error('boom'))).toBeNull();
    expect(
      parseTeamsSignInErrorCode(new ApiError(500, 'failed', 'not json')),
    ).toBeNull();
    expect(
      parseTeamsSignInErrorCode(
        new ApiError(500, 'failed', JSON.stringify({ error: 'invented' })),
      ),
    ).toBeNull();
  });
});
