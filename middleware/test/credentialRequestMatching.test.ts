/**
 * #578 Phase 2 — `requestMatching.ts`'s traversal- and boundary-safety.
 *
 * These are the functions a broker bypass attempt targets, so they get the
 * exhaustive treatment: every case the module header calls out by name gets
 * its own assertion, not just a happy-path smoke test.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  matchPath,
  matchesAnyPrefix,
  normalizeHost,
  normalizeMethod,
  normalizePathForMatch,
} from '../src/credentials/requestMatching.js';

describe('#578 normalizeMethod', () => {
  it('uppercases and trims', () => {
    assert.equal(normalizeMethod(' get '), 'GET');
    assert.equal(normalizeMethod('Post'), 'POST');
  });
});

describe('#578 normalizeHost', () => {
  it('lowercases and trims', () => {
    assert.equal(normalizeHost(' API.Example.COM '), 'api.example.com');
  });

  it('does NOT strip a port — a different port is a different declared host', () => {
    assert.equal(normalizeHost('Internal-Api:8443'), 'internal-api:8443');
    assert.notEqual(normalizeHost('internal-api:8443'), normalizeHost('internal-api'));
  });
});

describe('#578 normalizePathForMatch', () => {
  it('leaves a clean absolute path alone', () => {
    assert.equal(normalizePathForMatch('/v1/messages').pathname, '/v1/messages');
  });

  it('adds a leading slash to a relative-looking path', () => {
    assert.equal(normalizePathForMatch('v1/messages').pathname, '/v1/messages');
  });

  it('splits off a query string into `search`', () => {
    const { pathname, search } = normalizePathForMatch('/v1/messages?limit=10&x=y');
    assert.equal(pathname, '/v1/messages');
    assert.equal(search, '?limit=10&x=y');
  });

  it('splits off a fragment too, and it never reaches `search`', () => {
    const { pathname, search } = normalizePathForMatch('/v1/messages#section');
    assert.equal(pathname, '/v1/messages');
    assert.equal(search, '');
  });

  it('collapses a traversal attempt that stays within the tree', () => {
    assert.equal(normalizePathForMatch('/v1/messages/../drafts').pathname, '/v1/drafts');
  });

  it('THE traversal case from the scoping prompt: clamps at root rather than escaping it', () => {
    assert.equal(normalizePathForMatch('/api/../admin').pathname, '/admin');
  });

  it('clamps even a traversal that tries to go well above root', () => {
    assert.equal(normalizePathForMatch('/v1/messages/../../../../../etc/passwd').pathname, '/etc/passwd');
  });

  it('refuses a path that embeds a scheme (SSRF-shaped smuggling attempt)', () => {
    assert.throws(() => normalizePathForMatch('http://evil.example.com/steal'));
  });

  it('refuses a protocol-relative path', () => {
    assert.throws(() => normalizePathForMatch('//evil.example.com/steal'));
  });

  it('refuses an embedded NUL byte', () => {
    assert.throws(() => normalizePathForMatch('/v1/messages\0/../admin'));
  });
});

describe('#578 matchPath — boundary-safe prefix matching', () => {
  it('matches an exact path', () => {
    assert.equal(matchPath('/v1/messages', '/v1/messages'), true);
  });

  it('matches a path nested under the prefix', () => {
    assert.equal(matchPath('/v1/messages/123', '/v1/messages'), true);
  });

  it('does NOT match a sibling path that merely shares a string prefix', () => {
    // The classic `startsWith` bug: '/v1/messagesEVIL' is not under '/v1/messages'.
    assert.equal(matchPath('/v1/messagesEVIL', '/v1/messages'), false);
  });

  it('treats a declared prefix with or without a trailing slash identically', () => {
    assert.equal(matchPath('/v1/messages/123', '/v1/messages/'), true);
    assert.equal(matchPath('/v1/messages', '/v1/messages/'), true);
  });

  it('a root prefix matches everything', () => {
    assert.equal(matchPath('/anything/at/all', '/'), true);
  });

  it('normalises the prefix itself, not just the incoming path', () => {
    assert.equal(matchPath('/v1/messages/123', '/v1/./messages'), true);
  });
});

describe('#578 matchesAnyPrefix', () => {
  it('true when any declared prefix matches', () => {
    assert.equal(matchesAnyPrefix('/v2/x', ['/v1', '/v2']), true);
  });

  it('false when none match', () => {
    assert.equal(matchesAnyPrefix('/v3/x', ['/v1', '/v2']), false);
  });

  it('false for an empty prefix list — an unconfigured broker denies by default', () => {
    assert.equal(matchesAnyPrefix('/v1/x', []), false);
  });
});
