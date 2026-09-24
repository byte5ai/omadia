/**
 * THE SECURITY TEST of byte5ai/omadia#924: neither token nor `flowHandle`ns
 * ever reaches a log, an error, or an API response.
 *
 * This file is not "nice coverage". The feature stores bearer credentials for
 * a signed-in global admin and, for fifteen minutes at a time, a device code
 * that anyone holding it can redeem for those credentials. Every other test in
 * this change proves the feature WORKS; this one proves it does not leak, and
 * it is the one that must never be deleted to make a refactor pass.
 *
 * Four surfaces are checked, because those are the four ways the values could
 * get out:
 *
 *   1. THE REDACTOR itself — the choke point every log and error path uses.
 *   2. THE TOKEN STORE's operator-facing projection (`describe`), which is the
 *      only thing routes are allowed to render.
 *   3. THE SIGN-IN SERVICE's public surface — start, poll, status, revoke —
 *      including its LOG OUTPUT, captured and searched.
 *   4. THE ROUTER's actual HTTP responses, searched as raw bytes. A leak that
 *      survives every unit-level guard still has to cross this wire, so this
 *      is the assertion that holds even if the shapes above are refactored.
 *
 * The sentinels are deliberately absurd, unique strings: a substring search
 * over serialized output cannot produce a false negative for them, and a false
 * positive would mean the value really is there.
 */

import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import {
  redactDelegated,
  summarizeTokenSet,
  type DelegatedTokenSet,
  type DeviceCodeStart,
  type TeamsDelegatedProvisionerMethods,
} from '../src/platform/teamsDelegatedSignIn.js';
import { TeamsDelegatedTokenStore } from '../src/platform/teamsDelegatedTokenStore.js';
import { TeamsDelegatedSignInService } from '../src/services/teamsDelegatedSignInService.js';
import { createOperatorTeamsSignInRouter } from '../src/routes/operatorTeamsSignIn.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

// ---------------------------------------------------------------------------
// Sentinels — every one of these must be unfindable in anything we emit.
// ---------------------------------------------------------------------------

const ACCESS_TOKEN = 'SENTINEL-ACCESS-TOKEN-2f4b9c';
const REFRESH_TOKEN = 'SENTINEL-REFRESH-TOKEN-7ad13e';
const FLOW_HANDLE = 'SENTINEL-FLOW-HANDLE-c0ffee01';

const SECRETS = [ACCESS_TOKEN, REFRESH_TOKEN, FLOW_HANDLE] as const;

function tokenSet(): DelegatedTokenSet {
  return {
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    scopes: ['AppCatalog.Submit'],
    clientId: 'client-1',
    tenantId: 'tenant-1',
    account: { username: 'admin@contoso.test', displayName: 'Ada Admin' },
  };
}

function deviceCodeStart(): DeviceCodeStart {
  return {
    userCode: 'ABCD-EFGH',
    verificationUri: 'https://microsoft.com/devicelogin',
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    intervalSeconds: 5,
    flowHandle: FLOW_HANDLE,
    scopes: ['AppCatalog.Submit'],
    adminConsentUrl: 'https://login.microsoftonline.com/tenant-1/adminconsent',
  };
}

/** Assert a haystack contains none of the sentinels, naming which one leaked. */
function assertNoSecrets(haystack: string, where: string): void {
  for (const secret of SECRETS) {
    assert.equal(
      haystack.includes(secret),
      false,
      `${where} leaked the secret ${secret}`,
    );
  }
}

// ---------------------------------------------------------------------------
// In-memory vault double — the same two-argument namespace/key shape the real
// `SecretVault` exposes and `McpRegistrySecretService` already relies on.
// ---------------------------------------------------------------------------

class FakeVault {
  public readonly entries = new Map<string, string>();

  get(ns: string, key: string): Promise<string | undefined> {
    return Promise.resolve(this.entries.get(`${ns}::${key}`));
  }

  set(ns: string, key: string, value: string): Promise<void> {
    this.entries.set(`${ns}::${key}`, value);
    return Promise.resolve();
  }

