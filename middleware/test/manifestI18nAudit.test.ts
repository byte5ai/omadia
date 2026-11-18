import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { extractSetupSchema } from '../src/plugins/installService.js';
import { adaptManifestV1, type PluginCatalogEntry } from '../src/plugins/manifestLoader.js';
import { auditManifestI18n } from '../src/plugins/manifestI18nAudit.js';
import { enumOption } from '../src/plugins/manifestLocalized.js';

/**
 * #1401 — the manifest text convention: visible text is `{ en, de }`.
 *
 * Decided 2026-10-16: a bare string or a missing locale is WARNED about, never
 * rejected. These tests pin the audit (what counts as a gap), the loader's
 * one-warning-per-plugin-version behaviour, and the enum-option shape that
 * lets an option label be localized without breaking older clients.
 */

function manifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: '1',
    identity: {
      id: '@test/i18n-audit',
      name: 'I18n Audit Fixture',
      version: '1.0.0',
      description: { en: 'Fixture.', de: 'Testobjekt.' },
    },
    ...over,
  };
}

describe('auditManifestI18n', () => {
  it('passes a manifest whose visible text is all {en, de}', () => {
    const doc = manifest({
      setup: {
        guide: { en: 'Do this.', de: 'Mach das.' },
        fields: [
          {
            key: 'mode',
            type: 'enum',
            label: { en: 'Mode', de: 'Modus' },
            help: { en: 'Pick one.', de: 'Wähle eins.' },
            enum: [{ value: 'a', label: { en: 'A', de: 'A' } }],
          },
        ],
      },
    });
    assert.deepEqual(auditManifestI18n(doc), []);
  });

  it('reports bare strings and missing locales with their path', () => {
    const doc = manifest({
      identity: { id: 'x', name: 'X', version: '1.0.0', description: 'Nur deutsch.' },
      setup: {
        fields: [
          {
            key: 'base_url',
            type: 'url',
            label: 'Öffentliche Basis-URL',
            help: { en: 'Used in signed URLs.' },
            pattern_hint: { en: 'x', de: '  ' },
            enum: [{ value: 'v', label: 'Vau' }],
          },
        ],
      },
    });
    assert.deepEqual(auditManifestI18n(doc), [
      { path: 'identity.description', problem: 'bare_string' },
      { path: 'setup.fields.base_url.label', problem: 'bare_string' },
      { path: 'setup.fields.base_url.help', problem: 'missing_locale', missing: ['de'] },
      { path: 'setup.fields.base_url.pattern_hint', problem: 'missing_locale', missing: ['de'] },
      { path: 'setup.fields.base_url.enum.v.label', problem: 'bare_string' },
    ]);
  });

  it('checks setup.guide', () => {
    assert.deepEqual(auditManifestI18n(manifest({ setup: { guide: 'Nur deutsch' } })), [
      { path: 'setup.guide', problem: 'bare_string' },
    ]);
    assert.deepEqual(auditManifestI18n(manifest({ setup: { guide: { de: 'Nur deutsch' } } })), [
      { path: 'setup.guide', problem: 'missing_locale', missing: ['en'] },
    ]);
  });

  it('ignores absent texts and identity.name (names stay language-neutral)', () => {
    const doc = manifest({ setup: { fields: [{ key: 'k', type: 'string', label: { en: 'K', de: 'K' } }] } });
    assert.deepEqual(auditManifestI18n(doc), []);
  });
});

