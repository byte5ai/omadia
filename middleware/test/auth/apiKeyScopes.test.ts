import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  assertValidScopes,
  CHAT_WRITE_SCOPE,
  hasScope,
  isValidScope,
  LEGACY_DEFAULT_SCOPES,
  normalizeScopes,
  WILDCARD_SCOPE,
} from '../../packages/harness-api-key-auth/src/apiKeyScopes.js';

/**
 * Issue #439 — per-key scopes. The load-bearing property here is backward
 * compatibility: a key persisted before scopes existed carries no `scopes`
 * field, and must keep working with exactly the capability it used to have —
 * not more (a `*` default would be a privilege escalation shipped by an
 * upgrade) and not less (an empty default would break live integrations).
 */
describe('auth/apiKeyScopes', () => {
  it('accepts `<resource>:<action>` and the bare wildcard, rejects everything else', () => {
    assert.equal(isValidScope('chat:write'), true);
    assert.equal(isValidScope('memory:read'), true);
    assert.equal(isValidScope('plan-runner:run'), true);
    assert.equal(isValidScope(WILDCARD_SCOPE), true);

    assert.equal(isValidScope('chat'), false, 'no action segment');
    assert.equal(isValidScope('chat:'), false);
    assert.equal(isValidScope(':write'), false);
    assert.equal(isValidScope('Chat:Write'), false, 'uppercase is not a different scope');
    assert.equal(isValidScope('chat:*'), false, 'no prefix wildcards — exact match only');
    assert.equal(isValidScope(''), false);
    assert.equal(isValidScope(42), false);
    assert.equal(isValidScope(undefined), false);
  });

  it('normalizeScopes falls back to the legacy default for a missing/corrupt field', () => {
    assert.deepEqual(normalizeScopes(undefined), LEGACY_DEFAULT_SCOPES);
    assert.deepEqual(normalizeScopes(null), LEGACY_DEFAULT_SCOPES);
    assert.deepEqual(normalizeScopes('chat:write'), LEGACY_DEFAULT_SCOPES, 'not an array');
    assert.deepEqual(normalizeScopes([]), LEGACY_DEFAULT_SCOPES);
    assert.deepEqual(normalizeScopes(['nonsense']), LEGACY_DEFAULT_SCOPES, 'all entries invalid');
  });

  it('the legacy default is exactly the one capability pre-scopes keys had', () => {
    assert.deepEqual(LEGACY_DEFAULT_SCOPES, [CHAT_WRITE_SCOPE]);
    assert.equal(
      LEGACY_DEFAULT_SCOPES.includes(WILDCARD_SCOPE),
      false,
      'defaulting old keys to `*` would widen them on upgrade',
    );
  });

  it('normalizeScopes keeps valid entries, drops invalid ones, and de-duplicates', () => {
    assert.deepEqual(normalizeScopes(['chat:write', 'memory:read', 'chat:write', 7]), [
      'chat:write',
      'memory:read',
    ]);
  });

  it('assertValidScopes throws on a malformed scope instead of silently dropping it', () => {
    assert.deepEqual(assertValidScopes(['chat:write', 'chat:write']), ['chat:write']);
    assert.throws(() => assertValidScopes(['chat:write', 'oops']), /invalid API-key scope/);
  });

  it('hasScope matches exactly, or via the global wildcard', () => {
    assert.equal(hasScope(['chat:write'], 'chat:write'), true);
    assert.equal(hasScope(['chat:write'], 'memory:read'), false);
    assert.equal(hasScope([WILDCARD_SCOPE], 'anything:goes'), true);
    assert.equal(hasScope([], 'chat:write'), false);
    assert.equal(hasScope(undefined, 'chat:write'), false);
  });
});
