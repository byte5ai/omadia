import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyTemplateSlots,
  checkTemplateManifest,
  extractSlotRefs,
  resolveLocalizedText,
  validate,
  type KnownRefs,
  type LocalizedText,
  type TemplateManifest,
  type TemplateSlotKind,
  type TemplateSlotMapping,
} from '@omadia/conductor-core';

import { loadTemplateCatalog } from '../src/conductor/templateCatalog.js';
import { isValidCron } from '../src/scheduler/cron.js';

// Conductor workflow templates (#429) — CI gate over the bundled catalog.
// This is the hard check that the shipped templates can never drift from the
// engine: the loader itself skips broken assets instead of failing boot.

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../src/conductor/templates');

const SLOT_KINDS: readonly TemplateSlotKind[] = ['agents', 'actions', 'roles', 'events', 'channels'];

const files = readdirSync(TEMPLATES_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();

const manifests = files.map((file) => ({
  file,
  manifest: JSON.parse(readFileSync(join(TEMPLATES_DIR, file), 'utf8')) as TemplateManifest,
}));

/** Every declared slot mapped to a synthetic entity id `test-<kind>-<key>`. */
function syntheticMapping(manifest: TemplateManifest): TemplateSlotMapping {
  const mapping: TemplateSlotMapping = {};
  for (const kind of SLOT_KINDS) {
    for (const slot of manifest.slots[kind] ?? []) {
      (mapping[kind] ??= {})[slot.key] = `test-${kind}-${slot.key}`;
    }
  }
  return mapping;
}

/** KnownRefs containing exactly the synthetic mapping values (channels have no
 *  KnownRefs dimension — the engine does not validate channel ids). */
function syntheticKnownRefs(mapping: TemplateSlotMapping): KnownRefs {
  return {
    agentIds: Object.values(mapping.agents ?? {}),
    actionIds: Object.values(mapping.actions ?? {}),
    roleKeys: Object.values(mapping.roles ?? {}),
    eventIds: Object.values(mapping.events ?? {}),
  };
}

describe('bundled conductor template catalog', () => {
  it('ships exactly the four v1 templates', () => {
    assert.deepEqual(
      manifests.map((m) => m.manifest.id).sort(),
      ['expense-approval', 'notify-and-escalate', 'onboarding-checklist', 'weekly-report'],
    );
  });

  it('catalog ids are unique and kebab-case', () => {
    const ids = manifests.map((m) => m.manifest.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) {
      assert.match(id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `id '${id}' is not kebab-case`);
    }
  });

  for (const { file, manifest } of manifests) {
    describe(file, () => {
      it('passes checkTemplateManifest with zero errors', () => {
        const result = checkTemplateManifest(manifest);
        assert.deepEqual(result.errors, []);
        assert.equal(result.ok, true);
      });

      it('is instantiable end-to-end with a synthetic complete mapping', () => {
        const mapping = syntheticMapping(manifest);
        const graph = applyTemplateSlots(manifest, mapping);

        // No placeholder survives substitution — neither as a parseable slot
        // ref nor as any leftover `slot:`-prefixed string anywhere.
        assert.deepEqual(extractSlotRefs(graph), []);
        assert.ok(!JSON.stringify(graph).includes('"slot:'), 'resolved graph still contains a slot: placeholder');

        // The resolved graph passes the live-refs validation the instantiate
        // route will run, with KnownRefs = exactly the synthetic values.
        const result = validate(graph, syntheticKnownRefs(mapping));
        assert.deepEqual(result.errors, []);
        assert.equal(result.ok, true);
      });

      it('every cron trigger carries a valid cron expression', () => {
        for (const trigger of manifest.graph.triggers ?? []) {
          if (trigger.kind !== 'cron') continue;
          assert.equal(typeof trigger.cron, 'string', `cron trigger '${trigger.id}' has no cron expression`);
          assert.ok(isValidCron(trigger.cron!), `cron trigger '${trigger.id}' expression '${trigger.cron}' is invalid`);
        }
      });

      it('every operator-facing text carries a German translation (bundled en/de parity)', () => {
        const requireDe = (value: LocalizedText, what: string): void => {
          assert.ok(typeof value === 'object', `${what} is a plain string — bundled templates must localize`);
          const de = value.de;
          assert.ok(typeof de === 'string' && de.trim().length > 0, `${what} lacks a German translation`);
          assert.ok(typeof value.en === 'string' && value.en.trim().length > 0, `${what} lacks the required en base`);
        };
        requireDe(manifest.name, 'name');
        requireDe(manifest.description, 'description');
        requireDe(manifest.useCase, 'useCase');
        for (const kind of SLOT_KINDS) {
          for (const slot of manifest.slots[kind] ?? []) {
            requireDe(slot.label, `${kind} slot '${slot.key}' label`);
            if (slot.description !== undefined) requireDe(slot.description, `${kind} slot '${slot.key}' description`);
          }
        }
      });
    });
  }

  it('weekly-report actually has a cron trigger (the cron gate is not vacuous)', () => {
    const weekly = manifests.find((m) => m.manifest.id === 'weekly-report')!.manifest;
    assert.ok((weekly.graph.triggers ?? []).some((t) => t.kind === 'cron'));
  });
});

describe('loadTemplateCatalog', () => {
  it('serves the bundled templates sorted by id', () => {
    const catalog = loadTemplateCatalog({ dir: TEMPLATES_DIR });
    assert.deepEqual(
      catalog.list().map((m) => m.id),
      ['expense-approval', 'notify-and-escalate', 'onboarding-checklist', 'weekly-report'],
    );
    assert.equal(resolveLocalizedText(catalog.get('expense-approval')!.name), 'Expense approval with escalation');
    assert.equal(resolveLocalizedText(catalog.get('expense-approval')!.name, 'de'), 'Spesenfreigabe mit Eskalation');
    assert.equal(catalog.get('does-not-exist'), undefined);
  });

  it('resolves the bundled dir relative to its own module by default', () => {
    const catalog = loadTemplateCatalog();
    assert.equal(catalog.list().length, 4);
  });

  it('skips malformed and invalid files with a log line and still serves the rest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-templates-'));
    writeFileSync(join(dir, 'aa-valid.json'), readFileSync(join(TEMPLATES_DIR, 'expense-approval.json')));
    writeFileSync(join(dir, 'broken.json'), '{ this is not json');
    writeFileSync(join(dir, 'invalid.json'), JSON.stringify({ id: 'invalid-template', slots: {} }));

    const logs: string[] = [];
    const catalog = loadTemplateCatalog({ dir, log: (msg) => logs.push(msg) });

    assert.deepEqual(catalog.list().map((m) => m.id), ['expense-approval']);
    assert.ok(logs.some((l) => l.includes('template broken.json invalid')), `no log for broken.json in: ${logs.join('\n')}`);
    assert.ok(logs.some((l) => l.includes('template invalid.json invalid')), `no log for invalid.json in: ${logs.join('\n')}`);
  });

  it('keeps the first file on a duplicate id and logs the collision', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-templates-'));
    const original = JSON.parse(readFileSync(join(TEMPLATES_DIR, 'expense-approval.json'), 'utf8')) as TemplateManifest;
    writeFileSync(join(dir, 'aa-first.json'), JSON.stringify({ ...original, name: 'First occurrence' }));
    writeFileSync(join(dir, 'zz-dup.json'), JSON.stringify({ ...original, name: 'Second occurrence' }));

    const logs: string[] = [];
    const catalog = loadTemplateCatalog({ dir, log: (msg) => logs.push(msg) });

    assert.deepEqual(catalog.list().map((m) => m.name), ['First occurrence']);
    assert.ok(logs.some((l) => l.includes("zz-dup.json duplicates id 'expense-approval'")), `no duplicate log in: ${logs.join('\n')}`);
  });

  it('returns an empty catalog (with a log line) for an unreadable dir', () => {
    const logs: string[] = [];
    const catalog = loadTemplateCatalog({ dir: '/does/not/exist', log: (msg) => logs.push(msg) });
    assert.deepEqual(catalog.list(), []);
    assert.ok(logs.some((l) => l.includes('unreadable')));
  });

  it('list() returns a fresh array (callers cannot mutate the catalog)', () => {
    const catalog = loadTemplateCatalog({ dir: TEMPLATES_DIR });
    catalog.list().pop();
    assert.equal(catalog.list().length, 4);
  });
});
