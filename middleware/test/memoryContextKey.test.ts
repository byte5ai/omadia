import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';

import { memoryContextKey } from '../packages/harness-channel-sdk/src/scopeId.js';

/**
 * W5 memory-ACL — `memoryContextKey`, the single choke point every tier path
 * goes through (design: issue #870 §3).
 *
 * The property under test is INJECTIVITY, not prettiness. Once the context key
 * partitions memory it is a security boundary: two distinct chat contexts that
 * map to one key share one memory tree while every equality check in the store
 * still passes. `scopeGraphKey` (#575 D3) measured that exact failure for the
 * old `sanitizeScope` collapse; this suite is the guard that the replacement
 * does not reintroduce it.
 *
 * Pollution guard: this function is pure and this file holds no fixtures —
 * every case builds its own inputs inline (no module-level shared state).
 */

/** The digest half of the construction, recomputed independently of the impl. */
const digestOf = (raw: string): string =>
  createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);

/** The alphabet the store grammar and the physical path layout can accept. */
const KEY_SHAPE = /^[a-z0-9_-]{1,64}~[a-z0-9_-]{1,64}$/;

describe('W5 memoryContextKey — documented shapes', () => {
  it('digests a Teams conversation id, which carries the `:` and `@` that break sanitizing', () => {
    // The literal shape of a Teams channel conversation id.
    const nativeId = '19:abc@thread.tacv2';
    assert.equal(
      memoryContextKey('teams', nativeId),
      `teams~19-abc-thread-tacv2-${digestOf(nativeId)}`,
    );
  });

  it('carries a Telegram group id through byte-identically — it is already lossless', () => {
    // Negative chat ids are digits and a leading '-': inside the safe alphabet,
    // so no digest is added and no existing partition would ever move.
    assert.equal(memoryContextKey('telegram', '-1001234567890'), 'telegram~-1001234567890');
  });

  it('carries an API tenant id through byte-identically', () => {
    assert.equal(memoryContextKey('api', 'tenant-acme'), 'api~tenant-acme');
  });
});

describe('W5 memoryContextKey — injectivity (the security property)', () => {
  it('separates a punctuated Teams id from the literal that sanitizing collapses it onto', () => {
    // `sanitizeScope` mapped BOTH of these to `19-abc-thread-tacv2`.
    const punctuated = memoryContextKey('teams', '19:abc@thread.tacv2');
    const literal = memoryContextKey('teams', '19-abc-thread-tacv2');
    assert.notEqual(punctuated, literal);
    assert.equal(literal, 'teams~19-abc-thread-tacv2');
  });

  it('separates a whole family of ids that share one sanitized stem', () => {
    // Every one of these sanitizes to the stem `teams-c1`.
    const family = ['teams:c1', 'teams::c1', 'teams@c1', 'teams.c1', 'teams/c1', 'teams c1'];
    const keys = family.map((id) => memoryContextKey('teams', id));
    assert.equal(new Set(keys).size, family.length, keys.join(' | '));
    // The safe spelling of the same stem is the seventh distinct partition.
    assert.ok(!keys.includes(memoryContextKey('teams', 'teams-c1')));
  });

  it('separates 200-character ids that agree on their first 100 characters', () => {
    const shared = 'x'.repeat(100);
    const a = `${shared}${'a'.repeat(100)}`;
    const b = `${shared}${'b'.repeat(100)}`;
    assert.equal(a.length, 200);
    assert.notEqual(memoryContextKey('teams', a), memoryContextKey('teams', b));
  });

  it('separates ids that differ only in case — the safe alphabet is lowercase', () => {
    assert.notEqual(memoryContextKey('teams', 'C1'), memoryContextKey('teams', 'c1'));
  });

  it('separates ids that differ only in surrounding whitespace — an id is identity, not a token', () => {
    assert.notEqual(memoryContextKey('teams', ' c1'), memoryContextKey('teams', 'c1'));
  });

  it('separates the same native id across channel types', () => {
    const keys = ['teams', 'telegram', 'api', 'http'].map((type) => memoryContextKey(type, 'c1'));
    assert.equal(new Set(keys).size, keys.length);
  });

  it('keeps every adversarial input in its own partition', () => {
    const inputs = [
      '',
      ' ',
      '-',
      '@@@',
      ':',
      '::',
      'c1',
      'C1',
      ' c1',
      'c1 ',
      'teams:c1',
      'teams-c1',
      '19:abc@thread.tacv2',
      '19-abc-thread-tacv2',
      '-1001234567890',
      '1001234567890',
      'x'.repeat(64),
      'x'.repeat(65),
      'x'.repeat(200),
      `${'x'.repeat(100)}a`,
      `${'x'.repeat(100)}b`,
      'tenant-acme',
      'tenant.acme',
    ];
    const keys = inputs.map((id) => memoryContextKey('teams', id));
    assert.equal(new Set(keys).size, inputs.length, keys.join('\n'));
  });
});

describe('W5 memoryContextKey — idempotence for already-safe ids', () => {
  it('returns a safe id byte-identically, so no partition that was never at risk moves', () => {
    for (const id of ['c1', 'tenant-acme', 'a_b-c9', '-1001234567890', 'x'.repeat(64)]) {
      assert.equal(memoryContextKey('teams', id), `teams~${id}`, `id=${id}`);
    }
  });

  it('is stable when a produced id segment is fed back in', () => {
    const once = memoryContextKey('teams', '19:abc@thread.tacv2');
    const idSegment = once.slice(once.indexOf('~') + 1);
    assert.equal(memoryContextKey('teams', idSegment), `teams~${idSegment}`);
  });

  it('normalises the channel type by case and whitespace — it is a type token, not identity', () => {
    const canonical = memoryContextKey('teams', 'c1');
    for (const type of ['teams', 'Teams', 'TEAMS', ' teams ']) {
      assert.equal(memoryContextKey(type, 'c1'), canonical, `type=${type}`);
    }
  });
});

describe('W5 memoryContextKey — the key can never break the pattern format', () => {
  const HOSTILE = [
    '19:abc@thread.tacv2',
    'team:x:*',
    'a~b',
    '../../etc/passwd',
    'c1/../../other',
    'ümläut',
    '',
    '@@@',
    'x'.repeat(300),
    'a\nb',
    'a b',
  ];

  it('never emits a `:` — `team:<ctxKey>:*` stays parseable', () => {
    for (const id of HOSTILE) {
      for (const type of ['teams', 'a:b', 'a~b', '']) {
        assert.ok(
          !memoryContextKey(type, id).includes(':'),
          `type=${JSON.stringify(type)} id=${JSON.stringify(id)}`,
        );
      }
    }
  });

  it('always matches the safe key shape and stays inside the segment budget', () => {
    for (const id of HOSTILE) {
      for (const type of ['teams', 'a:b', 'a~b', '', ' ']) {
        const key = memoryContextKey(type, id);
        assert.match(key, KEY_SHAPE, `type=${JSON.stringify(type)} id=${JSON.stringify(id)}`);
      }
    }
  });

  it('splits back into channel type and id at exactly one `~`', () => {
    for (const id of HOSTILE) {
      const key = memoryContextKey('teams', id);
      assert.equal(key.split('~').length, 2, key);
      assert.equal(key.split('~')[0], 'teams');
    }
  });

  it('never throws on the message path, whatever the producer hands over', () => {
    // Coordinator decision 3: an unparseable origin narrows the scope, it never
    // throws mid-turn. This function is on that path.
    assert.doesNotThrow(() => memoryContextKey('', ''));
    assert.doesNotThrow(() => memoryContextKey('teams', '\u0000\uFFFD'));
  });
});
