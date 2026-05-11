import { describe, expect, it } from 'vitest';

import {
  blankNodeForType,
  detectType,
  ensureTopLevelObject,
  isValidPropertyKey,
  type JsonSchemaNode,
} from '../jsonSchemaShape';

describe('jsonSchemaShape', () => {
  describe('detectType', () => {
    it('returns the explicit type for primitives', () => {
      expect(detectType({ type: 'string' })).toBe('string');
      expect(detectType({ type: 'integer' })).toBe('integer');
      expect(detectType({ type: 'boolean' })).toBe('boolean');
    });

    it('returns enum when an enum array is present', () => {
      expect(detectType({ enum: ['a', 'b'] })).toBe('enum');
    });

    it('detects array and object', () => {
      expect(detectType({ type: 'array', items: { type: 'string' } })).toBe(
        'array',
      );
      expect(detectType({ type: 'object', properties: {} })).toBe('object');
    });

    it('falls back to string for unknown shapes', () => {
      expect(detectType({} as JsonSchemaNode)).toBe('string');
    });
  });

  describe('blankNodeForType', () => {
    it('returns minimal valid nodes', () => {
      expect(blankNodeForType('integer')).toEqual({ type: 'integer' });
      expect(blankNodeForType('enum')).toEqual({ type: 'string', enum: [] });
      expect(blankNodeForType('array')).toEqual({
        type: 'array',
        items: { type: 'string' },
      });
      expect(blankNodeForType('object')).toEqual({
        type: 'object',
        properties: {},
        required: [],
      });
    });
  });

  describe('ensureTopLevelObject', () => {
    it('produces a default object when input is undefined', () => {
      const result = ensureTopLevelObject(undefined);
      expect(result.type).toBe('object');
      expect(result.properties).toEqual({});
      expect(result.required).toEqual([]);
    });

    it('coerces a non-object input into an object shape', () => {
      const result = ensureTopLevelObject({
        type: 'string',
        description: 'should not happen',
      });
      expect(result.type).toBe('object');
      expect(result.description).toBe('should not happen');
    });

    it('preserves existing object properties and required', () => {
      const result = ensureTopLevelObject({
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a'],
      });
      expect(result.properties).toEqual({ a: { type: 'string' } });
      expect(result.required).toEqual(['a']);
    });
  });

  describe('isValidPropertyKey', () => {
    it('accepts identifier-like keys', () => {
      expect(isValidPropertyKey('foo')).toBe(true);
      expect(isValidPropertyKey('foo_bar')).toBe(true);
      expect(isValidPropertyKey('_private')).toBe(true);
      expect(isValidPropertyKey('camelCase')).toBe(true);
    });

    it('rejects invalid keys', () => {
      expect(isValidPropertyKey('')).toBe(false);
      expect(isValidPropertyKey('1foo')).toBe(false);
      expect(isValidPropertyKey('with space')).toBe(false);
      expect(isValidPropertyKey('dot.notation')).toBe(false);
    });
  });
});
