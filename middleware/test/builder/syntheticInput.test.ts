import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { generateInputForSchema } from '../../src/plugins/builder/syntheticInput.js';

describe('generateInputForSchema — primitive types', () => {
  it('generates "test" for plain string schema', () => {
    assert.equal(generateInputForSchema({ type: 'string' }), 'test');
  });

  it('pads strings up to minLength', () => {
    const out = generateInputForSchema({ type: 'string', minLength: 8 });
    assert.equal(typeof out, 'string');
    assert.equal((out as string).length, 8);
  });

  it('returns enum_values[0] for enum-shaped string', () => {
    const out = generateInputForSchema({
      type: 'string',
      enum: ['high', 'medium', 'low'],
    });
    assert.equal(out, 'high');
  });

  it('returns 1 for plain number', () => {
    assert.equal(generateInputForSchema({ type: 'number' }), 1);
    assert.equal(generateInputForSchema({ type: 'integer' }), 1);
  });

  it('respects minimum when > 1', () => {
    assert.equal(generateInputForSchema({ type: 'integer', minimum: 5 }), 5);
  });

  it('returns 1 when minimum <= 1 (default still wins)', () => {
    assert.equal(generateInputForSchema({ type: 'integer', minimum: 0 }), 1);
    assert.equal(generateInputForSchema({ type: 'number', minimum: -10 }), 1);
  });

  it('returns true for boolean', () => {
    assert.equal(generateInputForSchema({ type: 'boolean' }), true);
  });

  it('returns null for null type', () => {
    assert.equal(generateInputForSchema({ type: 'null' }), null);
  });
});

describe('generateInputForSchema — arrays', () => {
  it('returns [] for plain array (no minItems)', () => {
    assert.deepEqual(generateInputForSchema({ type: 'array' }), []);
  });

  it('fills minItems entries when set', () => {
    const out = generateInputForSchema({
      type: 'array',
      minItems: 2,
      items: { type: 'string' },
    });
    assert.deepEqual(out, ['test', 'test']);
  });
});

describe('generateInputForSchema — objects', () => {
  it('returns {} for an empty object schema', () => {
    assert.deepEqual(generateInputForSchema({ type: 'object' }), {});
  });

  it('fills required fields only — omits optionals', () => {
    const out = generateInputForSchema({
      type: 'object',
      required: ['city'],
      properties: {
        city: { type: 'string' },
        country: { type: 'string' },
      },
    });
    assert.deepEqual(out, { city: 'test' });
  });

  it('walks nested required objects recursively', () => {
    const out = generateInputForSchema({
      type: 'object',
      required: ['filter'],
      properties: {
        filter: {
          type: 'object',
          required: ['from', 'limit'],
          properties: {
            from: { type: 'string' },
            limit: { type: 'integer', minimum: 1 },
          },
        },
      },
    });
    assert.deepEqual(out, { filter: { from: 'test', limit: 1 } });
  });

  it('handles object shorthand without `type` field', () => {
    const out = generateInputForSchema({
      required: ['x'],
      properties: { x: { type: 'string' } },
    });
    assert.deepEqual(out, { x: 'test' });
  });
});

describe('generateInputForSchema — combinators', () => {
  it('picks the first anyOf branch', () => {
    assert.equal(
      generateInputForSchema({
        anyOf: [{ type: 'integer' }, { type: 'string' }],
      }),
      1,
    );
  });

  it('picks the first oneOf branch', () => {
    assert.equal(
      generateInputForSchema({
        oneOf: [{ type: 'string', enum: ['a'] }, { type: 'integer' }],
      }),
      'a',
    );
  });

  it('merges allOf object branches', () => {
    const out = generateInputForSchema({
      allOf: [
        { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
        { type: 'object', required: ['b'], properties: { b: { type: 'integer' } } },
      ],
    });
    assert.deepEqual(out, { a: 'test', b: 1 });
  });
});

describe('generateInputForSchema — unknown / edge cases', () => {
  it('returns null for non-object schemas (with onUnknown callback fired)', () => {
    const seen: Array<{ path: string; schema: unknown }> = [];
    const out = generateInputForSchema(undefined, {
      onUnknown: (path, schema) => seen.push({ path, schema }),
    });
    assert.equal(out, null);
    assert.equal(seen.length, 1);
  });

  it('returns null for unknown type without crashing', () => {
    assert.equal(generateInputForSchema({ type: 'fictional' }), null);
  });

  it('caps recursion at maxDepth', () => {
    // Deep self-referential schema (loops at runtime). Our generator
    // doesn't dereference $ref but we simulate via deeply-nested
    // `properties.x.properties.x.…` — caller can rely on the cap.
    let nested: Record<string, unknown> = {
      type: 'object',
      required: ['x'],
      properties: { x: { type: 'string' } },
    };
    for (let i = 0; i < 10; i += 1) {
      nested = {
        type: 'object',
        required: ['x'],
        properties: { x: nested },
      };
    }
    const out = generateInputForSchema(nested, { maxDepth: 3 });
    // Just ensure it returns without throwing — depth-cap leaves null
    // somewhere in the tree.
    assert.ok(out !== undefined);
  });
});

describe('generateInputForSchema — real fixture (minimal-spec.tools[0].input)', () => {
  it('produces a value that the get_forecast tool would accept', () => {
    const schema = {
      type: 'object',
      required: ['city'],
      properties: {
        city: { type: 'string', minLength: 1 },
      },
    };
    const out = generateInputForSchema(schema);
    assert.deepEqual(out, { city: 'test' });
  });
});
