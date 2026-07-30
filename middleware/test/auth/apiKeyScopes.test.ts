import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  assertValidScopes,
  CHAT_WRITE_SCOPE,
  DENY_ALL_SCOPES,
  hasScope,
  isValidScope,
  LEGACY_DEFAULT_SCOPES,
  normalizeScopes,
  WILDCARD_SCOPE,
} from '../../packages/harness-api-key-auth/src/apiKeyScopes.js';

/**
 * Issue #439 — per-key scopes. Two load-bearing properties:
 *
 * 1. Backward compatibility: a key persisted before scopes existed carries no
 *    `scopes` field, and must keep working with exactly the capability it used
 *    to have — not more (a `*` default would be a privilege escalation shipped
 *    by an upgrade) and not less (an empty default would break live
 *    integrations).
 * 2. Fail-closed on corruption: a `scopes` field that is PRESENT but
 *    unreadable is not the same situation, and must never resolve to a
 *    capability grant. `absent` and `malformed` are decided separately.
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

  it('normalizeScopes gives an ABSENT scopes field the legacy default', () => {
    // The only input that means "genuinely minted before #439": the field was
    // never written at all. `create()` always persists an explicit array, so
    // nothing this store writes can land here.
    assert.deepEqual(normalizeScopes(undefined), LEGACY_DEFAULT_SCOPES);
  });

  it('normalizeScopes DENIES a present-but-malformed scopes field instead of granting the default', () => {
    // Regression guard for a fail-open: every input below is a `scopes` field
    // that EXISTS and cannot be read. Returning `['chat:write']` for any of
    // them would hand chat access to a key an operator may have deliberately
    // restricted away from chat.
    assert.deepEqual(normalizeScopes(null), DENY_ALL_SCOPES, 'null is present, not absent');
    assert.deepEqual(
      normalizeScopes('memory:read'),
      DENY_ALL_SCOPES,
      'a string instead of an array',
    );
    assert.deepEqual(normalizeScopes(42), DENY_ALL_SCOPES, 'a number instead of an array');
    assert.deepEqual(
      normalizeScopes({ 0: 'chat:write' }),
      DENY_ALL_SCOPES,
      'an object instead of an array',
    );
    assert.deepEqual(normalizeScopes([]), DENY_ALL_SCOPES, 'an empty array grants nothing');
    assert.deepEqual(
      normalizeScopes(['Chat:Write']),
      DENY_ALL_SCOPES,
      'uppercase fails SCOPE_PATTERN — it is not the same scope as chat:write',
    );
    assert.deepEqual(normalizeScopes(['nonsense']), DENY_ALL_SCOPES, 'all entries invalid');
    assert.deepEqual(normalizeScopes([null]), DENY_ALL_SCOPES, 'non-string entry');
  });

  it('a denied scope set fails every capability check closed', () => {
    assert.equal(hasScope(normalizeScopes('memory:read'), CHAT_WRITE_SCOPE), false);
    assert.equal(hasScope(normalizeScopes(['Chat:Write']), CHAT_WRITE_SCOPE), false);
    assert.equal(hasScope(normalizeScopes([]), WILDCARD_SCOPE), false);
  });

  it('normalizeScopes denies a PARTIALLY valid array rather than silently narrowing it', () => {
    // Never widen, and do not quietly guess either: half a scope set is a
    // record we cannot read faithfully.
    assert.deepEqual(normalizeScopes(['chat:write', 'nonsense']), DENY_ALL_SCOPES);
    assert.deepEqual(normalizeScopes(['chat:write', 7]), DENY_ALL_SCOPES);
  });

  it('the legacy default is exactly the one capability pre-scopes keys had', () => {
    assert.deepEqual(LEGACY_DEFAULT_SCOPES, [CHAT_WRITE_SCOPE]);
    assert.equal(
      LEGACY_DEFAULT_SCOPES.includes(WILDCARD_SCOPE),
      false,
      'defaulting old keys to `*` would widen them on upgrade',
    );
  });

  it('normalizeScopes keeps an all-valid array, de-duplicated', () => {
    assert.deepEqual(normalizeScopes(['chat:write', 'memory:read', 'chat:write']), [
      'chat:write',
      'memory:read',
    ]);
    assert.deepEqual(normalizeScopes([WILDCARD_SCOPE]), [WILDCARD_SCOPE]);
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
