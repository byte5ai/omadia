import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { lintSpecTool } from '../../../src/plugins/builder/tools/lintSpec.js';
import { patchSpecTool } from '../../../src/plugins/builder/tools/patchSpec.js';
import { fillSlotTool } from '../../../src/plugins/builder/tools/fillSlot.js';
import {
  createBuilderToolHarness,
  type BuilderToolHarness,
} from '../fixtures/builderToolHarness.js';

const validBaseline = [
  { op: 'replace' as const, path: '/id', value: 'de.byte5.agent.weather' },
  { op: 'replace' as const, path: '/name', value: 'Weather' },
  { op: 'replace' as const, path: '/description', value: 'forecast agent' },
  { op: 'replace' as const, path: '/category', value: 'analysis' },
  { op: 'replace' as const, path: '/domain', value: 'weather' },
  { op: 'replace' as const, path: '/skill', value: { role: 'a weather expert' } },
  {
    op: 'replace' as const,
    path: '/playbook',
    value: { when_to_use: 'when user asks about weather' },
  },
];

describe('lintSpecTool', () => {
  let harness: BuilderToolHarness;

  beforeEach(async () => {
    harness = await createBuilderToolHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('reports zod errors on an empty draft skeleton', async () => {
    const result = await lintSpecTool.run({}, harness.context());
    assert.equal(result.ok, false);
    assert.ok(result.issues.length > 0);
    assert.ok(result.issues.some((i) => i.code.startsWith('zod.')));
  });

  it('passes lint on a fully-valid spec', async () => {
    await patchSpecTool.run({ patches: validBaseline }, harness.context());
    const result = await lintSpecTool.run({}, harness.context());
    assert.equal(result.ok, true);
    assert.deepEqual(result.issues, []);
  });

  it('flags reserved tool ID collision', async () => {
    await patchSpecTool.run(
      {
        patches: [
          ...validBaseline,
          {
            op: 'add',
            path: '/tools/-',
            value: {
              id: 'query_memory',
              description: 'shadows the platform tool',
              input: { type: 'object' },
            },
          },
        ],
      },
      harness.context(),
    );
    const result = await lintSpecTool.run({}, harness.context());
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.code === 'reserved_tool_id'));
  });

  it('flags duplicate tool IDs', async () => {
    // Bypass patch_spec — the B.8-2 manifestLinter would block this state.
    // lintSpec is the older audit tool; we want to verify it still flags
    // these issues independently when invoked on a pre-existing spec.
    const draft = await harness.draftStore.load(harness.userEmail, harness.draftId);
    await harness.draftStore.update(harness.userEmail, harness.draftId, {
      spec: {
        ...draft!.spec,
        id: 'de.byte5.agent.weather',
        name: 'Weather',
        description: 'forecast agent',
        category: 'analysis',
        skill: { role: 'a weather expert' },
        playbook: { when_to_use: 'when user asks about weather' },
        tools: [
          { id: 'foo', description: 'a', input: { type: 'object' } },
          { id: 'foo', description: 'b', input: { type: 'object' } },
        ],
      } as never,
    });
    const result = await lintSpecTool.run({}, harness.context());
    assert.ok(result.issues.some((i) => i.code === 'duplicate_tool_id'));
  });

  it('flags self-dependency', async () => {
    // Bypass patch_spec — see comment above.
    const draft = await harness.draftStore.load(harness.userEmail, harness.draftId);
    await harness.draftStore.update(harness.userEmail, harness.draftId, {
      spec: {
        ...draft!.spec,
        id: 'de.byte5.agent.weather',
        name: 'Weather',
        description: 'forecast agent',
        category: 'analysis',
        skill: { role: 'a weather expert' },
        playbook: { when_to_use: 'when user asks about weather' },
        depends_on: ['de.byte5.agent.weather'],
      } as never,
    });
    const result = await lintSpecTool.run({}, harness.context());
    assert.ok(result.issues.some((i) => i.code === 'self_dependency'));
  });

  it('Zod-rejects depends_on entries that contain "@" version pins', async () => {
    // The current AgentIdSchema does not allow `@` in agent IDs, so a
    // `<id>@<range>` syntax is caught at parse time. When the schema gains
    // version-pin support this test should flip to a peer-semver-style check.
    await patchSpecTool.run(
      {
        patches: [
          ...validBaseline,
          {
            op: 'add',
            path: '/depends_on/-',
            value: 'de.byte5.integration.odoo@latest',
          },
        ],
      },
      harness.context(),
    );
    const result = await lintSpecTool.run({}, harness.context());
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.code.startsWith('zod.')));
  });

  it('warns on catalog name collision', async () => {
    const h = await createBuilderToolHarness({
      catalogToolNames: ['Weather'],
    });
    try {
      await patchSpecTool.run({ patches: validBaseline }, h.context());
      const result = await lintSpecTool.run({}, h.context());
      const collisions = result.issues.filter((i) => i.code === 'name_collision');
      assert.equal(collisions.length, 1);
      assert.equal(collisions[0].severity, 'warning');
    } finally {
      await h.dispose();
    }
  });

  it('warns on inline systemPrompt literal in slot source', async () => {
    await patchSpecTool.run({ patches: validBaseline }, harness.context());
    await fillSlotTool.run(
      { slotKey: 'activate-body', source: 'const x = { systemPrompt: "you are..." };' },
      harness.context(),
    );
    const result = await lintSpecTool.run({}, harness.context());
    assert.ok(result.issues.some((i) => i.code === 'inline_system_prompt'));
  });

  it('flags empty slot source', async () => {
    await patchSpecTool.run({ patches: validBaseline }, harness.context());
    // fillSlot won't accept empty, so go through DraftStore directly to seed
    // an invalid state and make sure lint catches it.
    await harness.draftStore.update(harness.userEmail, harness.draftId, {
      slots: { 'activate-body': '   ' },
    });
    const result = await lintSpecTool.run({}, harness.context());
    assert.ok(result.issues.some((i) => i.code === 'empty_slot'));
  });
});
