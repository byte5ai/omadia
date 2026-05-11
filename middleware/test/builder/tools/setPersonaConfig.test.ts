import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { setPersonaConfigTool } from '../../../src/plugins/builder/tools/setPersonaConfig.js';
import {
  createBuilderToolHarness,
  type BuilderToolHarness,
} from '../fixtures/builderToolHarness.js';

/**
 * Phase 3 / OB-67 Slice 2 — `set_persona_config` Builder-Tool tests.
 *
 * Mirrors the `set_quality_config` ergonomics: structured input replaces
 * `spec.persona` in full, emits a single spec_patch event, schedules a
 * preview rebuild, and survives unknown axis names by silently dropping
 * them at the tool surface (the canonical Zod schema is `.strict()` and
 * would reject the whole call otherwise).
 */
describe('setPersonaConfigTool', () => {
  let harness: BuilderToolHarness;

  beforeEach(async () => {
    harness = await createBuilderToolHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('writes spec.persona on the active draft + emits spec_patch + schedules rebuild', async () => {
    const result = await setPersonaConfigTool.run(
      {
        template: 'software-engineer',
        axes: { directness: 80, warmth: 30, formality: 40 },
        custom_notes: 'Antworte auf Deutsch',
      },
      harness.context(),
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.applied, [
      {
        op: 'add',
        path: '/persona',
        value: {
          template: 'software-engineer',
          axes: { directness: 80, warmth: 30, formality: 40 },
          custom_notes: 'Antworte auf Deutsch',
        },
      },
    ]);

    const reloaded = await harness.draftStore.load(
      harness.userEmail,
      harness.draftId,
    );
    assert.ok(reloaded);
    assert.deepEqual(reloaded.spec.persona, {
      template: 'software-engineer',
      axes: { directness: 80, warmth: 30, formality: 40 },
      custom_notes: 'Antworte auf Deutsch',
    });

    assert.equal(harness.events.length, 1);
    assert.equal(harness.events[0]!.type, 'spec_patch');
    assert.equal(harness.rebuilds.length, 1);
  });

  it('drops unknown axis names silently', async () => {
    const result = await setPersonaConfigTool.run(
      {
        axes: {
          directness: 60,
          // not a real axis — must be dropped, not crash
          spiciness: 99,
          warmth: 40,
        },
      },
      harness.context(),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.persona.axes, { directness: 60, warmth: 40 });
    const reloaded = await harness.draftStore.load(
      harness.userEmail,
      harness.draftId,
    );
    assert.deepEqual(reloaded?.spec.persona?.axes, {
      directness: 60,
      warmth: 40,
    });
  });

  it('omits axes block entirely when no valid axis remains after filtering', async () => {
    const result = await setPersonaConfigTool.run(
      { axes: { spiciness: 99, ferocity: 80 } },
      harness.context(),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.persona.axes, undefined);
    const reloaded = await harness.draftStore.load(
      harness.userEmail,
      harness.draftId,
    );
    assert.equal(reloaded?.spec.persona?.axes, undefined);
  });

  it('passes empty input through (clears persona)', async () => {
    // First seed with content
    await setPersonaConfigTool.run(
      { axes: { directness: 80 } },
      harness.context(),
    );
    // Then clear with empty input
    const result = await setPersonaConfigTool.run({}, harness.context());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.persona, {});
    const reloaded = await harness.draftStore.load(
      harness.userEmail,
      harness.draftId,
    );
    assert.deepEqual(reloaded?.spec.persona, {});
  });

  it('returns ok=false when draft does not exist', async () => {
    const ctx = harness.context();
    const result = await setPersonaConfigTool.run(
      { axes: { directness: 50 } },
      { ...ctx, draftId: '00000000-0000-4000-8000-000000000000' },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /not found/);
  });
});
