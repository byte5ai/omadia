import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deletePersonalTemplate,
  listCuratedTemplates,
  listPersonalTemplates,
  savePersonalTemplate,
} from '../toolTemplates';

describe('toolTemplates', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  describe('listCuratedTemplates', () => {
    it('returns 6 hand-pinned templates', () => {
      const list = listCuratedTemplates();
      expect(list).toHaveLength(6);
      expect(list.every((t) => t.source === 'curated')).toBe(true);
    });

    it('exposes well-formed ToolSpecs', () => {
      for (const t of listCuratedTemplates()) {
        expect(t.tool.id).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(t.tool.description.length).toBeGreaterThan(0);
        expect(t.tool.input).toBeDefined();
      }
    });
  });

  describe('personal templates', () => {
    it('starts empty', () => {
      expect(listPersonalTemplates()).toEqual([]);
    });

    it('save → list → delete round-trips', () => {
      const saved = savePersonalTemplate({
        label: 'My REST',
        tool: {
          id: 'my_rest',
          description: 'custom REST',
          input: { type: 'object', properties: {}, required: [] },
        },
      });
      expect(saved.source).toBe('personal');
      const listed = listPersonalTemplates();
      expect(listed).toHaveLength(1);
      expect(listed[0]?.label).toBe('My REST');
      deletePersonalTemplate(saved.id);
      expect(listPersonalTemplates()).toEqual([]);
    });

    it('returns [] when localStorage holds malformed JSON', () => {
      window.localStorage.setItem('byte5.builder.toolTemplates', '{not json');
      expect(listPersonalTemplates()).toEqual([]);
    });
  });
});
