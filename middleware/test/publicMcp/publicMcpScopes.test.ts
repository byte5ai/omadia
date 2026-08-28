import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  assertValidScopes,
  DENY_ALL_SCOPES,
  hasScope,
  hasWriteScope,
  isMcpWriteScope,
  isValidScope,
  LEGACY_DEFAULT_SCOPES,
  MCP_INVOKE_SCOPE,
  MCP_LIST_SCOPE,
  mcpWriteScope,
  normalizeScopes,
  WILDCARD_SCOPE,
} from '../../packages/harness-api-key-auth/src/apiKeyScopes.js';

/**
 * W2-3 (issue #542) — the scope half of the public MCP endpoint's
 * authorization.
 *
 * Marcel chose to expose WRITE tools over an internet-facing endpoint (I
 * recommended read-only). That decision is what makes the wildcard exclusion
 * below a merge blocker rather than a refinement: with `*` satisfying a write
 * scope, any operator key minted with `*` for convenience would silently carry
 * "delete every Odoo invoice, over the internet, with no session".
 */
describe('MCP scopes — shape', () => {
  it('admits the three-segment mcp:write:<tool> form', () => {
    assert.equal(isValidScope('mcp:write:create_lead'), true);
    assert.equal(isValidScope(mcpWriteScope('book-meeting')), true);
  });

  it('admits the two-segment list/invoke scopes', () => {
    assert.equal(isValidScope(MCP_LIST_SCOPE), true);
    assert.equal(isValidScope(MCP_INVOKE_SCOPE), true);
  });

  /**
   * The three-segment rule is a literal `mcp:write:` prefix, not a generic
   * `<a>:<b>:<c>`. A generic rule would legalize every mistyped triple, and
   * each such string would validate, persist, and grant nothing — which reads
   * exactly like a revoked key at debug time.
   */
  it('does NOT admit an arbitrary three-segment scope', () => {
    assert.equal(isValidScope('odoo:write:invoice'), false);
    assert.equal(isValidScope('mcp:read:thing'), false);
    assert.equal(isValidScope('mcp:write:'), false);
    assert.equal(isValidScope('mcp:write:Create_Lead'), false);
    assert.equal(isValidScope('mcp:write:1tool'), false);
  });

  /**
   * `mcp:write` is a well-formed TWO-segment scope, so the generic pattern
   * accepts it — and it is the likeliest thing an operator types meaning "this
   * key may write". It would grant nothing (no check ever asks for it), which
   * reads exactly like a revoked key. Rejected outright so the mistake surfaces
   * at mint time. There is no class-wide write scope by design.
   */
  it('rejects the bare mcp:write, which would validate and grant nothing', () => {
    assert.equal(isValidScope('mcp:write'), false);
    assert.throws(() => assertValidScopes(['mcp:write']), /invalid API-key scope/);
    assert.deepEqual(normalizeScopes(['mcp:write']), DENY_ALL_SCOPES);
  });

  it('still admits and rejects exactly what it did before, for two-segment scopes', () => {
    assert.equal(isValidScope('chat:write'), true);
    assert.equal(isValidScope('memory:read'), true);
    assert.equal(isValidScope(WILDCARD_SCOPE), true);
    assert.equal(isValidScope('Chat:Write'), false);
    assert.equal(isValidScope('nonsense'), false);
    assert.equal(isValidScope(42), false);
    assert.equal(isValidScope(null), false);
  });

  it('identifies write scopes by prefix', () => {
    assert.equal(isMcpWriteScope('mcp:write:x'), true);
    assert.equal(isMcpWriteScope(MCP_INVOKE_SCOPE), false);
    assert.equal(isMcpWriteScope(WILDCARD_SCOPE), false);
  });
});