describe('manifestLoader — warns, never rejects (#1401)', () => {
  function captureWarnings(run: () => void): string[] {
    const original = console.warn;
    const lines: string[] = [];
    console.warn = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      run();
    } finally {
      console.warn = original;
    }
    return lines;
  }

  it('loads a bare-string manifest and warns once per plugin version', () => {
    const doc = manifest({
      identity: {
        id: '@test/i18n-warn-once',
        name: 'Warn Once',
        version: '2.0.0',
        description: 'Nur deutsch.',
      },
      setup: { fields: [{ key: 'k', type: 'string', label: 'Schlüssel' }] },
    });
    const lines = captureWarnings(() => {
      assert.ok(adaptManifestV1(doc), 'a bare-string manifest must still load');
      assert.ok(adaptManifestV1(doc), 'and load again on a catalog reload');
    });
    const i18n = lines.filter((l) => l.includes('not {en, de} maps'));
    assert.equal(i18n.length, 1, lines.join('\n'));
    assert.match(i18n[0] ?? '', /@test\/i18n-warn-once' 2\.0\.0: 2 visible text/);
    assert.match(i18n[0] ?? '', /setup\.fields\.k\.label \(plain text\)/);
  });

  it('warns again for a new version, and caps the listed paths at five', () => {
    const fields = Array.from({ length: 7 }, (_, i) => ({ key: `f${String(i)}`, type: 'string', label: `Feld ${String(i)}` }));
    const doc = (version: string): Record<string, unknown> =>
      manifest({
        identity: { id: '@test/i18n-versions', name: 'V', version, description: { en: 'a', de: 'b' } },
        setup: { fields },
      });
    const lines = captureWarnings(() => {
      adaptManifestV1(doc('1.0.0'));
      adaptManifestV1(doc('1.0.1'));
    }).filter((l) => l.includes('not {en, de} maps'));
    assert.equal(lines.length, 2, lines.join('\n'));
    assert.match(lines[1] ?? '', /1\.0\.1: 7 visible text/);
    assert.match(lines[1] ?? '', /\(\+2 more\)/);
    assert.equal((lines[1]?.match(/\(plain text\)/g) ?? []).length, 5);
  });

  it('does not warn about a manifest it rejects', () => {
    const lines = captureWarnings(() => {
      adaptManifestV1(
        manifest({ identity: { id: 'Bad Id', name: 'B', version: '1.0.0', description: 'Nur deutsch.' } }),
      );
    });
    assert.equal(lines.filter((l) => l.includes('not {en, de} maps')).length, 0);
  });

  it('says nothing for a fully localized manifest', () => {
    const lines = captureWarnings(() => {
      adaptManifestV1(
        manifest({ identity: { id: '@test/i18n-clean', name: 'C', version: '1.0.0', description: { en: 'a', de: 'b' } } }),
      );
    });
    assert.equal(lines.filter((l) => l.includes('not {en, de} maps')).length, 0);
  });

  it('carries localized enum labels through, keeping label as English', () => {
    const plugin = adaptManifestV1(
      manifest({
        setup: {
          fields: [
            {
              key: 'level',
              type: 'enum',
              label: { en: 'Level', de: 'Stufe' },
              enum: [
                { value: 'low', label: { en: 'Low', de: 'Niedrig' } },
                { value: 'raw', label: 'Raw' },
                { value: 'bare' },
              ],
            },
          ],
        },
      }),
    );
    assert.deepEqual(plugin?.setup_fields[0]?.enum, [
      { value: 'low', label: 'Low', label_localized: { en: 'Low', de: 'Niedrig' } },
      { value: 'raw', label: 'Raw' },
      { value: 'bare', label: 'bare' },
    ]);
  });
});

describe('enumOption', () => {
  it('falls back to German, then the value, when a map has no English', () => {
    assert.deepEqual(enumOption('v', { de: 'Wert' }), {
      value: 'v',
      label: 'Wert',
      label_localized: { de: 'Wert' },
    });
    assert.deepEqual(enumOption('v', { en: '  ' }), { value: 'v', label: 'v' });
  });
});

describe('install schema — localized enum labels (#1401)', () => {
  it('extractSetupSchema keeps label English and adds label_localized', () => {
    const entry = {
      plugin: { id: '@test/i18n-schema', name: 'S', version: '1.0.0' },
      manifest: {
        setup: {
          fields: [
            {
              key: 'level',
              type: 'enum',
              label: { en: 'Level', de: 'Stufe' },
              enum: [
                { value: 'low', label: { en: 'Low', de: 'Niedrig' } },
                { value: 'raw', label: 'Raw' },
              ],
            },
          ],
        },
      },
      source_path: '<test>',
      source_kind: 'manifest-v1',
      origin: 'installed',
    } as unknown as PluginCatalogEntry;
    const schema = extractSetupSchema(entry);
    assert.deepEqual(schema?.fields[0]?.enum, [
      { value: 'low', label: 'Low', label_localized: { en: 'Low', de: 'Niedrig' } },
      { value: 'raw', label: 'Raw' },
    ]);
  });
});
