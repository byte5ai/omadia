import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  resolveSkillByName,
  type ResolvableSkill,
  type SkillResolutionContext,
} from '../src/services/skillResolver.js';

function skill(id: string, name: string, ownerScope: string | null, status: ResolvableSkill['lifecycleStatus'] = 'published'): ResolvableSkill {
  return { id, name, ownerScope, lifecycleStatus: status };
}

const REQUESTER: SkillResolutionContext = {
  requesterScope: { kind: 'personal', userId: 'u-1' },
  memberTeams: new Set(['team-a']),
  orgId: 'byte5',
  sharedSkillIds: new Set(),
};

describe('resolveSkillByName — precedence', () => {
  it('personal beats org even at equal names (the dangerous non-empty-wrong-level case)', () => {
    const candidates = [
      skill('s-personal', 'runbook', 'personal:u-1'),
      skill('s-org', 'runbook', 'org:byte5'),
    ];
    const result = resolveSkillByName('runbook', candidates, REQUESTER);
    assert.deepEqual(result, { ok: true, level: 'personal', skill: candidates[0] });
  });

  it('shared beats team beats org', () => {
    const shared = skill('s-shared', 'runbook', 'personal:someone-else');
    const team = skill('s-team', 'runbook', 'group:team-a');
    const org = skill('s-org', 'runbook', 'org:byte5');
    const ctx: SkillResolutionContext = { ...REQUESTER, sharedSkillIds: new Set(['s-shared']) };

    assert.deepEqual(resolveSkillByName('runbook', [shared, team, org], ctx), {
      ok: true,
      level: 'shared',
      skill: shared,
    });
    assert.deepEqual(resolveSkillByName('runbook', [team, org], ctx), {
      ok: true,
      level: 'team',
      skill: team,
    });
    assert.deepEqual(resolveSkillByName('runbook', [org], ctx), {
      ok: true,
      level: 'org',
      skill: org,
    });
  });

  it('falls through correctly when a level is absent (absence at personal -> shared -> team -> org)', () => {
    const org = skill('s-org', 'runbook', 'org:byte5');
    // No personal, no shared, no team candidate at all — only org exists.
    const result = resolveSkillByName('runbook', [org], REQUESTER);
    assert.deepEqual(result, { ok: true, level: 'org', skill: org });
  });

  it('reports not-found when nothing matches at any level', () => {
    const result = resolveSkillByName('missing', [skill('s-org', 'runbook', 'org:byte5')], REQUESTER);
    assert.deepEqual(result, { ok: false, reason: 'not-found' });
  });
});

describe('resolveSkillByName — lifecycle gate (dangerous case #2)', () => {
  it('a draft at a higher-precedence level does NOT win over a published skill at a lower level', () => {
    const draftPersonal = skill('s-draft', 'runbook', 'personal:u-1', 'draft');
    const publishedOrg = skill('s-org', 'runbook', 'org:byte5', 'published');
    const result = resolveSkillByName('runbook', [draftPersonal, publishedOrg], REQUESTER);
    assert.deepEqual(result, { ok: true, level: 'org', skill: publishedOrg });
  });

  it('an archived skill never resolves, even as the only candidate', () => {
    const archived = skill('s-archived', 'runbook', 'personal:u-1', 'archived');
    const result = resolveSkillByName('runbook', [archived], REQUESTER);
    assert.deepEqual(result, { ok: false, reason: 'not-found' });
  });

  it('a reviewed-but-not-published skill never resolves', () => {
    const reviewed = skill('s-reviewed', 'runbook', 'personal:u-1', 'reviewed');
    const result = resolveSkillByName('runbook', [reviewed], REQUESTER);
    assert.deepEqual(result, { ok: false, reason: 'not-found' });
  });
});

describe('resolveSkillByName — ownership + ambiguity', () => {
  it('an unowned (null ownerScope) skill never resolves, at any bucket', () => {
    const unowned = skill('s-unowned', 'runbook', null);
    const ctx: SkillResolutionContext = { ...REQUESTER, sharedSkillIds: new Set(['s-unowned']) };
    const result = resolveSkillByName('runbook', [unowned], ctx);
    assert.deepEqual(result, { ok: false, reason: 'not-found' });
  });

  it('two org skills with the same name are ambiguous, never silently picked', () => {
    const a = skill('s-org-a', 'runbook', 'org:byte5');
    const b = skill('s-org-b', 'runbook', 'org:byte5');
    const result = resolveSkillByName('runbook', [a, b], REQUESTER);
    assert.deepEqual(result, { ok: false, reason: 'ambiguous', level: 'org', candidates: [a, b] });
  });

  it('ambiguity at personal short-circuits — a clean org candidate is never consulted as a tiebreaker', () => {
    const p1 = skill('s-p1', 'runbook', 'personal:u-1');
    const p2 = skill('s-p2', 'runbook', 'personal:u-1');
    const org = skill('s-org', 'runbook', 'org:byte5');
    const result = resolveSkillByName('runbook', [p1, p2, org], REQUESTER);
    assert.deepEqual(result, { ok: false, reason: 'ambiguous', level: 'personal', candidates: [p1, p2] });
  });

  it('personal bucket is empty for a non-personal requester (e.g. a system/routine scope)', () => {
    const personalOwned = skill('s-personal', 'runbook', 'personal:u-1');
    const org = skill('s-org', 'runbook', 'org:byte5');
    const ctx: SkillResolutionContext = {
      ...REQUESTER,
      requesterScope: { kind: 'system', origin: 'routine', id: 'r1' },
    };
    const result = resolveSkillByName('runbook', [personalOwned, org], ctx);
    assert.deepEqual(result, { ok: true, level: 'org', skill: org });
  });

  it('a personal skill owned by a DIFFERENT user does not match the personal bucket (and is not auto-shared)', () => {
    const someoneElses = skill('s-other', 'runbook', 'personal:someone-else');
    const result = resolveSkillByName('runbook', [someoneElses], REQUESTER);
    assert.deepEqual(result, { ok: false, reason: 'not-found' });
  });

  it('team membership in a DIFFERENT team than the owner does not match', () => {
    const otherTeam = skill('s-team-b', 'runbook', 'group:team-b');
    const result = resolveSkillByName('runbook', [otherTeam], REQUESTER);
    assert.deepEqual(result, { ok: false, reason: 'not-found' });
  });

  it('org candidate does not match when requester has no org', () => {
    const org = skill('s-org', 'runbook', 'org:byte5');
    const ctx: SkillResolutionContext = { ...REQUESTER, orgId: undefined };
    const result = resolveSkillByName('runbook', [org], ctx);
    assert.deepEqual(result, { ok: false, reason: 'not-found' });
  });

  it('name matching is case-sensitive', () => {
    const org = skill('s-org', 'Runbook', 'org:byte5');
    const result = resolveSkillByName('runbook', [org], REQUESTER);
    assert.deepEqual(result, { ok: false, reason: 'not-found' });
  });
});