  deleteKey(ns: string, key: string): Promise<void> {
    this.entries.delete(`${ns}::${key}`);
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// 1. The redactor
// ---------------------------------------------------------------------------

describe('#924 redactDelegated', () => {
  it('strips every secret-grade key, at any depth, in both casings', () => {
    const payload = {
      accessToken: ACCESS_TOKEN,
      access_token: ACCESS_TOKEN,
      nested: {
        tokens: { refreshToken: REFRESH_TOKEN, refresh_token: REFRESH_TOKEN },
        list: [{ flowHandle: FLOW_HANDLE }, { device_code: FLOW_HANDLE }],
      },
      keep: 'this-must-survive',
    };
    const cleaned = redactDelegated(payload);
    assertNoSecrets(JSON.stringify(cleaned), 'redactDelegated');
    // A redactor that solved the problem by dropping everything would pass the
    // assertion above and be useless.
    assert.equal((cleaned as { keep: string }).keep, 'this-must-survive');
  });

  it('never throws on the shapes a log path actually hands it', () => {
    for (const value of [null, undefined, 42, 'text', new Date(), [1, [2, [3]]]]) {
      assert.doesNotThrow(() => redactDelegated(value));
    }
  });

  it('summarizeTokenSet is a metadata-only projection', () => {
    const summary = summarizeTokenSet(tokenSet());
    assertNoSecrets(JSON.stringify(summary), 'summarizeTokenSet');
    // The metadata the operator screen renders is still there — this is the
    // projection routes use INSTEAD of the token set, so it has to be usable.
    assert.equal(summary.tenantId, 'tenant-1');
    assert.equal(summary.account?.username, 'admin@contoso.test');
  });
});

// ---------------------------------------------------------------------------
// 2. The token store
// ---------------------------------------------------------------------------

describe('#924 TeamsDelegatedTokenStore custody', () => {
  it('encrypts nothing into describe(): the operator projection has no token', async () => {
    const store = new TeamsDelegatedTokenStore(new FakeVault());
    await store.write(tokenSet());
    const presence = await store.describe();
    assertNoSecrets(JSON.stringify(presence), 'TeamsDelegatedTokenStore.describe');
    assert.equal(presence.signedIn, true);
    assert.equal(presence.account?.username, 'admin@contoso.test');
  });

  it('round-trips the token set for the two callers that legitimately read it', async () => {
    const store = new TeamsDelegatedTokenStore(new FakeVault());
    await store.write(tokenSet());
    const read = await store.read();
    assert.equal(read?.accessToken, ACCESS_TOKEN);
    assert.equal(read?.refreshToken, REFRESH_TOKEN);
  });

  it('a rotation keeps signedInAt; a different account restarts it', async () => {
    const vault = new FakeVault();
    let now = new Date('2026-01-01T00:00:00.000Z');
    const store = new TeamsDelegatedTokenStore(vault, () => now);
    const first = { ...tokenSet(), account: { objectId: 'admin-1' } };
    await store.write(first);
    const initial = (await store.describe()).signedInAt;

    // A silent refresh — same admin, new material. The clock must NOT restart,
    // or the panel claims someone re-authenticated when nobody did.
    now = new Date('2026-01-02T00:00:00.000Z');
    await store.write({ ...first, accessToken: 'rotated' });
    assert.equal((await store.describe()).signedInAt, initial);

    // A different admin IS a new sign-in.
    await store.write({ ...first, account: { objectId: 'admin-2' } });
    assert.notEqual((await store.describe()).signedInAt, initial);
  });

  it('an expired access token is stale, NOT signed out', async () => {
    const store = new TeamsDelegatedTokenStore(
      new FakeVault(),
      () => new Date('2030-01-01T00:00:00.000Z'),
    );
    await store.write(tokenSet());
    const presence = await store.describe();
    // The whole point: the refresh token outlives the access token, so this is
    // a working sign-in that happens to need one silent refresh.
    assert.equal(presence.signedIn, true);
    assert.equal(presence.accessTokenStale, true);
  });

  it('a half-written record reads as signed out rather than as a broken credential', async () => {
    const vault = new FakeVault();
    await vault.set(
      '@omadia/teams-delegated',
      'tenant-token-set',
      JSON.stringify({ version: 1, tokens: { accessToken: ACCESS_TOKEN } }),
    );
    const store = new TeamsDelegatedTokenStore(vault);
    assert.equal(await store.read(), undefined);
    assert.equal((await store.describe()).signedIn, false);
  });

  it('clear() forgets the record', async () => {
    const store = new TeamsDelegatedTokenStore(new FakeVault());
    await store.write(tokenSet());
    await store.clear();
    assert.equal(await store.read(), undefined);
    assert.equal((await store.describe()).signedIn, false);
  });
});

// ---------------------------------------------------------------------------
// 3. + 4. The service and the wire
// ---------------------------------------------------------------------------

describe('#924 sign-in surface holds the flow handle server-side', () => {
  let server: Server;
  let baseUrl: string;
  let logs: string[] = [];
  let store: TeamsDelegatedTokenStore;
  let service: TeamsDelegatedSignInService;
  let pollResult: 'pending' | 'succeeded' | 'declined' = 'pending';
  let seenHandles: string[] = [];

  /** A connector double that RECORDS the handle it was given, so the test can
   *  prove the poll used the stored one rather than something from the wire. */
  function fakeProvisioner(): Partial<TeamsDelegatedProvisionerMethods> {
    return {
      uploadToCatalogDelegated: () => {
        throw new Error('not used here');
      },
      startDelegatedSignIn: () => Promise.resolve(deviceCodeStart()),
      pollDelegatedSignIn: (input) => {
        seenHandles.push(input.flowHandle);
        if (pollResult === 'succeeded') {
          return Promise.resolve({ status: 'succeeded' as const, tokens: tokenSet() });
        }
        if (pollResult === 'declined') {
          return Promise.resolve({
            status: 'declined' as const,
            // The case the UI must not narrate as "the admin cancelled".
            reason: 'blocked by a Conditional Access policy',
          });
        }
        return Promise.resolve({ status: 'pending' as const, retryAfterSeconds: 5 });
      },
      getDelegatedSignInStatus: () => ({ signedIn: false }),
      refreshDelegatedToken: () => Promise.resolve(tokenSet()),
      revokeDelegatedSignIn: () => ({ revoked: true }),
    };
  }

  before(async () => {
    store = new TeamsDelegatedTokenStore(new FakeVault());
    service = new TeamsDelegatedSignInService({
      tokens: store,
      getProvisioner: () => fakeProvisioner(),
      log: (m) => logs.push(m),
    });
    const app = express();
    app.use(express.json());
    app.use('/api/v1/operator/teams', createOperatorTeamsSignInRouter({
      getSignIn: () => service,
    }));
    server = await listenLoopback(app);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(addr.port)}/api/v1/operator/teams`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('POST /sign-in returns the code and the consent URL, and NOT the handle', async () => {
    logs = [];
    const res = await fetch(`${baseUrl}/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'omadia' }),
    });
    assert.equal(res.status, 202);
    const text = await res.text();
    assertNoSecrets(text, 'POST /sign-in response');

