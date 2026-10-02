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
  resolveWirePath,
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

  it('#778 S3a: refuses every control character the WHATWG parser would strip or encode', () => {
    for (const c of ['\t', '\n', '\r', '\u0001', '\u001f', '\u007f']) {
      assert.throws(() => normalizePathForMatch(`/v1/messages/.${c}./admin`), JSON.stringify(c));
      assert.throws(() => normalizePathForMatch(`/v1/messages?q=${c}`), `query ${JSON.stringify(c)}`);
    }
  });

  it('#778 S3a: refuses a backslash in the path (WHATWG reads it as /)', () => {
    assert.throws(() => normalizePathForMatch('/v1/messages/..\\..\\admin'));
    assert.throws(() => normalizePathForMatch('/\\evil.example.com/x'));
  });

  it('#778 S3a: leaves a backslash in the query alone (it is not a path separator there)', () => {
    assert.equal(normalizePathForMatch('/v1/x?q=a\\b').search, '?q=a\\b');
  });
});

describe('#778 S3a resolveWirePath — the path fetch actually sends', () => {
  it('resolves percent-encoded dot segments that path.posix left alone', () => {
    assert.equal(normalizePathForMatch('/v1/messages/%2e%2e/%2e%2e/admin').pathname, '/v1/messages/%2e%2e/%2e%2e/admin');
    assert.equal(resolveWirePath('api.example.com', '/v1/messages/%2e%2e/%2e%2e/admin', '').pathname, '/admin');
    assert.equal(resolveWirePath('api.example.com', '/v1/messages/.%2E/%2e./admin', '').pathname, '/admin');
  });

  it('keeps an encoded slash and an encoded dot inside a name', () => {
    assert.equal(resolveWirePath('api.example.com', '/p/group%2Fproject', '').pathname, '/p/group%2Fproject');
    assert.equal(resolveWirePath('api.example.com', '/p/a%2Eb', '').pathname, '/p/a%2Eb');
  });

  it('returns the query in its serialised form and never touches dot segments in it', () => {
    assert.deepEqual(resolveWirePath('api.example.com', '/p', '?q=%2e%2e/x'), { pathname: '/p', search: '?q=%2e%2e/x' });
    assert.deepEqual(resolveWirePath('api.example.com', '/p', '?'), { pathname: '/p', search: '' });
  });

  it('is stable: resolving its own output again changes nothing', () => {
    const once = resolveWirePath('api.example.com', '/v1/a b/%2e%2e/c%2E/"x"', '?k=v w');
    assert.deepEqual(resolveWirePath('api.example.com', once.pathname, once.search), once);
  });

  it('builds the URL absolute, so a path can never re-target the authority', () => {
    // Relative resolution would turn this into host evil.example.com.
    assert.equal(resolveWirePath('api.example.com', '/\\evil.example.com/x', '').pathname, '//evil.example.com/x');
  });

  it('throws for a declared host that is not a plain host[:port]', () => {
    for (const host of ['', 'op@api.example.com', 'api.example.com/v1', 'api.example.com?x', 'a b', 'api.example.com:99999']) {
      assert.throws(() => resolveWirePath(host, '/p', ''), host);
    }
    assert.equal(resolveWirePath('internal-api:8443', '/p', '').pathname, '/p');
    assert.equal(resolveWirePath('[::1]:8443', '/p', '').pathname, '/p');
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

  // #778 S3a — the incoming side is the WHATWG-serialised wire path, so the
  // prefix must be serialised the same way or it never matches.
  const wire = (p: string): string => resolveWirePath('h', normalizePathForMatch(p).pathname, '').pathname;

  for (const prefix of ['/drive/My Files', '/v1/über', '/api/{tenant}']) {
    it(`matches a prefix the serialiser percent-encodes (${prefix}) against the wire path`, () => {
      assert.equal(matchPath(wire(`${prefix}/x`), prefix), true);
      assert.equal(matchPath(wire(prefix), prefix), true);
      assert.equal(matchPath(wire(`${prefix}EVIL/x`), prefix), false, 'the segment boundary still holds');
    });
  }

  it('keeps traversal safety for a serialised prefix', () => {
    assert.equal(matchPath(wire('/drive/My Files/../../admin'), '/drive/My Files'), false);
    assert.equal(matchPath(wire('/drive/My Files/%2e%2e/%2e%2e/admin'), '/drive/My Files'), false);
    assert.equal(matchPath('/drive/My%20Files/x', '/drive/./My Files/'), true);
  });

  it('a prefix that would widen or be rewritten when serialised matches nothing (fail closed)', () => {
    for (const prefix of ['/v1/%2e%2e', '/v1/%2E%2E/admin', '/api?x=1', '/api#frag', '/v1\\admin', '/v1\tx']) {
      assert.equal(matchPath('/api/x', prefix), false, prefix);
      assert.equal(matchPath('/', prefix), false, prefix);
      assert.equal(matchPath('/v1/admin', prefix), false, prefix);
    }
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
