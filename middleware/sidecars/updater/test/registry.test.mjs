import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { manifestExists, parseChallenge, splitRepoRef } from '../src/registry.mjs';

/**
 * #696 — the registry preflight.
 *
 * On Fly there is no pull step the updater controls, so this check is the only
 * thing standing between a typo'd tag and a machine that has already been told
 * to move. The distinction that matters most here is "tag missing" vs
 * "registry unreachable": conflating them sends the operator hunting for a
 * typo in a perfectly correct tag.
 */

describe('splitRepoRef', () => {
  it('splits a registry host from the repository', () => {
    assert.deepEqual(splitRepoRef('ghcr.io/byte5ai/omadia-middleware'), {
      host: 'ghcr.io',
      repository: 'byte5ai/omadia-middleware',
    });
  });

  it('treats a bare name as Docker Hub library/', () => {
    assert.deepEqual(splitRepoRef('postgres'), {
      host: 'registry-1.docker.io',
      repository: 'library/postgres',
    });
  });

  it('does not mistake a namespace for a host', () => {
    assert.deepEqual(splitRepoRef('pgvector/pgvector'), {
      host: 'registry-1.docker.io',
      repository: 'pgvector/pgvector',
    });
  });

  it('handles a registry with a port', () => {
    assert.deepEqual(splitRepoRef('registry.local:5000/omadia/middleware'), {
      host: 'registry.local:5000',
      repository: 'omadia/middleware',
    });
  });
});

describe('parseChallenge', () => {
  it('parses realm, service and scope', () => {
    assert.deepEqual(
      parseChallenge(
        'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:x/y:pull"',
      ),
      {
        realm: 'https://ghcr.io/token',
        service: 'ghcr.io',
        scope: 'repository:x/y:pull',
      },
    );
  });

  it('returns null for anything that is not a bearer challenge', () => {
    assert.equal(parseChallenge('Basic realm="x"'), null);
    assert.equal(parseChallenge(null), null);
    assert.equal(parseChallenge('Bearer'), null);
  });
});

describe('manifestExists', () => {
  function response(status, { headers = {}, body } = {}) {
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (k) => headers[k.toLowerCase()] ?? null },
      json: async () => body,
    };
  }

  it('walks the token dance and reports an existing tag', async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push(String(url));
      if (String(url).includes('/token')) {
        return response(200, { body: { token: 'tok' } });
      }
      if (init?.headers?.authorization === 'Bearer tok') return response(200);
      return response(401, {
        headers: {
          'www-authenticate':
            'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:byte5ai/omadia-middleware:pull"',
        },
      });
    };

    const result = await manifestExists(
      'ghcr.io/byte5ai/omadia-middleware',
      'v0.75.0',
      { fetchImpl },
    );

    assert.deepEqual(result, { exists: true });
    assert.match(seen[0], /^https:\/\/ghcr\.io\/v2\/byte5ai\/omadia-middleware\/manifests\/v0\.75\.0$/);
    assert.match(seen[1], /scope=repository/);
  });

  it('reports a missing tag as tag_not_found', async () => {
    const result = await manifestExists('ghcr.io/x/y', 'v9.9.9', {
      fetchImpl: async () => response(404),
    });
    assert.deepEqual(result, { exists: false, reason: 'tag_not_found' });
  });

  it('distinguishes an unreachable registry from a missing tag', async () => {
    const result = await manifestExists('ghcr.io/x/y', 'v1.0.0', {
      fetchImpl: async () => {
        throw new Error('getaddrinfo ENOTFOUND ghcr.io');
      },
    });
    assert.equal(result.exists, false);
    assert.match(result.reason, /registry_unreachable: .*ENOTFOUND/);
  });

  it('does not claim the tag exists when the token endpoint refuses', async () => {
    const result = await manifestExists('ghcr.io/x/y', 'v1.0.0', {
      fetchImpl: async (url) =>
        String(url).includes('/token')
          ? response(403)
          : response(401, {
              headers: { 'www-authenticate': 'Bearer realm="https://ghcr.io/token"' },
            }),
    });
    assert.deepEqual(result, { exists: false, reason: 'registry_token_403' });
  });

  it('surfaces an unparseable challenge instead of retrying blind', async () => {
    const result = await manifestExists('ghcr.io/x/y', 'v1.0.0', {
      fetchImpl: async () => response(401, { headers: {} }),
    });
    assert.deepEqual(result, {
      exists: false,
      reason: 'registry_auth_challenge_unparseable',
    });
  });
});
