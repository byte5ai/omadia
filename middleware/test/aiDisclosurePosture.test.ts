/**
 * Issue #648 (epic #642) — the operator's AI-Act marking posture is readable.
 *
 * The operator may grade the marking down per channel or switch it off; omadia
 * is self-hosted and that is their decision. #648 is about the fact that the
 * decision was invisible: a reduced marking showed up nowhere, so a copied
 * config or a leftover from a test setup was never noticed by anyone.
 *
 * Two properties carry the whole feature and both are pinned below:
 *
 *  - **at the delivered state everything stays quiet** — no boot warning, no
 *    health warning, nothing for a dashboard to render. A hint that fires on a
 *    default install is a hint operators learn to ignore;
 *  - **nothing that permits conclusions about content or users leaves the
 *    process.** That is #648's sharpest acceptance criterion, so it is asserted
 *    against the serialised payload rather than trusted to review.
 *
 * Imported from SOURCE, not the built barrels, so a mutation in `src/` cannot
 * report green over stale `dist/`.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  describeAiDisclosurePosture,
  formatDisclosureBootWarning,
  resolveDisclosureLevelForChannel,
} from '../packages/harness-orchestrator/src/aiDisclosurePosture.js';
import { buildDisclosureHealth } from '../src/health/disclosureHealth.js';
import type { AiDisclosureSetup } from '../packages/harness-orchestrator/src/orchestrator.js';

const ASSISTANT_NAME = 'Heinemann-Assistent';
const OPERATOR_NOTE = 'Bei Rückfragen wenden Sie sich an service@example.invalid';

describe('#648 — resolved AI-marking posture', () => {
  it('is quiet at the delivered state: no deviation, no boot warning', () => {
    // `undefined` is the zero-config instance — the operator set no disclosure
    // field at all.
    const posture = describeAiDisclosurePosture(undefined);

    assert.equal(posture.source, 'default');
    assert.equal(posture.deviates, false);
    assert.equal(posture.defaultLevel, 'standard');
    assert.deepEqual(
      posture.channels.map((c) => c.level),
      ['standard', 'standard', 'standard', 'standard', 'standard'],
    );
    assert.equal(formatDisclosureBootWarning(posture), undefined);

    const health = buildDisclosureHealth(posture);
    assert.equal(health.known, true);
    assert.equal(health.deviates, false);
    assert.deepEqual(health.warnings, [], 'a default install must not warn');
  });

  it('reports a per-channel override as a deviation and warns at boot', () => {
    const setup: AiDisclosureSetup = {
      level: 'standard',
      overrides: { telegram: 'concise' },
    };
    const posture = describeAiDisclosurePosture(setup);

    const telegram = posture.channels.find((c) => c.channel === 'telegram');
    assert.equal(telegram?.level, 'concise');
    assert.equal(telegram?.overridden, true);
    assert.equal(telegram?.deviates, true);
    // …and only that one.
    assert.deepEqual(
      posture.channels.filter((c) => c.deviates).map((c) => c.channel),
      ['telegram'],
    );
    assert.equal(posture.deviates, true);
    assert.equal(posture.source, 'operator');

    const warning = formatDisclosureBootWarning(posture);
    assert.ok(warning?.includes('telegram=concise'));

    const health = buildDisclosureHealth(posture);
    assert.equal(health.channels['telegram'], 'concise');
    assert.equal(health.channels['teams'], 'standard');
    assert.equal(health.warnings.length, 1);
  });

  it('treats a global level change as a deviation on every channel', () => {
    // The case a per-channel-only check would miss: no overrides at all, but
    // the operator switched the global default off.
    const posture = describeAiDisclosurePosture({ level: 'off' });

    assert.equal(posture.deviates, true);
    assert.ok(posture.channels.every((c) => c.level === 'off'));
    assert.ok(posture.channels.every((c) => c.overridden === false));
    assert.ok(formatDisclosureBootWarning(posture)?.includes('default=off'));
  });

  it('says so when an override cannot fire yet instead of implying it does', () => {
    // Only teams/slack/telegram ever carry a `channelKind` into a turn. An
    // operator who sets `web=off` and still sees the marking is looking at a
    // correct system and a stale expectation — silence here would read as
    // "your override is in force".
    const posture = describeAiDisclosurePosture({
      level: 'standard',
      overrides: { web: 'off' },
    });

    const web = posture.channels.find((c) => c.channel === 'web');
    assert.equal(web?.overridden, true);
    assert.equal(web?.effective, false);

    const health = buildDisclosureHealth(posture);
    assert.deepEqual(health.inertOverrides, ['web']);
    assert.ok(
      health.warnings.some((w) => w.includes('not yet dispatched')),
      'an inert override must be called out',
    );

    // A dispatched channel must NOT be flagged as inert.
    const dispatched = describeAiDisclosurePosture({
      level: 'standard',
      overrides: { teams: 'off' },
    });
    assert.deepEqual(buildDisclosureHealth(dispatched).inertOverrides, []);
  });

  it('never exposes the assistant name or the operator note', () => {
    // #648: "Keine Angabe im Health-Output, die Rückschlüsse auf Inhalte oder
    // Nutzer erlaubt." The operator note is free-form, so this is asserted
    // against the actual serialised payload rather than the type.
    const setup: AiDisclosureSetup = {
      level: 'concise',
      locale: 'en',
      assistantName: ASSISTANT_NAME,
      operatorNote: OPERATOR_NOTE,
    };
    const posture = describeAiDisclosurePosture(setup);
    const wire = JSON.stringify(buildDisclosureHealth(posture));

    assert.ok(!wire.includes(ASSISTANT_NAME), 'assistant name must not reach /health');
    assert.ok(!wire.includes(OPERATOR_NOTE), 'operator note must not reach /health');
    assert.ok(!wire.includes('service@example.invalid'));

    // The operator-relevant fact — that they are SET — is still reported.
    assert.equal(posture.assistantNameConfigured, true);
    assert.equal(posture.operatorNoteConfigured, true);
    assert.equal(posture.localeConfigured, true);
    // …and the posture object itself carries no values either.
    const postureWire = JSON.stringify(posture);
    assert.ok(!postureWire.includes(ASSISTANT_NAME));
    assert.ok(!postureWire.includes(OPERATOR_NOTE));
  });

  it('does not report an unreadable posture as the delivered state', () => {
    // No orchestrator active. "We could not read it" and "it is at the
    // delivered state" are different facts, and only one of them is
    // reassuring — the same lie the KG snapshot next door exists to prevent.
    const health = buildDisclosureHealth(undefined);

    assert.equal(health.known, false);
    assert.equal(health.source, 'unknown');
    assert.deepEqual(health.channels, {});
    assert.equal(health.warnings.length, 1);
  });

  it('resolves a channel level with override > global > shipped precedence', () => {
    // The single derivation the Orchestrator's per-turn path also calls. A
    // channel with no `channelKind` falls back to the global level — the safe
    // direction, because the marking stays active.
    const setup: AiDisclosureSetup = {
      level: 'concise',
      overrides: { teams: 'off' },
    };

    assert.equal(resolveDisclosureLevelForChannel(setup, 'teams'), 'off');
    assert.equal(resolveDisclosureLevelForChannel(setup, 'slack'), 'concise');
    assert.equal(resolveDisclosureLevelForChannel(setup, undefined), 'concise');
    assert.equal(resolveDisclosureLevelForChannel(undefined, 'teams'), 'standard');
  });
});
