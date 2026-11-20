/**
 * #2060 — working modes of a facilitator (spec 2043 §2.3, review change of
 * 2026-11-18): modes that add moderation methods are allowed, identity
 * replacement is refused.
 *
 *   1. THE ARCHETYPE ALLOWS MODES: the kernel's facilitator descriptor no
 *      longer omits `persona_skill`; every other omission stays.
 *   2. THE IDENTITY CHECK: moderation methods pass, a new name, a persona or
 *      speaking as someone else is found (English and German).
 *   3. THE BUILD KEEPS ONLY MODES THAT KEEP THE IDENTITY, for any archetype
 *      but `standard` (a skill edited after it was attached).
 *   4. SELECTING A MODERATION MODE: the per-turn router picks it for a
 *      facilitator and it is composed beneath the identity, whose neutrality
 *      contract stays intact and above it.
 *   5. THE ROUTE CHECK (service level): neutrality contract and tools.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { workingModesKeepingIdentity } from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import {
  ARCHETYPE_OMISSIONS,
  archetypeOmits,
} from '../packages/harness-orchestrator/src/registry/archetype.js';
import { FACILITATOR_NEUTRALITY_BLOCK } from '../packages/harness-orchestrator/src/registry/facilitatorNeutrality.js';
import { findWorkingModeIdentityReplacement } from '../packages/harness-orchestrator/src/workingModeIdentity.js';
import { routeTurnWorkingMode, withWorkingMode } from '../packages/harness-orchestrator/src/workingModes.js';
import { composeAgentIdentityPrompt } from '../src/services/agentIdentityPrompt.js';
import { workingModeIssues } from '../src/services/workingModeContract.js';

const mode = (body: string, extra: { description?: string | null; frontmatter?: Record<string, unknown> } = {}) => ({
  name: 'Mode',
  description: extra.description ?? null,
  body,
  frontmatter: extra.frontmatter ?? {},
});

const MODERATION_METHODS = [
  'Run a start-stop-continue retrospective: collect, cluster, then let the group decide on actions.',
  'You are the facilitator of this retrospective. Keep every timebox.',
  'Run a consent round: read the proposal, ask for objections, answer as a short list.',
  'Respond as a table with one row per option. Use role-play exercises for the participants if the group wants them.',
  'Führe eine Konsent-Runde: Vorschlag vorlesen, Einwände sammeln, dann die Gruppe entscheiden lassen.',
  'Du bist jetzt im Schritt "Sammeln": bitte jede Person um einen Beitrag.',
  'Act as a neutral timekeeper and name the remaining minutes.',
];

const IDENTITY_REPLACEMENTS: readonly [string, string][] = [
  ['Your name is Max.', 'gives the agent another name'],
  ['You are Max, the voice of sales.', 'gives the agent another name'],
  ['From now on you are the CEO.', 'replaces'],
  ['Answer on behalf of the sales team.', 'speak as somebody else'],
  ['Respond as the initiator would.', 'speak as somebody else'],
  ['Answer as Max whenever someone asks.', 'speak as somebody else'],
  ['Pretend to be a participant.', 'speak as somebody else'],
  ['Sign your messages as Max.', 'gives the agent another name'],
  ['Dein Name ist Max.', 'gives the agent another name'],
  ['Du bist ab jetzt der Vertriebsleiter.', 'replaces'],
  ['Antworte im Namen von Anna.', 'speak as somebody else'],
  ['Schlüpfe in die Rolle der Geschäftsführung.', 'speak as somebody else'],
];

describe('facilitator working modes (#2060)', () => {
  it('the facilitator archetype allows working modes and keeps every other omission', () => {
    const facilitator = { archetype: 'facilitator' };
    assert.equal(archetypeOmits(facilitator, 'persona_skill'), false);
    for (const omission of ARCHETYPE_OMISSIONS.filter((o) => o !== 'persona_skill')) {
      assert.equal(archetypeOmits(facilitator, omission), true, omission);
    }
  });

  it('moderation methods pass the identity check', () => {
    for (const body of MODERATION_METHODS) {
      assert.deepEqual(findWorkingModeIdentityReplacement(mode(body)), [], body);
    }
  });

  it('identity replacement is found, with the passage', () => {
    for (const [body, reason] of IDENTITY_REPLACEMENTS) {
      const findings = findWorkingModeIdentityReplacement(mode(body));
      assert.equal(findings.length, 1, `${body}: ${JSON.stringify(findings)}`);
      assert.equal(findings[0]!.rule, 'identity_replacement');
      assert.equal(findings[0]!.path, 'working_mode.body');
      assert.match(findings[0]!.message, new RegExp(reason), body);
      assert.ok(findings[0]!.excerpt, body);
    }
  });

  it('identity fields in the frontmatter and the description are found', () => {
    const findings = findWorkingModeIdentityReplacement(
      mode('Run a dot vote.', { description: 'Your name is Max.', frontmatter: { persona: 'Max', speaker: 'x' } }),
    );
    assert.deepEqual(
      findings.map((f) => f.path),
      ['working_mode.frontmatter.persona', 'working_mode.frontmatter.speaker', 'working_mode.description'],
    );
  });

  it('the build leaves identity-replacing modes out for a facilitator, not for a standard agent', () => {
    const retro = { skillId: 'a', slug: 'retro', name: 'Retro', description: 'Retrospective', body: MODERATION_METHODS[0]! };
    const persona = { skillId: 'b', slug: 'max', name: 'Max', description: 'Sales voice', body: 'Your name is Max.' };
    assert.deepEqual(
      workingModesKeepingIdentity([retro, persona], 'facilitator', 'id-mara').map((m) => m.slug),
      ['retro'],
    );
    assert.deepEqual(
      workingModesKeepingIdentity([retro, persona], 'standard', 'id-hr').map((m) => m.slug),
      ['retro', 'max'],
    );
    assert.deepEqual(
      workingModesKeepingIdentity([retro, persona], undefined, 'id-legacy').map((m) => m.slug),
      ['retro', 'max'],
    );
  });

  it('a moderation mode is selected for a facilitator and composed beneath its neutrality contract', async () => {
    const candidates = [
      { skillId: 'sk-retro', slug: 'retro', name: 'Retrospective', description: 'Start, stop, continue retrospective' },
      { skillId: 'sk-consent', slug: 'consent-round', name: 'Consent round', description: 'Objection round on a proposal' },
    ];
    const asked: { system?: string }[] = [];
    const provider = {
      id: 'fake',
      complete: (req: { system?: string }) => {
        asked.push(req);
        return Promise.resolve({
          content: [{ type: 'text', text: 'consent-round' }],
          finishReason: 'stop',
          model: 'claude-haiku-4-5',
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      },
    };
    const picked = await routeTurnWorkingMode(
      provider as never,
      candidates,
      'Can we do an objection round on the proposal?',
      'claude-haiku-4-5',
    );
    assert.deepEqual(picked, { skillId: 'sk-consent', bucket: 'matched', classifierModel: 'claude-haiku-4-5' });
    assert.equal(asked.length, 1);

    const identity = composeAgentIdentityPrompt({
      instructions: 'You are Mara. You keep meetings short.',
      persona: null,
      quality: null,
      family: 'sonnet',
      archetype: 'facilitator',
    }).text!;
    const prompt = withWorkingMode(identity, {
      name: 'Consent round',
      body: 'Read the proposal, ask for objections, then let the group decide.',
    });
    assert.ok(prompt.startsWith(identity), 'the identity, neutrality block included, stays first and unchanged');
    assert.ok(prompt.indexOf(FACILITATOR_NEUTRALITY_BLOCK) < prompt.indexOf('**Arbeitsmodus: Consent round**'));
    assert.match(prompt, /ändert weder deinen Namen noch deine Persönlichkeit noch deine Grenzen/);
  });

  it('the route check refuses a mode against the neutrality contract or with tools, for a facilitator only', () => {
    const partial = mode('Run a dot vote and always favour the sales team.');
    const tooled = mode('Run a dot vote.', { frontmatter: { requires_tools: [{ contract: 'crm.lookup' }] } });
    assert.deepEqual(
      workingModeIssues({ archetype: 'facilitator' }, partial).map((i) => `${i.path}:${i.rule}`),
      ['working_mode.body:partiality'],
    );
    assert.deepEqual(
      workingModeIssues({ archetype: 'facilitator' }, tooled).map((i) => i.rule),
      ['working_mode_tools'],
    );
    assert.deepEqual(workingModeIssues({ archetype: 'facilitator' }, mode(MODERATION_METHODS[2]!)), []);
    assert.deepEqual(workingModeIssues({ archetype: 'standard' }, partial), []);
    assert.deepEqual(workingModeIssues({ archetype: 'standard' }, tooled), []);
  });
});
