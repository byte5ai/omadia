import { describe, expect, it } from 'vitest';

import {
  TOOL_ID_PATTERN,
  validateToolDescription,
  validateToolFields,
  validateToolId,
  type TFn,
} from '../zodSchemaForToolSpec';

/** Fake translator (TFn pattern, see messages/README.md) — returns the
 *  key so assertions stay catalog-independent. */
const t: TFn = (key) => key;

describe('zodSchemaForToolSpec', () => {
  describe('TOOL_ID_PATTERN', () => {
    it('matches snake_case ids', () => {
      expect(TOOL_ID_PATTERN.test('list_resources')).toBe(true);
      expect(TOOL_ID_PATTERN.test('a')).toBe(true);
    });

    it('rejects invalid ids', () => {
      expect(TOOL_ID_PATTERN.test('1foo')).toBe(false);
      expect(TOOL_ID_PATTERN.test('FOO')).toBe(false);
      expect(TOOL_ID_PATTERN.test('foo bar')).toBe(false);
      expect(TOOL_ID_PATTERN.test('foo.bar')).toBe(false);
    });
  });

  describe('validateToolId', () => {
    it('returns undefined for valid ids', () => {
      expect(validateToolId('list_things', t)).toBeUndefined();
    });

    it('reports empty', () => {
      expect(validateToolId('', t)).toBe('idEmpty');
    });

    it('reports format errors', () => {
      expect(validateToolId('Bad-Id', t)).toBe('idFormat');
    });
  });

  describe('validateToolDescription', () => {
    it('rejects whitespace-only', () => {
      expect(validateToolDescription('   ', t)).toBe('descriptionEmpty');
    });

    it('accepts non-empty descriptions', () => {
      expect(validateToolDescription('liste alle Resources', t)).toBeUndefined();
    });
  });

  describe('validateToolFields', () => {
    it('returns empty object when valid', () => {
      expect(
        validateToolFields({ id: 'foo', description: 'bar' }, t),
      ).toEqual({});
    });

    it('returns both field errors when both are bad', () => {
      const errs = validateToolFields({ id: 'Bad', description: '' }, t);
      expect(errs.id).toBe('idFormat');
      expect(errs.description).toBe('descriptionEmpty');
    });
  });
});
