import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  createInMemoryPublicMcpKeyBindingStore,
  normalizeBindingRow,
} from '../../src/mcp/publicMcpKeyBindings.js';

/**
 * W2-3 (issue #542) — the binding half of the public MCP endpoint's
 * authorization: which agent a key is bound to, and which of that agent's tools
 * it reaches.
 *
 * Every case here asks the same question: does an unreadable row GRANT
 * anything? It must not. The endpoint is internet-facing and exposes write
 * tools, so a normalization bug that fails open is a remote write.
 */
const GOOD_ROW = {
  key_id: 'key-1',
  agent_id: 'sales',
  read_tools: ['query_crm'],
  write_tools: ['create_lead'],
  write_rate_limit_per_minute: 5,
  enabled: true,
};

describe('public MCP key bindings — the happy path', () => {
  it('resolves a well-formed row', () => {
    const binding = normalizeBindingRow(GOOD_ROW);
    assert.ok(binding);
    assert.equal(binding.keyId, 'key-1');
    assert.equal(binding.agentId, 'sales');
    assert.deepEqual(binding.readTools, ['query_crm']);
    assert.deepEqual(binding.writeTools, ['create_lead']);
    assert.equal(binding.writeRateLimitPerMinute, 5);
  });

  it('accepts a rate limit that pg returned as a string', () => {
    const binding = normalizeBindingRow({ ...GOOD_ROW, write_rate_limit_per_minute: '12' });
    assert.equal(binding?.writeRateLimitPerMinute, 12);
  });

  it('de-duplicates repeated tool names', () => {
    const binding = normalizeBindingRow({
      ...GOOD_ROW,
      read_tools: ['query_crm', 'query_crm'],
    });
    assert.deepEqual(binding?.readTools, ['query_crm']);
  });

  /**
   * A tool in BOTH lists is ambiguous about whether it needs
   * `mcp:write:<tool>`. Resolve toward WRITE — the stricter reading. Resolving
   * toward read would silently drop the per-tool write scope requirement from a
   * tool the operator just marked as a write.
   */
  it('a tool listed as both read and write is treated as a WRITE', () => {
    const binding = normalizeBindingRow({
      ...GOOD_ROW,
      read_tools: ['create_lead'],
      write_tools: ['create_lead'],
    });
    assert.deepEqual(binding?.readTools, []);
    assert.deepEqual(binding?.writeTools, ['create_lead']);
  });
});

describe('public MCP key bindings — fail closed', () => {
  for (const [label, row] of [
    ['missing key_id', { ...GOOD_ROW, key_id: undefined }],
    ['empty key_id', { ...GOOD_ROW, key_id: '' }],
    ['missing agent_id', { ...GOOD_ROW, agent_id: undefined }],
    ['empty agent_id', { ...GOOD_ROW, agent_id: '' }],
    ['non-string agent_id', { ...GOOD_ROW, agent_id: 7 }],
    ['read_tools is null', { ...GOOD_ROW, read_tools: null }],
    ['read_tools is not an array', { ...GOOD_ROW, read_tools: 'query_crm' }],
    ['read_tools holds a non-string', { ...GOOD_ROW, read_tools: ['ok', 3] }],
    ['write_tools is null', { ...GOOD_ROW, write_tools: null }],
    ['write_tools holds a non-string', { ...GOOD_ROW, write_tools: [{}] }],
    ['enabled is not a boolean', { ...GOOD_ROW, enabled: 'true' }],
    ['enabled is missing', { ...GOOD_ROW, enabled: undefined }],
    ['rate limit is negative', { ...GOOD_ROW, write_rate_limit_per_minute: -1 }],
    ['rate limit is fractional', { ...GOOD_ROW, write_rate_limit_per_minute: 1.5 }],
    ['rate limit is not a number', { ...GOOD_ROW, write_rate_limit_per_minute: 'many' }],
  ] as const) {
    it(`denies the whole row: ${label}`, () => {
      assert.equal(normalizeBindingRow(row), undefined);
    });
  }

  /**
   * Partially-valid lists deny rather than narrowing to the valid subset — the
   * same rule `normalizeScopes` applies, for the same reason: a record we cannot
   * read faithfully is one we must not guess at, and "half its tools" is worse
   * to debug than "none".
   */
  it('a partially-valid read_tools list does NOT narrow to its valid subset', () => {
    assert.equal(
      normalizeBindingRow({ ...GOOD_ROW, read_tools: ['query_crm', null] }),
      undefined,
    );
  });

  it('a disabled row grants nothing, and is indistinguishable from absent to callers', () => {
    assert.equal(normalizeBindingRow({ ...GOOD_ROW, enabled: false }), undefined);
  });

  it('a row may legitimately grant nothing without being malformed', () => {
    const binding = normalizeBindingRow({ ...GOOD_ROW, read_tools: [], write_tools: [] });
    assert.ok(binding);
    assert.deepEqual(binding.readTools, []);
    assert.deepEqual(binding.writeTools, []);
  });
});

describe('public MCP key bindings — the in-memory store', () => {
  it('returns undefined for an unknown key', async () => {
    const store = createInMemoryPublicMcpKeyBindingStore([GOOD_ROW]);
    assert.equal(await store.get('nope'), undefined);
  });

  it('returns the binding for a known key', async () => {
    const store = createInMemoryPublicMcpKeyBindingStore([GOOD_ROW]);
    assert.equal((await store.get('key-1'))?.agentId, 'sales');
  });

  /** The in-memory store takes RAW rows on purpose: a store that accepted
   *  ready-made binding objects would bypass `normalizeBindingRow` and every
   *  test above would prove nothing about the pg path. */
  it('applies the same fail-closed normalization as the pg store', async () => {
    const store = createInMemoryPublicMcpKeyBindingStore([{ ...GOOD_ROW, enabled: 'yes' }]);
    assert.equal(await store.get('key-1'), undefined);
  });
});
