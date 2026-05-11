import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  isReservedToolId,
  registerReservedExact,
  registerReservedPrefix,
  getReservedSnapshot,
} from '../../src/plugins/reservedNames.js';

describe('reservedNames', () => {
  describe('isReservedToolId', () => {
    it('flags built-in exact tool ids', () => {
      assert.equal(isReservedToolId('query_memory').reserved, true);
      assert.equal(isReservedToolId('query_knowledge_graph').reserved, true);
      assert.equal(isReservedToolId('chat_agent').reserved, true);
      assert.equal(isReservedToolId('verifier').reserved, true);
    });

    it('flags built-in prefix matches', () => {
      assert.equal(isReservedToolId('query_odoo_invoices').reserved, true);
      assert.equal(isReservedToolId('query_confluence_pages').reserved, true);
      assert.equal(isReservedToolId('query_microsoft365_mail').reserved, true);
    });

    it('does not flag unrelated tool ids', () => {
      assert.equal(isReservedToolId('get_weather').reserved, false);
      assert.equal(isReservedToolId('query_weather_forecast').reserved, false);
      assert.equal(isReservedToolId('search_books').reserved, false);
    });

    it('returns a useful reason on hits', () => {
      const exact = isReservedToolId('query_memory');
      assert.equal(exact.reserved, true);
      if (exact.reserved) {
        assert.match(exact.reason, /reserved/);
      }

      const prefix = isReservedToolId('query_odoo_anything');
      assert.equal(prefix.reserved, true);
      if (prefix.reserved) {
        assert.match(prefix.reason, /query_odoo_/);
      }
    });
  });

  describe('register API', () => {
    it('extends the exact set', () => {
      registerReservedExact('plugin_specific_tool');
      assert.equal(isReservedToolId('plugin_specific_tool').reserved, true);
    });

    it('extends the prefix set', () => {
      registerReservedPrefix('plugin_namespace_');
      assert.equal(isReservedToolId('plugin_namespace_anything').reserved, true);
      assert.equal(isReservedToolId('plugin_namespace_other').reserved, true);
    });

    it('rejects prefixes not ending in underscore', () => {
      assert.throws(() => registerReservedPrefix('bad_prefix'));
    });

    it('rejects empty exact names', () => {
      assert.throws(() => registerReservedExact(''));
    });
  });

  describe('snapshot', () => {
    it('returns sorted exact and prefix lists', () => {
      const snap = getReservedSnapshot();
      assert.deepEqual([...snap.exact], [...snap.exact].sort());
      assert.deepEqual([...snap.prefixes], [...snap.prefixes].sort());
      assert.ok(snap.exact.includes('query_memory'));
      assert.ok(snap.prefixes.includes('query_odoo_'));
    });
  });
});