describe('MCP scopes — the wildcard exclusion', () => {
  /**
   * THE load-bearing assertion of this file. `*` grants every other capability
   * and must grant no write.
   */
  it('WILDCARD_SCOPE does NOT grant a per-tool write', () => {
    const granted = [WILDCARD_SCOPE];
    assert.equal(hasScope(granted, mcpWriteScope('create_lead')), false);
    assert.equal(hasWriteScope(granted, 'create_lead'), false);
  });

  it('WILDCARD_SCOPE still grants every non-write scope', () => {
    const granted = [WILDCARD_SCOPE];
    assert.equal(hasScope(granted, MCP_LIST_SCOPE), true);
    assert.equal(hasScope(granted, MCP_INVOKE_SCOPE), true);
    assert.equal(hasScope(granted, 'chat:write'), true);
  });

  it('grants a write ONLY on an exact per-tool match', () => {
    const granted = [MCP_INVOKE_SCOPE, mcpWriteScope('create_lead')];
    assert.equal(hasWriteScope(granted, 'create_lead'), true);
    // A sibling write tool is a different capability.
    assert.equal(hasWriteScope(granted, 'delete_invoice'), false);
    // And the write scope does not backfill the invoke scope for another tool.
    assert.equal(hasWriteScope([mcpWriteScope('create_lead')], 'create_lead'), true);
  });

  it('mcp:invoke alone does NOT grant any write', () => {
    assert.equal(hasWriteScope([MCP_INVOKE_SCOPE], 'create_lead'), false);
  });

  it('hasWriteScope and hasScope agree — so calling the wrong one is not a security event', () => {
    for (const granted of [
      [WILDCARD_SCOPE],
      [MCP_INVOKE_SCOPE],
      [mcpWriteScope('t')],
      [],
    ]) {
      assert.equal(
        hasWriteScope(granted, 't'),
        hasScope(granted, mcpWriteScope('t')),
        `disagreement for granted=${JSON.stringify(granted)}`,
      );
    }
  });

  it('denies everything when nothing is granted', () => {
    assert.equal(hasScope(undefined, MCP_LIST_SCOPE), false);
    assert.equal(hasScope(DENY_ALL_SCOPES, MCP_INVOKE_SCOPE), false);
    assert.equal(hasWriteScope(DENY_ALL_SCOPES, 'create_lead'), false);
  });
});

describe('MCP scopes — persisted-record normalization', () => {
  it('round-trips a valid persisted write scope', () => {
    const normalized = normalizeScopes([MCP_INVOKE_SCOPE, 'mcp:write:create_lead']);
    assert.deepEqual([...normalized].sort(), ['mcp:invoke', 'mcp:write:create_lead']);
    assert.equal(hasWriteScope(normalized, 'create_lead'), true);
  });

  /** A malformed persisted `scopes` field must deny EVERYTHING, including the
   *  write scopes that happen to sit next to the malformed entry. */
  it('malformed persisted scopes deny all — a valid write scope alongside garbage grants nothing', () => {
    const normalized = normalizeScopes(['mcp:write:create_lead', 'NOT A SCOPE']);
    assert.deepEqual(normalized, DENY_ALL_SCOPES);
    assert.equal(hasWriteScope(normalized, 'create_lead'), false);
    assert.equal(hasScope(normalized, MCP_LIST_SCOPE), false);
  });

  it('a non-array persisted scopes field denies all', () => {
    assert.deepEqual(normalizeScopes('mcp:invoke'), DENY_ALL_SCOPES);
  });

  it('an empty persisted scopes array denies all', () => {
    assert.deepEqual(normalizeScopes([]), DENY_ALL_SCOPES);
  });

  /** An absent field is a genuine pre-#439 key and keeps its old capability —
   *  it must NOT be widened to the new MCP surface by an upgrade. */
  it('an absent scopes field stays chat-only and reaches no MCP capability', () => {
    const normalized = normalizeScopes(undefined);
    assert.deepEqual(normalized, LEGACY_DEFAULT_SCOPES);
    assert.equal(hasScope(normalized, MCP_LIST_SCOPE), false);
    assert.equal(hasScope(normalized, MCP_INVOKE_SCOPE), false);
    assert.equal(hasWriteScope(normalized, 'create_lead'), false);
  });

  it('accepts MCP scopes at creation time and rejects a malformed one', () => {
    assert.deepEqual(
      [...assertValidScopes([MCP_LIST_SCOPE, MCP_INVOKE_SCOPE, 'mcp:write:create_lead'])].sort(),
      ['mcp:invoke', 'mcp:list', 'mcp:write:create_lead'],
    );
    assert.throws(() => assertValidScopes(['mcp:write:Create_Lead']), /invalid API-key scope/);
  });
});
