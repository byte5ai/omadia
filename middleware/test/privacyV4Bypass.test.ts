/**
 * Slice 2.5 — Operator-owned per-plugin Privacy Mode tests.
 *
 * Covers the contract layer end-to-end:
 *   - `resolveEffectivePrivacyMode` pure-function semantics (default,
 *     bypass, per-tool whitelist, org-policy override)
 *   - `parseScopes` tolerates both array and comma-separated string
 *   - `PrivacyGuardService.recordBypassedTool` accumulates entries and
 *     drains them into the receipt at `finalizeTurn`
 *   - `PrivacyGuardService.finalizeTurn` emits a receipt for bypass-only
 *     turns (datasetsInterned === 0) — previously short-circuited.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  PRIVACY_FORCE_GUARDED_ENV_VAR,
  parseScopes,
  resolveEffectivePrivacyMode,
} from '@omadia/plugin-api';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';

describe('resolveEffectivePrivacyMode', () => {
  it('defaults to guarded when no mode is stored', () => {
    const eff = resolveEffectivePrivacyMode({
      storedMode: undefined,
      storedScopes: undefined,
      toolName: 'confluence_search',
      env: {},
    });
    assert.equal(eff, 'guarded');
  });

  it('honors stored guarded explicitly', () => {
    assert.equal(
      resolveEffectivePrivacyMode({
        storedMode: 'guarded',
        storedScopes: undefined,
        toolName: 't',
        env: {},
      }),
      'guarded',
    );
  });

  it('honors stored bypass for every tool name', () => {
    for (const toolName of ['a', 'b', 'confluence_get_page']) {
      assert.equal(
        resolveEffectivePrivacyMode({
          storedMode: 'bypass',
          storedScopes: undefined,
          toolName,
          env: {},
        }),
        'bypass',
      );
    }
  });

  it('per_tool: bypass iff tool name is in the array whitelist', () => {
    const scopes = ['confluence_get_page', 'confluence_get_page_by_title'];
    assert.equal(
      resolveEffectivePrivacyMode({
        storedMode: 'per_tool',
        storedScopes: scopes,
        toolName: 'confluence_get_page',
        env: {},
      }),
      'bypass',
    );
    assert.equal(
      resolveEffectivePrivacyMode({
        storedMode: 'per_tool',
        storedScopes: scopes,
        toolName: 'confluence_search',
        env: {},
      }),
      'guarded',
    );
  });

  it('per_tool: bypass iff tool name is in the comma-separated string whitelist', () => {
    const scopes = 'confluence_get_page, confluence_get_page_by_title';
    assert.equal(
      resolveEffectivePrivacyMode({
        storedMode: 'per_tool',
        storedScopes: scopes,
        toolName: 'confluence_get_page_by_title',
        env: {},
      }),
      'bypass',
    );
    assert.equal(
      resolveEffectivePrivacyMode({
        storedMode: 'per_tool',
        storedScopes: scopes,
        toolName: 'confluence_search',
        env: {},
      }),
      'guarded',
    );
  });

  it('OMADIA_PRIVACY_FORCE_GUARDED overrides bypass back to guarded', () => {
    assert.equal(
      resolveEffectivePrivacyMode({
        storedMode: 'bypass',
        storedScopes: undefined,
        toolName: 't',
        env: { [PRIVACY_FORCE_GUARDED_ENV_VAR]: 'true' },
      }),
      'guarded',
    );
    assert.equal(
      resolveEffectivePrivacyMode({
        storedMode: 'per_tool',
        storedScopes: ['t'],
        toolName: 't',
        env: { [PRIVACY_FORCE_GUARDED_ENV_VAR]: 'true' },
      }),
      'guarded',
    );
  });

  it('FORCE_GUARDED only triggers on the literal string "true"', () => {
    for (const v of ['1', 'yes', 'True', 'TRUE', '']) {
      assert.equal(
        resolveEffectivePrivacyMode({
          storedMode: 'bypass',
          storedScopes: undefined,
          toolName: 't',
          env: { [PRIVACY_FORCE_GUARDED_ENV_VAR]: v },
        }),
        'bypass',
        `value "${v}" should NOT force guarded — only literal "true" does`,
      );
    }
  });

  it('falls back to guarded on garbage stored modes', () => {
    for (const garbage of [42, null, {}, [], 'GUARDED', 'YES']) {
      assert.equal(
        resolveEffectivePrivacyMode({
          storedMode: garbage,
          storedScopes: undefined,
          toolName: 't',
          env: {},
        }),
        'guarded',
      );
    }
  });
});

describe('parseScopes', () => {
  it('parses an array of strings', () => {
    assert.deepEqual(parseScopes(['a', 'b']), ['a', 'b']);
  });

  it('trims and drops empty entries from an array', () => {
    assert.deepEqual(parseScopes([' a ', '', ' b']), ['a', 'b']);
  });

  it('splits a comma- and whitespace-separated string', () => {
    assert.deepEqual(parseScopes('a,b, c   d'), ['a', 'b', 'c', 'd']);
  });

  it('returns [] for non-array, non-string input', () => {
    for (const v of [undefined, null, 42, {}, true]) {
      assert.deepEqual(parseScopes(v), []);
    }
  });

  it('returns [] for an empty string', () => {
    assert.deepEqual(parseScopes(''), []);
  });
});

describe('PrivacyGuardService.recordBypassedTool', () => {
  it('accumulates entries and emits them on finalizeTurn', async () => {
    const svc = createPrivacyGuardService();
    const turnId = 't-bypass-1';
    await svc.recordBypassedTool({
      turnId,
      toolName: 'confluence_get_page',
      pluginId: '@omadia/integration-confluence',
      reason: 'operator_setting',
      bytes: 1024,
    });
    await svc.recordBypassedTool({
      turnId,
      toolName: 'confluence_get_page_by_title',
      pluginId: '@omadia/integration-confluence',
      reason: 'operator_setting',
      bytes: 2048,
    });
    const receipt = await svc.finalizeTurn(turnId);
    assert.ok(receipt, 'bypass-only turn must still emit a receipt');
    assert.equal(receipt.datasetsInterned, 0);
    assert.equal(receipt.fieldsMasked, 0);
    assert.equal(receipt.fieldsCleartext, 0);
    assert.deepEqual(receipt.verbsExecuted, []);
    assert.equal(receipt.pseudonymProjectionUsed, false);
    assert.ok(receipt.bypassedTools);
    assert.equal(receipt.bypassedTools.length, 2);
    assert.equal(receipt.bypassedTools[0]?.toolName, 'confluence_get_page');
    assert.equal(receipt.bypassedTools[0]?.bytes, 1024);
    assert.equal(receipt.bypassedTools[1]?.bytes, 2048);
    // PII-free check — the receipt carries no raw values, only metadata.
    for (const entry of receipt.bypassedTools) {
      assert.equal(entry.reason, 'operator_setting');
      assert.equal(typeof entry.toolName, 'string');
      assert.equal(typeof entry.pluginId, 'string');
      assert.equal(typeof entry.bytes, 'number');
    }
  });

  it('drops bypass state on finalizeTurn (no leakage to next turn)', async () => {
    const svc = createPrivacyGuardService();
    await svc.recordBypassedTool({
      turnId: 't-a',
      toolName: 't',
      pluginId: 'p',
      reason: 'operator_setting',
      bytes: 1,
    });
    await svc.finalizeTurn('t-a');
    const receipt2 = await svc.finalizeTurn('t-a');
    assert.equal(receipt2, undefined, 'second finalize of same turn is idempotent');
  });

  it('co-exists with internToolResultV4: receipt carries both counts and bypassed list', async () => {
    const svc = createPrivacyGuardService();
    const turnId = 't-mix';
    await svc.internToolResultV4({
      sessionId: 's',
      turnId,
      toolName: 'confluence_search',
      rawResult: JSON.stringify([
        { id: 1, title: 'OKR' },
        { id: 2, title: 'Vacation' },
      ]),
    });
    await svc.recordBypassedTool({
      turnId,
      toolName: 'confluence_get_page',
      pluginId: '@omadia/integration-confluence',
      reason: 'operator_setting',
      bytes: 8192,
    });
    const receipt = await svc.finalizeTurn(turnId);
    assert.ok(receipt);
    assert.equal(receipt.datasetsInterned, 1);
    assert.ok((receipt.bypassedTools ?? []).length === 1);
  });

  it('returns undefined when a turn neither intern nor bypassed', async () => {
    const svc = createPrivacyGuardService();
    const receipt = await svc.finalizeTurn('t-empty');
    assert.equal(receipt, undefined);
  });
});
