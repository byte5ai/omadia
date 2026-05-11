import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { parseAgentSpec, type AgentSpec } from '../../src/plugins/builder/agentSpec.js';
import {
  applySpecPatches,
  IllegalSpecState,
  JsonPatchSchema,
  type JsonPatch,
} from '../../src/plugins/builder/specPatcher.js';

const validBase = {
  id: 'de.byte5.agent.weather',
  name: 'Weather Agent',
  description: 'Weather forecast agent',
  category: 'analysis',
  skill: { role: 'a weather expert' },
  playbook: { when_to_use: 'when user asks about weather' },
} as const;

function baseSpec(): AgentSpec {
  return parseAgentSpec(validBase);
}

describe('specPatcher', () => {
  describe('JsonPatchSchema', () => {
    it('accepts add/replace/remove operations', () => {
      assert.doesNotThrow(() => JsonPatchSchema.parse({ op: 'add', path: '/x', value: 1 }));
      assert.doesNotThrow(() => JsonPatchSchema.parse({ op: 'replace', path: '/x', value: 2 }));
      assert.doesNotThrow(() => JsonPatchSchema.parse({ op: 'remove', path: '/x' }));
    });

    it('rejects move/copy/test (subset constraint)', () => {
      assert.throws(() => JsonPatchSchema.parse({ op: 'move', path: '/x', from: '/y' }));
      assert.throws(() => JsonPatchSchema.parse({ op: 'copy', path: '/x', from: '/y' }));
      assert.throws(() => JsonPatchSchema.parse({ op: 'test', path: '/x', value: 1 }));
    });

    it('rejects remove with a value field (strict)', () => {
      assert.throws(() =>
        JsonPatchSchema.parse({ op: 'remove', path: '/x', value: 1 }),
      );
    });
  });

  describe('applySpecPatches — basics', () => {
    it('does not mutate the input spec', () => {
      const original = baseSpec();
      const beforeJson = JSON.stringify(original);
      applySpecPatches(original, [
        { op: 'replace', path: '/description', value: 'Modified description' },
      ]);
      assert.equal(JSON.stringify(original), beforeJson);
    });

    it('returns a frozen-clone-style new spec on replace', () => {
      const result = applySpecPatches(baseSpec(), [
        { op: 'replace', path: '/description', value: 'New description' },
      ]);
      assert.equal(result.spec.description, 'New description');
      assert.deepEqual(result.applied, [
        { op: 'replace', path: '/description', value: 'New description' },
      ]);
    });

    it('applies multiple patches in order', () => {
      const result = applySpecPatches(baseSpec(), [
        { op: 'replace', path: '/name', value: 'A' },
        { op: 'replace', path: '/name', value: 'B' },
        { op: 'replace', path: '/name', value: 'C' },
      ]);
      assert.equal(result.spec.name, 'C');
    });
  });

  describe('applySpecPatches — add', () => {
    it('appends to array via numeric index', () => {
      const result = applySpecPatches(baseSpec(), [
        {
          op: 'add',
          path: '/tools/0',
          value: { id: 'foo', description: 'foo tool', input: { type: 'object' } },
        },
      ]);
      assert.equal(result.spec.tools.length, 1);
      assert.equal(result.spec.tools[0].id, 'foo');
    });

    it("appends to array via '-' index (RFC-6901)", () => {
      const result = applySpecPatches(baseSpec(), [
        {
          op: 'add',
          path: '/tools/-',
          value: { id: 'first', description: 'first tool', input: { type: 'object' } },
        },
        {
          op: 'add',
          path: '/tools/-',
          value: { id: 'second', description: 'second tool', input: { type: 'object' } },
        },
      ]);
      assert.equal(result.spec.tools.length, 2);
      assert.equal(result.spec.tools[0].id, 'first');
      assert.equal(result.spec.tools[1].id, 'second');
    });

    it('adds an object property to slots', () => {
      const result = applySpecPatches(baseSpec(), [
        { op: 'add', path: '/slots/activate-body', value: 'console.log("hi");' },
      ]);
      assert.equal(result.spec.slots['activate-body'], 'console.log("hi");');
    });

    it('decodes RFC-6901 escape sequences (~1 → /, ~0 → ~)', () => {
      const result = applySpecPatches(baseSpec(), [
        { op: 'add', path: '/slots/with~1slash', value: 'x' },
        { op: 'add', path: '/slots/with~0tilde', value: 'y' },
      ]);
      assert.equal(result.spec.slots['with/slash'], 'x');
      assert.equal(result.spec.slots['with~tilde'], 'y');
    });
  });

  describe('applySpecPatches — replace', () => {
    it('replaces a scalar field', () => {
      const result = applySpecPatches(baseSpec(), [
        { op: 'replace', path: '/category', value: 'productivity' },
      ]);
      assert.equal(result.spec.category, 'productivity');
    });

    it('replaces an array element by index', () => {
      const seeded = applySpecPatches(baseSpec(), [
        { op: 'add', path: '/depends_on/0', value: 'de.byte5.integration.odoo' },
      ]);
      const result = applySpecPatches(seeded.spec, [
        { op: 'replace', path: '/depends_on/0', value: 'de.byte5.integration.confluence' },
      ]);
      assert.deepEqual(result.spec.depends_on, ['de.byte5.integration.confluence']);
    });

    it('throws when replacing an out-of-bounds array index', () => {
      assert.throws(
        () =>
          applySpecPatches(baseSpec(), [
            { op: 'replace', path: '/tools/0', value: null },
          ]),
        IllegalSpecState,
      );
    });
  });

  describe('applySpecPatches — remove', () => {
    it('removes an array element', () => {
      const seeded = applySpecPatches(baseSpec(), [
        { op: 'add', path: '/depends_on/-', value: 'de.byte5.integration.odoo' },
        { op: 'add', path: '/depends_on/-', value: 'de.byte5.integration.confluence' },
      ]);
      const result = applySpecPatches(seeded.spec, [
        { op: 'remove', path: '/depends_on/0' },
      ]);
      assert.deepEqual(result.spec.depends_on, ['de.byte5.integration.confluence']);
    });

    it('removes an object property', () => {
      const seeded = applySpecPatches(baseSpec(), [
        { op: 'add', path: '/slots/x', value: 'code' },
      ]);
      const result = applySpecPatches(seeded.spec, [
        { op: 'remove', path: '/slots/x' },
      ]);
      assert.equal(result.spec.slots['x'], undefined);
    });

    it('throws when removing a non-existent key', () => {
      assert.throws(
        () =>
          applySpecPatches(baseSpec(), [{ op: 'remove', path: '/slots/missing' }]),
        IllegalSpecState,
      );
    });

    it('rejects removing the root document', () => {
      assert.throws(
        () => applySpecPatches(baseSpec(), [{ op: 'remove', path: '' }]),
        IllegalSpecState,
      );
    });
  });

  describe('applySpecPatches — validation', () => {
    it('rejects a patch that produces an invalid spec (Zod fail)', () => {
      assert.throws(
        () =>
          applySpecPatches(baseSpec(), [
            { op: 'replace', path: '/category', value: 'not-a-real-category' },
          ]),
        IllegalSpecState,
      );
    });

    it('rejects a patch that produces an invalid id format', () => {
      assert.throws(
        () =>
          applySpecPatches(baseSpec(), [
            { op: 'replace', path: '/id', value: 'INVALID_ID' },
          ]),
        IllegalSpecState,
      );
    });

    it('atomic: rejects whole batch when patch #2 fails', () => {
      const original = baseSpec();
      assert.throws(
        () =>
          applySpecPatches(original, [
            { op: 'replace', path: '/description', value: 'good' },
            { op: 'replace', path: '/category', value: 'invalid' },
          ]),
        IllegalSpecState,
      );
      // Original is still untouched (already covered by first test, but verify
      // that applied=[] semantics hold).
      assert.equal(original.description, 'Weather forecast agent');
    });

    it('rejects malformed JSON-pointer paths', () => {
      assert.throws(
        () =>
          applySpecPatches(baseSpec(), [
            { op: 'replace', path: 'no-leading-slash', value: 'x' },
          ]),
        IllegalSpecState,
      );
    });

    it('IllegalSpecState carries the patch index in the message', () => {
      try {
        applySpecPatches(baseSpec(), [
          { op: 'replace', path: '/description', value: 'fine' },
          { op: 'replace', path: '/tools/99', value: null },
        ]);
        assert.fail('expected throw');
      } catch (err) {
        assert.ok(err instanceof IllegalSpecState);
        assert.match(err.message, /Patch #1/);
      }
    });
  });

  describe('applySpecPatches — empty input', () => {
    it('returns an unchanged spec when patches array is empty', () => {
      const original = baseSpec();
      const result = applySpecPatches(original, []);
      assert.deepEqual(result.spec, original);
      assert.deepEqual(result.applied, []);
    });
  });

  describe('applySpecPatches — mixed batch', () => {
    it('handles a realistic multi-step batch (id + description + tool + slot)', () => {
      const patches: JsonPatch[] = [
        { op: 'replace', path: '/name', value: 'New Weather' },
        { op: 'replace', path: '/description', value: 'Better description' },
        {
          op: 'add',
          path: '/tools/-',
          value: {
            id: 'fetch_forecast',
            description: 'Fetch a forecast',
            input: { type: 'object' },
          },
        },
        { op: 'add', path: '/slots/activate-body', value: 'init();' },
      ];
      const result = applySpecPatches(baseSpec(), patches);
      assert.equal(result.spec.name, 'New Weather');
      assert.equal(result.spec.description, 'Better description');
      assert.equal(result.spec.tools.length, 1);
      assert.equal(result.spec.slots['activate-body'], 'init();');
    });
  });
});