    const body = JSON.parse(text) as {
      pending: { userCode: string; adminConsentUrl: string; intervalSeconds: number };
    };
    // What the operator needs is all there…
    assert.equal(body.pending.userCode, 'ABCD-EFGH');
    assert.equal(
      body.pending.adminConsentUrl,
      'https://login.microsoftonline.com/tenant-1/adminconsent',
    );
    assert.equal(body.pending.intervalSeconds, 5);
    // …and the field that must not be is not merely redacted, it is absent.
    assert.equal('flowHandle' in body.pending, false);
    assertNoSecrets(logs.join('\n'), 'sign-in start logs');
  });

  it('POST /sign-in/poll needs no handle from the caller and uses the stored one', async () => {
    seenHandles = [];
    // Deliberately NO body: the endpoint takes nothing, so there is nothing a
    // browser could be tricked into sending and nothing to validate.
    const res = await fetch(`${baseUrl}/sign-in/poll`, { method: 'POST' });
    assert.equal(res.status, 200);
    const text = await res.text();
    assertNoSecrets(text, 'POST /sign-in/poll response');
    assert.deepEqual(seenHandles, [FLOW_HANDLE]);
  });

  it('a declined poll carries its reason instead of blaming the admin', async () => {
    pollResult = 'declined';
    const res = await fetch(`${baseUrl}/sign-in/poll`, { method: 'POST' });
    const body = (await res.json()) as {
      poll: { status: string; reason?: string };
    };
    assert.equal(body.poll.status, 'declined');
    // The server must FORWARD the reason — a UI cannot distinguish a cancelled
    // sign-in from a policy-blocked one without it.
    assert.match(body.poll.reason ?? '', /Conditional Access/);
    pollResult = 'pending';
  });

  it('a succeeded poll stores the tokens and answers with metadata only', async () => {
    logs = [];
    // Fresh flow, because the declined poll above consumed the previous one.
    await fetch(`${baseUrl}/sign-in`, { method: 'POST' });
    pollResult = 'succeeded';
    const res = await fetch(`${baseUrl}/sign-in/poll`, { method: 'POST' });
    const text = await res.text();
    assertNoSecrets(text, 'succeeded poll response');
    const body = JSON.parse(text) as {
      poll: { status: string; signIn: { signedIn: boolean; account?: { username?: string } } };
    };
    assert.equal(body.poll.status, 'succeeded');
    assert.equal(body.poll.signIn.signedIn, true);
    assert.equal(body.poll.signIn.account?.username, 'admin@contoso.test');
    // Persisted, so a restart does not sign the tenant out.
    assert.equal((await store.read())?.accessToken, ACCESS_TOKEN);
    assertNoSecrets(logs.join('\n'), 'successful sign-in logs');
    pollResult = 'pending';
  });

  it('GET /sign-in reports state without any token, and the pending flow without its handle', async () => {
    const res = await fetch(`${baseUrl}/sign-in`);
    assert.equal(res.status, 200);
    assertNoSecrets(await res.text(), 'GET /sign-in response');
  });

  it('polling with no flow in flight says so instead of inventing one', async () => {
    const res = await fetch(`${baseUrl}/sign-in/poll`, { method: 'POST' });
    const body = (await res.json()) as { poll: { status: string } };
    assert.equal(body.poll.status, 'no_flow');
  });

  it('DELETE /sign-in clears the record and leaks nothing on the way out', async () => {
    pollResult = 'succeeded';
    await fetch(`${baseUrl}/sign-in`, { method: 'POST' });
    await fetch(`${baseUrl}/sign-in/poll`, { method: 'POST' });
    assert.notEqual(await store.read(), undefined);

    const res = await fetch(`${baseUrl}/sign-in`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assertNoSecrets(await res.text(), 'DELETE /sign-in response');
    assert.equal(await store.read(), undefined);
    pollResult = 'pending';
  });
});

describe('#924 sign-in surface degrades honestly', () => {
  it('503s with a machine code when the sign-in stack is not wired', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/operator/teams',
      createOperatorTeamsSignInRouter({ getSignIn: () => undefined }),
    );
    const server = await listenLoopback(app);
    const addr = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${String(addr.port)}/api/v1/operator/teams/sign-in`;
    try {
      const res = await fetch(url);
      assert.equal(res.status, 503);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, 'teams_sign_in_unavailable');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('names the connector-too-old case separately from connector-missing', async () => {
    const store = new TeamsDelegatedTokenStore(new FakeVault());
    // An accessor from an older connector: present, but without the delegated
    // half. Reporting this as "not installed" would send an operator to
    // install a plugin they already have.
    const service = new TeamsDelegatedSignInService({
      tokens: store,
      getProvisioner: () => ({}),
      log: () => undefined,
    });
    assert.equal(service.supported(), false);
    await assert.rejects(
      () => service.start(),
      (err: Error & { code?: string }) =>
        err.code === 'delegated_sign_in_unsupported',
    );
  });
});
