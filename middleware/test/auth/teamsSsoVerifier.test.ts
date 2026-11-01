import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  bearerToken,
  createTeamsSsoVerifier,
  TeamsSsoError,
} from '../../src/auth/teamsSsoVerifier.js';
import type { TeamsSsoAudience } from '../../src/auth/teamsSsoVerifier.js';
import {
  BOT_APP_ID,
  jwksDocument,
  mintTeamsToken,
  OTHER_TENANT,
  TENANT,
} from '../_helpers/teamsSsoTokens.js';

/**
 * #1620 — the kernel's Teams SSO verifier. Every refusal case the issue lists
 * (expired, wrong tenant, wrong audience, forged signature, app-only) plus the
 * JWKS fetch throttling that keeps an anonymous caller from turning requests
 * into outbound calls.
 */

const AUDIENCES: readonly TeamsSsoAudience[] = [
  { appId: BOT_APP_ID, tenantId: TENANT },
];

const DEPLOYMENT_HOST = 'odoo-bot-middleware.fly.dev';

function verifier(opts: {
  audiences?: readonly TeamsSsoAudience[];
  fetchJwks?: (tenantId: string) => Promise<unknown>;
  now?: () => number;
} = {}) {
  const fetches: string[] = [];
  const v = createTeamsSsoVerifier({
    audiences: () => opts.audiences ?? AUDIENCES,
    identifierUriHosts: () => [DEPLOYMENT_HOST],
    fetchJwks:
      opts.fetchJwks ??
      (async (tenantId) => {
        fetches.push(tenantId);
        return jwksDocument();
      }),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { v, fetches };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof TeamsSsoError, `expected TeamsSsoError, got ${String(err)}`);
    return err.message;
  }
  assert.fail('token was accepted');
}

