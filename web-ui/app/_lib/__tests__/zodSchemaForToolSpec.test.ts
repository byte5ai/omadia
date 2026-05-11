import { describe, expect, it } from 'vitest';

import {
  TOOL_ID_PATTERN,
  validateToolDescription,
  validateToolFields,
  validateToolId,
} from '../zodSchemaForToolSpec';

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
      expect(validateToolId('list_things')).toBeUndefined();
    });

    it('reports empty', () => {
      expect(validateToolId('')).toMatch(/leer/);
    });

    it('reports format errors', () => {
      expect(validateToolId('Bad-Id')).toMatch(/snake_case/);
    });
  });

  describe('validateToolDescription', () => {
    it('rejects whitespace-only', () => {
      expect(validateToolDescription('   ')).toMatch(/leer/);
    });

    it('accepts non-empty descriptions', () => {
      expect(validateToolDescription('liste alle Resources')).toBeUndefined();
    });
  });

  describe('validateToolFields', () => {
    it('returns empty object when valid', () => {
      expect(
        validateToolFields({ id: 'foo', description: 'bar' }),
      ).toEqual({});
    });

    it('returns both field errors when both are bad', () => {
      const errs = validateToolFields({ id: 'Bad', description: '' });
      expect(errs.id).toBeDefined();
      expect(errs.description).toBeDefined();
    });
  });
});
