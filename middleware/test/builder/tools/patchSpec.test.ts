import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { patchSpecTool } from '../../../src/plugins/builder/tools/patchSpec.js';
import {
  createBuilderToolHarness,
  type BuilderToolHarness,
} from '../fixtures/builderToolHarness.js';

describe('patchSpecTool', () => {
  let harness: BuilderToolHarness;

  beforeEach(async () => {
    harness = await createBuilderToolHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('applies patches to the empty draft skeleton', async () => {
    const result = await patchSpecTool.run(
      {
        patches: [
          { op: 'replace', path: '/id', value: 'de.byte5.agent.weather' },
          { op: 'replace', path: '/name', value: 'Weather' },
        ],
      },
      harness.context(),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.applied.length, 2);

    const reloaded = await harness.draftStore.load(harness.userEmail, harness.draftId);
    assert.ok(reloaded);
    assert.equal(reloaded.spec.id, 'de.byte5.agent.weather');
    assert.equal(reloaded.spec.name, 'Weather');
  });

  it('emits a spec_patch event with cause=agent', async () => {
    await patchSpecTool.run(
      {
        patches: [{ op: 'replace', path: '/name', value: 'Foo' }],
      },
      harness.context(),
    );
    assert.equal(harness.events.length, 1);
    const event = harness.events[0];
    assert.equal(event.type, 'spec_patch');
    if (event.type === 'spec_patch') {
      assert.equal(event.cause, 'agent');
      assert.equal(event.patches.length, 1);
    }
  });

  it('triggers rebuildScheduler.schedule exactly once per call', async () => {
    await patchSpecTool.run(
      {
        patches: [{ op: 'replace', path: '/name', value: 'Foo' }],
      },
      harness.context(),
    );
    assert.equal(harness.rebuilds.length, 1);
    assert.equal(harness.rebuilds[0].userEmail, harness.userEmail);
    assert.equal(harness.rebuilds[0].draftId, harness.draftId);
  });

  it('returns ok=false when a patch is illegal — no persistence, no events', async () => {
    const result = await patchSpecTool.run(
      {
        patches: [{ op: 'remove', path: '/slots/missing' }],
      },
      harness.context(),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Patch #0/);

    assert.equal(harness.events.length, 0);
    assert.equal(harness.rebuilds.length, 0);
  });

  it('returns ok=false when the draft does not exist', async () => {
    const ctx = { ...harness.context(), draftId: 'nonexistent-draft-id' };
    const result = await patchSpecTool.run(
      {
        patches: [{ op: 'replace', path: '/name', value: 'Foo' }],
      },
      ctx,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /not found/);
  });

  it('handles array append via "/-" pointer', async () => {
    const result = await patchSpecTool.run(
      {
        patches: [
          {
            op: 'add',
            path: '/depends_on/-',
            value: 'de.byte5.integration.odoo',
          },
        ],
      },
      harness.context(),
    );
    assert.equal(result.ok, true);
    const reloaded = await harness.draftStore.load(harness.userEmail, harness.draftId);
    assert.deepEqual(reloaded?.spec.depends_on, ['de.byte5.integration.odoo']);
  });

  describe('B.6-10 strict-mode regression check', () => {
    /**
     * Historical bug: agent inserted an Object into `network.outbound`
     * (Zod-declared as `string[]`). Pre-B.6-10 the patch applied happily
     * + the bug surfaced two turns later in codegen. With strict-mode
     * the patch is rejected as soon as the spec was already valid before.
     */
    async function seedValidSpec(): Promise<void> {
      await harness.draftStore.update(harness.userEmail, harness.draftId, {
        spec: {
          template: 'agent-integration',
          id: 'de.byte5.agent.weather',
          name: 'Weather',
          version: '0.1.0',
          description: 'fixture',
          category: 'analysis',
          domain: 'weather',
          depends_on: [],
          tools: [],
          skill: { role: 'tester' },
          setup_fields: [],
          playbook: { when_to_use: 'tests', not_for: [], example_prompts: [] },
          network: { outbound: [] },
          slots: {},
        } as never,
      });
    }

    it('rejects a patch that breaks an already-valid spec; original untouched', async () => {
      await seedValidSpec();
      const before = await harness.draftStore.load(
        harness.userEmail,
        harness.draftId,
      );
      assert.ok(before);

      const result = await patchSpecTool.run(
        {
          patches: [
            {
              op: 'replace',
              path: '/network/outbound',
              value: { host: 'api.example.com' }, // Object instead of string[]
            },
          ],
        },
        harness.context(),
      );

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.error, /strict-mode rejected/);
      assert.match(result.error, /network\/outbound/);

      // Spec on disk unchanged + no events fired + no rebuild scheduled.
      const after = await harness.draftStore.load(
        harness.userEmail,
        harness.draftId,
      );
      assert.ok(after);
      assert.deepEqual(after.spec.network.outbound, before.spec.network.outbound);
      assert.equal(harness.events.length, 0);
      assert.equal(harness.rebuilds.length, 0);
    });

    it('still allows patches on a mid-construction (pre-invalid) spec', async () => {
      // Default harness draft has the empty skeleton — Zod-invalid because
      // id/name/description etc. are blank. The agent must be able to fill
      // those in one at a time.
      const result = await patchSpecTool.run(
        {
          patches: [{ op: 'replace', path: '/name', value: 'Foo' }],
        },
        harness.context(),
      );
      assert.equal(result.ok, true);
    });

    it('strict-mode does not block a patch that keeps the spec valid', async () => {
      await seedValidSpec();
      const result = await patchSpecTool.run(
        {
          patches: [
            {
              op: 'add',
              path: '/network/outbound/-',
              value: 'api.openweather.org',
            },
          ],
        },
        harness.context(),
      );
      assert.equal(result.ok, true);
      const reloaded = await harness.draftStore.load(
        harness.userEmail,
        harness.draftId,
      );
      assert.deepEqual(reloaded?.spec.network.outbound, ['api.openweather.org']);
    });
  });

  describe('B.7-3 content-guard (silent capability loss)', () => {
    async function seedTwoTools(): Promise<void> {
      await harness.draftStore.update(harness.userEmail, harness.draftId, {
        spec: {
          template: 'agent-integration',
          id: 'de.byte5.agent.weather',
          name: 'Weather',
          version: '0.1.0',
          description: 'fixture',
          category: 'analysis',
          depends_on: ['de.byte5.integration.openweather'],
          tools: [
            { id: 'get_forecast', description: 'a' },
            { id: 'get_history', description: 'b' },
          ],
          skill: { role: 'tester' },
          setup_fields: [],
          playbook: { when_to_use: 'tests', not_for: [], example_prompts: [] },
          network: { outbound: ['api.openweather.org'] },
          slots: {},
        } as never,
      });
    }

    it('rejects a patch that silently removes a tool — spec/events/rebuild untouched', async () => {
      await seedTwoTools();
      const before = await harness.draftStore.load(harness.userEmail, harness.draftId);
      const result = await patchSpecTool.run(
        {
          patches: [{ op: 'remove', path: '/tools/1' }],
        },
        harness.context(),
      );
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.error, /content-guard/);
      assert.match(result.error, /get_history/);
      assert.equal(result.contentGuardViolations?.length, 1);
      assert.equal(result.contentGuardViolations?.[0]?.field, 'tools');

      const after = await harness.draftStore.load(harness.userEmail, harness.draftId);
      assert.deepEqual(after?.spec.tools, before?.spec.tools);
      assert.equal(harness.events.length, 0);
      assert.equal(harness.rebuilds.length, 0);
    });

    it('allows the same patch when the user message acknowledges the removal', async () => {
      await seedTwoTools();
      harness.userMessage = 'lass uns get_history rausnehmen, brauchen wir nicht';

      const result = await patchSpecTool.run(
        {
          patches: [{ op: 'remove', path: '/tools/1' }],
        },
        harness.context(),
      );
      assert.equal(result.ok, true);

      const reloaded = await harness.draftStore.load(harness.userEmail, harness.draftId);
      assert.equal(reloaded?.spec.tools.length, 1);
    });

    it('blocks silent depends_on removal even when other tools are user-acknowledged', async () => {
      await seedTwoTools();
      harness.userMessage = 'remove get_history';

      const result = await patchSpecTool.run(
        {
          patches: [
            { op: 'remove', path: '/tools/1' }, // acknowledged
            { op: 'replace', path: '/depends_on', value: [] }, // silent
          ],
        },
        harness.context(),
      );
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.contentGuardViolations?.length, 1);
      assert.equal(result.contentGuardViolations?.[0]?.field, 'depends_on');
    });

    it('blocks silent network.outbound removal', async () => {
      await seedTwoTools();
      const result = await patchSpecTool.run(
        {
          patches: [{ op: 'replace', path: '/network/outbound', value: [] }],
        },
        harness.context(),
      );
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.contentGuardViolations?.[0]?.field, 'network.outbound');
    });

    it('passes a rename-style patch (replace tool with new id) only when user names both old and new', async () => {
      await seedTwoTools();
      harness.userMessage = 'rename get_history to get_archive';
      const result = await patchSpecTool.run(
        {
          patches: [
            {
              op: 'replace',
              path: '/tools/1',
              value: { id: 'get_archive', description: 'b' },
            },
          ],
        },
        harness.context(),
      );
      assert.equal(result.ok, true);
    });
  });

  describe('B.8-2 manifest-linter integration', () => {
    async function seedValidWithCatalog(): Promise<void> {
      await harness.draftStore.update(harness.userEmail, harness.draftId, {
        spec: {
          template: 'agent-integration',
          id: 'de.byte5.agent.weather',
          name: 'Weather',
          version: '0.1.0',
          description: 'fixture',
          category: 'analysis',
          depends_on: ['de.byte5.integration.openweather'],
          tools: [{ id: 'get_forecast', description: 'a' }],
          skill: { role: 'tester' },
          setup_fields: [],
          playbook: { when_to_use: 'tests', not_for: [], example_prompts: [] },
          network: { outbound: ['api.openweather.org'] },
          slots: {},
        } as never,
      });
      harness.knownPluginIds = [
        'de.byte5.integration.openweather',
        'de.byte5.integration.confluence',
      ];
    }

    it('rejects a patch that introduces an unresolvable depends_on entry', async () => {
      await seedValidWithCatalog();
      const result = await patchSpecTool.run(
        {
          patches: [
            { op: 'add', path: '/depends_on/-', value: 'de.byte5.integration.unknown' },
          ],
        },
        harness.context(),
      );
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.error, /manifest-linter/);
      assert.equal(result.manifestViolations?.length, 1);
      assert.equal(result.manifestViolations?.[0]?.kind, 'depends_on_unresolvable');
    });

    it('rejects a patch that introduces a duplicate tool id', async () => {
      await seedValidWithCatalog();
      const result = await patchSpecTool.run(
        {
          patches: [
            { op: 'add', path: '/tools/-', value: { id: 'get_forecast', description: 'dup' } },
          ],
        },
        harness.context(),
      );
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.manifestViolations?.[0]?.kind, 'tool_id_duplicate');
    });

    it('rejects a patch with non-snake-case tool id', async () => {
      await seedValidWithCatalog();
      const result = await patchSpecTool.run(
        {
          patches: [
            { op: 'add', path: '/tools/-', value: { id: 'getForecast', description: 'a' } },
          ],
        },
        harness.context(),
      );
      assert.equal(result.ok, false);
      if (result.ok) return;
      // Zod schema validation (agentSpec.ts:37 ToolId regex) rejects
      // camelCase BEFORE manifest-linter runs, so the violation surfaces
      // as a generic spec-parse error rather than `tool_id_invalid_syntax`.
      // Either rejection path is correct behaviour; the assertion accepts
      // both so the test stays robust if validation order ever flips.
      const fromLinter = result.manifestViolations?.[0]?.kind === 'tool_id_invalid_syntax';
      const fromSchema = /snake_case|invalid|Tool ID/i.test(result.error ?? '');
      assert.ok(fromLinter || fromSchema, `expected snake_case rejection; got: ${result.error}`);
    });

    it('rejects a patch that adds a URL to network.outbound', async () => {
      await seedValidWithCatalog();
      // userMessage acknowledges the existing host removal so content-
      // guard doesn't fire — manifest-linter must reject the URL replacement.
      harness.userMessage = 'replace api.openweather.org with the https variant';
      const result = await patchSpecTool.run(
        {
          patches: [
            { op: 'replace', path: '/network/outbound', value: ['https://api.example.com'] },
          ],
        },
        harness.context(),
      );
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.manifestViolations?.[0]?.kind, 'network_outbound_invalid');
    });

    it('rejects a patch that moves spec.id into reserved namespace', async () => {
      await seedValidWithCatalog();
      const result = await patchSpecTool.run(
        {
          patches: [{ op: 'replace', path: '/id', value: 'de.byte5.platform.foo' }],
        },
        harness.context(),
      );
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.manifestViolations?.[0]?.kind, 'reserved_id');
    });

    it('does NOT persist when manifest-linter rejects (atomic reject)', async () => {
      await seedValidWithCatalog();
      const before = await harness.draftStore.load(harness.userEmail, harness.draftId);

      await patchSpecTool.run(
        {
          patches: [{ op: 'add', path: '/depends_on/-', value: 'unknown.x' }],
        },
        harness.context(),
      );

      const after = await harness.draftStore.load(harness.userEmail, harness.draftId);
      assert.deepEqual(after?.spec.depends_on, before?.spec.depends_on);
      assert.equal(harness.events.length, 0);
      assert.equal(harness.rebuilds.length, 0);
    });

    it('skips depends_on resolvability when knownPluginIds is empty (mid-construction)', async () => {
      // Operator is mid-iteration without an installed catalog; depends_on
      // check is permissive so the agent can wire the spec one step at a time.
      const result = await patchSpecTool.run(
        {
          patches: [
            { op: 'replace', path: '/id', value: 'de.byte5.agent.foo' },
            { op: 'add', path: '/depends_on/-', value: 'de.byte5.integration.future' },
          ],
        },
        harness.context(),
      );
      assert.equal(result.ok, true);
    });
  });
});