describe('#1620 — Teams SSO verifier', () => {
  it('accepts a valid delegated Teams token and returns the user', async () => {
    const { v } = verifier();
    const principal = await v.verify(mintTeamsToken());
    assert.deepEqual(principal, {
      tenantId: TENANT,
      objectId: 'user-oid-1',
      appId: BOT_APP_ID,
      upn: 'ada@example.com',
    });
  });

  it('accepts the v1 shape: sts issuer, api:// audience, appid, upn', async () => {
    const { v } = verifier();
    const principal = await v.verify(
      mintTeamsToken({
        claims: {
          iss: `https://sts.windows.net/${TENANT}/`,
          aud: `api://${DEPLOYMENT_HOST}/${BOT_APP_ID}`,
          azp: undefined,
          appid: '1fec8e78-bce4-4aaf-ab1b-5451cc387264',
          preferred_username: undefined,
          upn: 'ada@example.com',
        },
      }),
    );
    assert.equal(principal.upn, 'ada@example.com');
  });

  it('refuses an expired token (beyond the clock skew)', async () => {
    const { v } = verifier();
    const past = Math.floor(Date.now() / 1000) - 3600;
    assert.equal(
      await refusal(v.verify(mintTeamsToken({ claims: { exp: past, nbf: past - 600 } }))),
      'token expired',
    );
  });

  it('refuses a token that is not yet valid', async () => {
    const { v } = verifier();
    const future = Math.floor(Date.now() / 1000) + 3600;
    assert.equal(
      await refusal(v.verify(mintTeamsToken({ claims: { nbf: future } }))),
      'token not yet valid',
    );
  });

  it('refuses a token from another tenant without fetching its keys', async () => {
    const { v, fetches } = verifier();
    const message = await refusal(
      v.verify(
        mintTeamsToken({
          claims: {
            tid: OTHER_TENANT,
            iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0`,
          },
        }),
      ),
    );
    assert.equal(message, 'token tenant is not a configured bot tenant');
    assert.deepEqual(fetches, []);
  });

  it('refuses a token whose issuer names another tenant', async () => {
    const { v } = verifier();
    assert.equal(
      await refusal(
        v.verify(
          mintTeamsToken({
            claims: { iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0` },
          }),
        ),
      ),
      'unexpected token issuer',
    );
  });

  it('refuses a token for another audience', async () => {
    const { v } = verifier();
    assert.equal(
      await refusal(
        v.verify(
          mintTeamsToken({ claims: { aud: '00000003-0000-0000-c000-000000000000' } }),
        ),
      ),
      'token audience is not a bot app',
    );
  });

  it('refuses an api:// audience on a host that is not this deployment', async () => {
    const { v } = verifier();
    for (const aud of [`api://${TENANT}/${BOT_APP_ID}`, `api://evil.example.com/${BOT_APP_ID}`]) {
      assert.equal(
        await refusal(v.verify(mintTeamsToken({ claims: { aud } }))),
        'token audience is not a bot app',
      );
    }
  });

  it('accepts only the bare app id when no deployment host is configured', async () => {
    const v = createTeamsSsoVerifier({
      audiences: () => AUDIENCES,
      fetchJwks: async () => jwksDocument(),
    });
    await v.verify(mintTeamsToken());
    assert.equal(
      await refusal(
        v.verify(mintTeamsToken({ claims: { aud: `api://${DEPLOYMENT_HOST}/${BOT_APP_ID}` } })),
      ),
      'token audience is not a bot app',
    );
  });

  it('refuses a guest account (foreign idp), accepts idp = issuer', async () => {
    const { v } = verifier();
    for (const idp of [
      'https://sts.windows.net/99999999-8888-7777-6666-555555555555/',
      'live.com',
    ]) {
      assert.equal(
        await refusal(v.verify(mintTeamsToken({ claims: { idp } }))),
        'token belongs to a guest account',
      );
    }
    await v.verify(
      mintTeamsToken({ claims: { idp: `https://login.microsoftonline.com/${TENANT}/v2.0` } }),
    );
  });

  it('refuses a forged signature', async () => {
    const { v } = verifier();
    assert.equal(
      await refusal(v.verify(mintTeamsToken({ forged: true }))),
      'bad token signature',
    );
  });

  it('refuses a tampered payload under the original signature', async () => {
    const { v } = verifier();
    const [header, , signature] = mintTeamsToken().split('.');
    const otherPayload = mintTeamsToken({ claims: { oid: 'someone-else' } }).split('.')[1];
    assert.equal(
      await refusal(v.verify(`${header}.${otherPayload}.${signature}`)),
      'bad token signature',
    );
  });

  it('refuses an app-only token (roles, no scp)', async () => {
    const { v } = verifier();
    assert.equal(
      await refusal(
        v.verify(mintTeamsToken({ claims: { scp: undefined, roles: ['Data.Read'] } })),
      ),
      'token is not a delegated user token',
    );
  });

  it('refuses a token issued to a non-Teams client', async () => {
    const { v } = verifier();
    assert.equal(
      await refusal(
        v.verify(mintTeamsToken({ claims: { azp: '12345678-0000-0000-0000-000000000000' } })),
      ),
      'token was not issued to a Teams client',
    );
  });

  it("refuses alg 'none' and HS256", async () => {
    const { v } = verifier();
    for (const alg of ['none', 'HS256']) {
      assert.equal(
        await refusal(v.verify(mintTeamsToken({ header: { alg } }))),
        'unsupported token algorithm',
      );
    }
  });

  it('refuses garbage and oversized tokens', async () => {
    const { v } = verifier();
    assert.equal(await refusal(v.verify('not-a-jwt')), 'token is not a JWS');
    assert.equal(await refusal(v.verify('')), 'token missing or oversized');
    assert.equal(
      await refusal(v.verify('a'.repeat(17 * 1024))),
      'token missing or oversized',
    );
  });

  it('refuses every token while no Teams bot is installed', async () => {
    const { v, fetches } = verifier({ audiences: [] });
    assert.equal(
      await refusal(v.verify(mintTeamsToken())),
      'token tenant is not a configured bot tenant',
    );
    assert.deepEqual(fetches, []);
  });

  it('follows the audience source per call (a removed bot stops passing)', async () => {
    let audiences: readonly TeamsSsoAudience[] = AUDIENCES;
    const v = createTeamsSsoVerifier({
      audiences: () => audiences,
      fetchJwks: async () => jwksDocument(),
    });
    await v.verify(mintTeamsToken());
    audiences = [];
    assert.equal(
      await refusal(v.verify(mintTeamsToken())),
      'token tenant is not a configured bot tenant',
    );
  });

  describe('JWKS caching and throttling', () => {
    it('fetches the keys once and serves later tokens from the cache', async () => {
      const { v, fetches } = verifier();
      await v.verify(mintTeamsToken());
      await v.verify(mintTeamsToken());
      await v.verify(mintTeamsToken({ claims: { oid: 'another-user' } }));
      assert.deepEqual(fetches, [TENANT]);
    });

    it('shares one in-flight fetch between concurrent requests', async () => {
      const { v, fetches } = verifier();
      await Promise.all([v.verify(mintTeamsToken()), v.verify(mintTeamsToken())]);
      assert.equal(fetches.length, 1);
    });

    it('an unknown kid does not refetch within the floor', async () => {
      let clock = Date.now();
      const { v, fetches } = verifier({ now: () => clock });
      await v.verify(mintTeamsToken());
      const unknown = mintTeamsToken({ header: { kid: 'rotated-kid' } });
      for (let i = 0; i < 5; i += 1) {
        assert.equal(await refusal(v.verify(unknown)), 'unknown signing key');
      }
      assert.equal(fetches.length, 1);
      clock += 6 * 60 * 1000; // past the 5 min floor
      assert.equal(await refusal(v.verify(unknown)), 'unknown signing key');
      assert.equal(fetches.length, 2);
    });

    it('backs off after a failed key fetch instead of refetching per request', async () => {
      let clock = Date.now();
      let calls = 0;
      const { v } = verifier({
        now: () => clock,
        fetchJwks: async () => {
          calls += 1;
          throw new Error('entra down');
        },
      });
      for (let i = 0; i < 5; i += 1) {
        assert.equal(
          await refusal(v.verify(mintTeamsToken())),
          'key discovery unavailable',
        );
      }
      assert.equal(calls, 1);
      clock += 61 * 1000;
      await refusal(v.verify(mintTeamsToken()));
      assert.equal(calls, 2);
    });

    it('a failed refresh keeps serving the keys it already had', async () => {
      let clock = Date.now();
      let up = true;
      const v = createTeamsSsoVerifier({
        audiences: () => AUDIENCES,
        now: () => clock,
        fetchJwks: async () => {
          if (!up) throw new Error('entra blip');
          return jwksDocument();
        },
      });
      await v.verify(mintTeamsToken());
      up = false;
      clock += 61 * 60 * 1000; // past the 1 h TTL → refresh attempt fails
      await v.verify(mintTeamsToken());
      // An unknown kid during the backoff is refused without a fetch.
      assert.equal(
        await refusal(v.verify(mintTeamsToken({ header: { kid: 'other' } }))),
        'key discovery unavailable',
      );
    });
  });
});

describe('#1620 — bearerToken', () => {
  it('extracts a bearer token and rejects everything else', () => {
    assert.equal(bearerToken('Bearer abc.def.ghi'), 'abc.def.ghi');
    assert.equal(bearerToken('bearer abc'), 'abc');
    assert.equal(bearerToken(undefined), undefined);
    assert.equal(bearerToken('Basic abc'), undefined);
    assert.equal(bearerToken('Bearer a b'), undefined);
  });
});
