/**
 * Field classification — auto-approval: the pure eligibility rule
 * (`autoApprovalOf`), the settings parsing, the statuses it yields, and the
 * recompute's auto-approval step end to end (in-memory store, stub guard and
 * Odoo client, the real shared config editor over an in-memory registry).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  PRIVACY_REDACT_SERVICE_NAME,
  type FieldObservation,
  type FieldSampleVerdict,
  type ModelClassificationRequest,
  type ModelClassificationResult,
  type PrivacyGuardService,
} from '@omadia/plugin-api';

import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import {
  AUTO_APPROVE_DEFAULT_CONFIDENCE,
  autoApprovalOf,
  autoApproveSettingsOf,
  parseAutoApproveConfidence,
  parseAutoApproveEnabled,
  type AutoApprovalInput,
} from '../src/privacy/fieldClassification/autoApprove.js';
import {
  applyAutoApprovePlan,
  planAutoApprove,
  type AutoApproveSubject,
} from '../src/privacy/fieldClassification/autoApprovePass.js';
import { createNonPersonalFieldsEditor } from '../src/privacy/fieldClassification/configEditor.js';
import {
  candidateFingerprint,
  classifyBase,
  resolveStatus,
  sourceKeyOf,
} from '../src/privacy/fieldClassification/engine.js';
import { cachedVerdicts, liveStatus } from '../src/privacy/fieldClassification/live.js';
import { recomputeFieldClassification } from '../src/privacy/fieldClassification/recompute.js';
import { InMemoryFieldClassificationStore } from '../src/privacy/fieldClassification/store.js';

const CLEAN = { sampleCount: 12, identityHit: false, c1: 'clean', hitTypes: [] } as const;
const SETTINGS = { confidence: 0.85 };

function input(over: Partial<AutoApprovalInput> = {}): AutoApprovalInput {
  return {
    toolName: 'odoo_execute',
    scope: 'sale.order',
    fieldPath: 'team_id',
    valueShape: 'm2o',
    relationModels: ['crm.team'],
    ...over,
  };
}

const haiku = (model: string, confidence: number, verdict: 'non-personal' | 'personal' | 'uncertain' = 'non-personal') =>
  new Map([[model, { verdict, confidence }]]);

describe('auto-approval — autoApprovalOf', () => {
  it('(a) every target known non-personal: eligible without a name vet, also when never seen', () => {
    const r = autoApprovalOf(input(), SETTINGS);
    assert.deepEqual(r, { eligible: true, basis: 'known_non_personal', entry: 'odoo_execute:sale.order/team_id' });
    // Same with several known targets.
    assert.equal(autoApprovalOf(input({ relationModels: ['crm.team', 'res.company'] }), SETTINGS).eligible, true);
  });

  it('(b) a non-personal schema verdict above the threshold with a clean vet is eligible', () => {
    const r = autoApprovalOf(
      input({ relationModels: ['x_custom.region'], modelVerdicts: haiku('x_custom.region', 0.9), sample: CLEAN }),
      SETTINGS,
    );
    assert.deepEqual(r, {
      eligible: true,
      basis: 'haiku',
      confidence: 0.9,
      entry: 'odoo_execute:sale.order/team_id',
    });
    // A field without relation information goes by its source's verdict.
    const source = input({ relationModels: [], valueShape: 'text', fieldPath: 'note' });
    const verdicts = haiku(sourceKeyOf(source), 0.95);
    assert.equal(autoApprovalOf({ ...source, modelVerdicts: verdicts, sample: CLEAN }, SETTINGS).eligible, true);
  });

  it('(b) exactly the threshold, no name vet, an empty vet, a non-clean or missing verdict: not eligible', () => {
    const base = input({ relationModels: ['x_custom.region'], sample: CLEAN });
    const at = autoApprovalOf({ ...base, modelVerdicts: haiku('x_custom.region', 0.85) }, SETTINGS);
    assert.deepEqual(at, { eligible: false, reason: 'below_threshold' });
    const noVet = autoApprovalOf(
      { ...base, sample: undefined, modelVerdicts: haiku('x_custom.region', 0.95) } as AutoApprovalInput,
      SETTINGS,
    );
    assert.deepEqual(noVet, { eligible: false, reason: 'no_name_vet' });
    const emptyVet = autoApprovalOf(
      { ...base, sample: { ...CLEAN, sampleCount: 0 }, modelVerdicts: haiku('x_custom.region', 0.95) },
      SETTINGS,
    );
    assert.deepEqual(emptyVet, { eligible: false, reason: 'no_name_vet' });
    const unavailable = autoApprovalOf(
      { ...base, sample: { ...CLEAN, c1: 'unavailable' }, modelVerdicts: haiku('x_custom.region', 0.95) },
      SETTINGS,
    );
    assert.deepEqual(unavailable, { eligible: false, reason: 'no_name_vet' });
    assert.deepEqual(autoApprovalOf(base, SETTINGS), { eligible: false, reason: 'no_verdict' });
    assert.deepEqual(
      autoApprovalOf({ ...base, modelVerdicts: haiku('x_custom.region', 0.99, 'uncertain') }, SETTINGS),
      { eligible: false, reason: 'not_non_personal' },
    );
  });

  it('the safeguards override both bases', () => {
    const cases: Array<[Partial<AutoApprovalInput>, string]> = [
      [{ relationModels: ['crm.team', 'res.partner'] }, 'person_model'],
      [{ scope: 'hr.employee', relationModels: ['x_custom.region'] }, 'person_scope'],
      [{ relationModels: ['crm.team', 'x_custom.region'] }, 'conflict'],
      [{ sample: { ...CLEAN, identityHit: true, hitTypes: ['email'] } }, 'detector_hit'],
      [{ sample: { ...CLEAN, c1: 'hit' } }, 'detector_hit'],
      [{ sample: { ...CLEAN, c1: 'near-miss' } }, 'near_miss'],
      [{ scope: '-' }, 'no_scope'],
      [{ valueShape: 'mixed' }, 'invalid_shape'],
      [{ fieldPath: 'a,b' }, 'invalid_field'],
      [{ toolName: '*' }, 'invalid_field'],
    ];
    for (const [over, reason] of cases) {
      assert.deepEqual(autoApprovalOf(input(over), SETTINGS), { eligible: false, reason }, reason);
    }
  });

  it('any earlier decision or an existing entry blocks it', () => {
    for (const action of ['confirm', 'reject', 'keep_masked', 'revert', 'auto_revoke', 'auto_approve'] as const) {
      const r = autoApprovalOf(input({ decision: { action, fingerprint: 'old' } }), SETTINGS);
      assert.deepEqual(r, { eligible: false, reason: 'decided' }, action);
    }
    const covered = autoApprovalOf(input({ coverage: { covered: true, exact: false, legacyEntry: 'team_id' } }), SETTINGS);
    assert.deepEqual(covered, { eligible: false, reason: 'covered' });
  });
});

describe('auto-approval — settings', () => {
  it('L1: the switch is ON only unset or for an explicit yes; anything else is OFF', () => {
    for (const on of [undefined, true, 'true', 'TRUE', ' on ', '1', 'yes', 'Ja']) {
      assert.equal(parseAutoApproveEnabled(on), true, JSON.stringify(on));
    }
    for (const off of [false, 0, 1, '0', 'false', 'off', 'no', 'nein', 'disabled', 'garbage', '', null, {}]) {
      assert.equal(parseAutoApproveEnabled(off), false, JSON.stringify(off));
    }
  });

  it('M3: the threshold parses leniently and is clamped to 0.8–0.99', () => {
    assert.equal(parseAutoApproveConfidence('0,9'), 0.9);
    assert.equal(parseAutoApproveConfidence(' 0.95 '), 0.95);
    assert.equal(parseAutoApproveConfidence(0.8), 0.8);
    assert.equal(parseAutoApproveConfidence(0.99), 0.99);
    for (const low of [0.7, 0.5, 0.3, -1, '0,6']) assert.equal(parseAutoApproveConfidence(low), 0.8, String(low));
    for (const high of [1, '1.5', 5]) assert.equal(parseAutoApproveConfidence(high), 0.99, String(high));
    for (const bad of ['abc', '', undefined, null, Number.NaN]) {
      assert.equal(parseAutoApproveConfidence(bad), AUTO_APPROVE_DEFAULT_CONFIDENCE, String(bad));
    }
    assert.deepEqual(autoApproveSettingsOf({ auto_approve_non_personal: false, auto_approve_confidence: '0,6' }), {
      enabled: false,
      confidence: 0.8,
    });
    assert.deepEqual(autoApproveSettingsOf(undefined), { enabled: true, confidence: 0.85 });
  });
});

describe('auto-approval — statuses', () => {
  const fp = candidateFingerprint({ scope: 'sale.order', relationModels: ['crm.team'], valueShape: 'm2o' });
  const base = classifyBase({ ...input(), sample: CLEAN });
  const exact = { covered: true, exact: true };

  it('an auto_approve decision on the current fingerprint with its entry is auto_approved', () => {
    const shown = resolveStatus(base, fp, exact, { action: 'auto_approve', fingerprint: fp });
    assert.equal(shown.status, 'auto_approved');
    assert.deepEqual(shown.reasons[0], { code: 'auto_approved', basis: 'known_non_personal' });
  });

  it('a drifted or personal auto-approval is a conflict; a confirm takes ownership', () => {
    assert.equal(resolveStatus(base, fp, exact, { action: 'auto_approve', fingerprint: 'old' }).status, 'confirmed_conflict');
    const personal = classifyBase({ ...input({ relationModels: ['res.partner'] }) });
    assert.equal(resolveStatus(personal, fp, exact, { action: 'auto_approve', fingerprint: fp }).status, 'confirmed_conflict');
    assert.equal(resolveStatus(base, fp, exact, { action: 'confirm', fingerprint: fp }).status, 'confirmed');
  });

  it('an auto_revoke decision is auto_revoked until the fingerprint changes', () => {
    const shown = resolveStatus(base, fp, undefined, { action: 'auto_revoke', fingerprint: fp });
    assert.equal(shown.status, 'auto_revoked');
    assert.equal(shown.reasons[0]?.code, 'auto_revoked');
    const later = resolveStatus(base, fp, undefined, { action: 'auto_revoke', fingerprint: 'old' });
    assert.equal(later.status, 'needs_clarification');
    assert.equal(later.reasons[0]?.code, 'changed_since_decision');
  });
});

describe('auto-approval — plan', () => {
  it('caps the approvals per pass and reports the rest as remaining', () => {
    const subjects: AutoApproveSubject[] = ['a_id', 'b_id', 'c_id'].map((fieldPath, i) => ({
      candidate: {
        id: `id-${String(i)}`,
        toolName: 'odoo_execute',
        scope: 'sale.order',
        fieldPath,
        decision: null,
      } as never,
      input: input({ fieldPath }),
      fingerprint: 'fp',
      base: { status: 'suggested', reasons: [] },
    }));
    const plan = planAutoApprove(subjects, '', { enabled: true, confidence: 0.85 }, 2);
    assert.equal(plan.approve.length, 2);
    assert.equal(plan.remaining, 1);
    const off = planAutoApprove(subjects, '', { enabled: false, confidence: 0.85 });
    assert.equal(off.approve.length, 0);
    assert.equal(off.blocked['disabled'], 3);
  });
});

// ---------------------------------------------------------------------------
// Recompute end to end
// ---------------------------------------------------------------------------

const GUARD_ID = '@omadia/plugin-privacy-guard';

type Fields = Record<string, Record<string, { type: string; relation?: string; string?: string }>>;

interface Harness {
  readonly store: InMemoryFieldClassificationStore;
  readonly registry: InMemoryInstalledRegistry;
  readonly audits: Array<Record<string, unknown>>;
  readonly writes: unknown[];
  readonly editor: ReturnType<typeof createNonPersonalFieldsEditor>;
  fields: Fields;
  samples: Record<string, Partial<FieldSampleVerdict>>;
  queue(observations: FieldObservation[]): void;
  /** Field paths vetted, in order. */
  readonly vetted: string[];
  run(): ReturnType<typeof recomputeFieldClassification>;
  npf(): unknown;
}

function obs(fieldPath: string, scope: string, over: Partial<FieldObservation> = {}): FieldObservation {
  return {
    toolName: 'odoo_execute',
    scope,
    fieldPath,
    valueShape: 'm2o',
    seenCount: 3,
    firstSeenAt: '2026-10-30T08:00:00.000Z',
    lastSeenAt: '2026-10-30T09:00:00.000Z',
    ...over,
  };
}

async function makeHarness(opts: {
  readonly config?: Record<string, unknown>;
  readonly fields: Fields;
  readonly haiku?: (req: ModelClassificationRequest) => ModelClassificationResult;
  readonly now?: () => Date;
}): Promise<Harness> {
  const store = new InMemoryFieldClassificationStore();
  const registry = new InMemoryInstalledRegistry();
  await registry.register({
    id: GUARD_ID,
    installed_version: '0.16.0',
    installed_at: '2026-10-30T08:00:00.000Z',
    status: 'active',
    config: opts.config ?? {},
  });
  const writes: unknown[] = [];
  const original = registry.updateConfig.bind(registry);
  registry.updateConfig = async (id, next) => {
    writes.push(next);
    await original(id, next);
  };
  const catalog = {
    get: (id: string) => (id === GUARD_ID ? { plugin: { provides: ['privacy.redact@1'] } } : undefined),
  } as unknown as PluginCatalog;
  const editor = createNonPersonalFieldsEditor({ installedRegistry: registry, catalog });
  const audits: Array<Record<string, unknown>> = [];
  let pending: FieldObservation[] = [];
  const h: Harness = {
    store,
    registry,
    audits,
    writes,
    editor,
    fields: opts.fields,
    samples: {},
    vetted: [],
    queue(observations) {
      pending = [...pending, ...observations];
    },
    npf: () => registry.get(GUARD_ID)?.config['non_personal_fields'],
    run() {
      const guard: Partial<PrivacyGuardService> = {
        takeFieldObservations: () => {
          const out = pending;
          pending = [];
          return out;
        },
        vetFieldSample: async ({ toolName, scope, fieldPath }) => {
          h.vetted.push(fieldPath);
          return {
            toolName,
            scope,
            fieldPath,
            sampleCount: 12,
            identityHit: false,
            c1: 'clean',
            hitTypes: [],
            ...h.samples[fieldPath],
          };
        },
        maskedFieldPreview: () => ['••••'],
        ...(opts.haiku
          ? {
              classifyModelsSchemaOnly: async (requests: readonly ModelClassificationRequest[]) =>
                requests.map(opts.haiku!),
            }
          : {}),
      };
      const services: Record<string, unknown> = {
        [PRIVACY_REDACT_SERVICE_NAME]: guard,
        'odoo.client': { execute: async (req: { model: string }) => h.fields[req.model] ?? {} },
      };
      return recomputeFieldClassification({
        store,
        ...(opts.now !== undefined ? { now: opts.now } : {}),
        serviceRegistry: {
          get: <T,>(name: string) => services[name] as T | undefined,
          providedBy: (owner: string, name: string) => owner === '@omadia/integration-odoo' && name in services,
        },
        readNonPersonalFields: () => {
          const v = registry.get(GUARD_ID)?.config['non_personal_fields'];
          return typeof v === 'string' ? v : undefined;
        },
        autoApprove: {
          editor,
          audit: {
            record: async (entry) => {
              audits.push(entry as unknown as Record<string, unknown>);
            },
          },
        },
      });
    },
  };
  return h;
}

const SALE_FIELDS: Fields = {
  'sale.order': {
    team_id: { type: 'many2one', relation: 'crm.team' },
    partner_id: { type: 'many2one', relation: 'res.partner' },
    region_id: { type: 'many2one', relation: 'x_custom.region' },
  },
  'hr.employee': {
    department_id: { type: 'many2one', relation: 'hr.department' },
  },
};

const byPath = async (store: InMemoryFieldClassificationStore, scope: string, path: string) =>
  (await store.list()).find((c) => c.scope === scope && c.fieldPath === path);

describe('auto-approval — recompute', () => {
  it('switch on (default): writes the scoped entries once, decision + one audit row per field as system:auto-classifier', async () => {
    const h = await makeHarness({ config: { non_personal_fields: 'odoo_execute:x.y/keep_me' }, fields: SALE_FIELDS });
    h.queue([obs('team_id', 'sale.order'), obs('partner_id', 'sale.order'), obs('department_id', 'hr.employee')]);
    const result = await h.run();
    assert.equal(result.autoApprove?.approved, 2);
    assert.equal(h.writes.length, 1, 'one config write per pass');
    const written = String(h.npf()).split('\n');
    assert.deepEqual(written.slice(0, 1), ['odoo_execute:x.y/keep_me']);
    assert.deepEqual(
      written.slice(1).sort(),
      ['odoo_execute:hr.employee/department_id', 'odoo_execute:sale.order/team_id'],
    );

    const team = await byPath(h.store, 'sale.order', 'team_id');
    assert.equal(team?.status, 'auto_approved');
    assert.equal(team?.decision?.action, 'auto_approve');
    assert.equal(team?.decision?.byEmail, 'system:auto-classifier');
    assert.equal(team?.decision?.byId, null);
    assert.equal(team?.decision?.fingerprint, team?.fingerprint);
    assert.equal((await byPath(h.store, 'sale.order', 'partner_id'))?.status, 'personal');
    // A field OF a person model that points to a known non-personal model
    // (an employee's department) is the case auto-approval exists for.
    assert.equal((await byPath(h.store, 'hr.employee', 'department_id'))?.status, 'auto_approved');

    assert.deepEqual(
      [...h.audits].sort((a, b) =>
        String((a as { target?: unknown }).target).localeCompare(String((b as { target?: unknown }).target)),
      ),
      [
        {
          actor: { email: 'system:auto-classifier' },
          action: 'privacy.field_auto_approve',
          target: 'privacy-field:odoo_execute:hr.employee/department_id',
          after: { basis: 'known_non_personal', entry: 'odoo_execute:hr.employee/department_id', plugin: GUARD_ID },
        },
        {
          actor: { email: 'system:auto-classifier' },
          action: 'privacy.field_auto_approve',
          target: 'privacy-field:odoo_execute:sale.order/team_id',
          after: { basis: 'known_non_personal', entry: 'odoo_execute:sale.order/team_id', plugin: GUARD_ID },
        },
      ],
    );

    // A second pass changes nothing.
    await h.run();
    assert.equal(h.writes.length, 1);
    assert.equal(h.audits.length, 2);
  });

  it('switch off: nothing is written and the field stays a suggestion', async () => {
    const h = await makeHarness({ config: { auto_approve_non_personal: false }, fields: SALE_FIELDS });
    h.queue([obs('team_id', 'sale.order')]);
    const result = await h.run();
    assert.equal(result.autoApprove?.approved, 0);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.audits, []);
    assert.equal((await byPath(h.store, 'sale.order', 'team_id'))?.status, 'suggested');
  });

  it('the threshold comes from the settings', async () => {
    const haiku = (req: ModelClassificationRequest): ModelClassificationResult => ({
      model: req.model,
      verdict: 'non-personal',
      confidence: 0.9,
      reason: 'regions',
    });
    const strict = await makeHarness({ config: { auto_approve_confidence: '0,95' }, fields: SALE_FIELDS, haiku });
    strict.queue([obs('region_id', 'sale.order')]);
    await strict.run();
    assert.equal((await byPath(strict.store, 'sale.order', 'region_id'))?.status, 'suggested');
    assert.deepEqual(strict.writes, []);

    const lenient = await makeHarness({ config: { auto_approve_confidence: '0.85' }, fields: SALE_FIELDS, haiku });
    lenient.queue([obs('region_id', 'sale.order')]);
    await lenient.run();
    const region = await byPath(lenient.store, 'sale.order', 'region_id');
    assert.equal(region?.status, 'auto_approved');
    // The page lays the decision over the stored inputs (`liveStatus`).
    const verdicts = await cachedVerdicts(lenient.store, [region!]);
    const shown = liveStatus(region!, lenient.npf() as string, verdicts);
    assert.equal(shown.status, 'auto_approved');
    assert.deepEqual(shown.reasons[0], { code: 'auto_approved', basis: 'haiku', confidence: 0.9 });
    assert.deepEqual(lenient.audits[0]?.['after'], {
      basis: 'haiku',
      confidence: 0.9,
      entry: 'odoo_execute:sale.order/region_id',
      plugin: GUARD_ID,
    });
  });

  it('drift revokes exactly its entry with an audit row, and the field is never auto-approved again', async () => {
    const h = await makeHarness({
      config: { non_personal_fields: 'odoo_execute:sale.order/other_id' },
      fields: structuredClone(SALE_FIELDS),
    });
    h.queue([obs('team_id', 'sale.order')]);
    await h.run();
    assert.equal(h.npf(), 'odoo_execute:sale.order/other_id\nodoo_execute:sale.order/team_id');

    // The field now points to a person model.
    h.fields['sale.order']!['team_id'] = { type: 'many2one', relation: 'res.partner' };
    const result = await h.run();
    assert.equal(result.autoApprove?.revoked, 1);
    assert.equal(h.npf(), 'odoo_execute:sale.order/other_id');
    const team = await byPath(h.store, 'sale.order', 'team_id');
    assert.equal(team?.status, 'auto_revoked');
    assert.equal(team?.decision?.action, 'auto_revoke');
    assert.equal(team?.decision?.byEmail, 'system:auto-classifier');
    const revoke = h.audits.find((a) => a['action'] === 'privacy.field_auto_revoke');
    assert.deepEqual(revoke, {
      actor: { email: 'system:auto-classifier' },
      action: 'privacy.field_auto_revoke',
      target: 'privacy-field:odoo_execute:sale.order/team_id',
      after: { reason: 'person_model', entry: 'odoo_execute:sale.order/team_id', removed: true, plugin: GUARD_ID },
    });

    // Back to a known model: still not re-approved (the revoke stands).
    h.fields['sale.order']!['team_id'] = { type: 'many2one', relation: 'crm.team' };
    await h.run();
    assert.equal(h.npf(), 'odoo_execute:sale.order/other_id');
    assert.equal(h.audits.filter((a) => a['action'] === 'privacy.field_auto_approve').length, 1);
  });

  it('a detector near-miss revokes too', async () => {
    const h = await makeHarness({ fields: SALE_FIELDS });
    h.queue([obs('team_id', 'sale.order')]);
    await h.run();
    const team = await byPath(h.store, 'sale.order', 'team_id');
    // A fresh vet (the stored one is dropped) now reports a near-miss.
    await h.store.saveClassification(team!.id, {
      relationModels: team!.relationModels,
      status: team!.status,
      reasons: team!.reasons,
      fingerprint: 'stale',
      computedAt: team!.computedAt!,
    });
    h.samples['team_id'] = { c1: 'near-miss' };
    await h.run();
    assert.equal((await byPath(h.store, 'sale.order', 'team_id'))?.status, 'auto_revoked');
    assert.equal(h.npf(), undefined, 'the last entry out removes the key');
    const revoke = h.audits.find((a) => a['action'] === 'privacy.field_auto_revoke');
    assert.equal((revoke?.['after'] as { reason: string }).reason, 'near_miss');
  });

  it('an admin revert is final: the field is never auto-approved again', async () => {
    const h = await makeHarness({ fields: SALE_FIELDS });
    h.queue([obs('team_id', 'sale.order')]);
    await h.run();
    const team = (await byPath(h.store, 'sale.order', 'team_id'))!;
    // What the decision route does on revert: entry out, decision revert.
    await h.registry.updateConfig(GUARD_ID, {});
    await h.store.saveDecision(
      team.id,
      { action: 'revert', fingerprint: team.fingerprint, byId: null, byEmail: 'admin@example.com', at: '2026-10-31T00:00:00.000Z' },
      'suggested',
    );
    const writesBefore = h.writes.length;
    await h.run();
    assert.equal(h.writes.length, writesBefore);
    assert.equal(h.npf(), undefined);
    assert.equal((await byPath(h.store, 'sale.order', 'team_id'))?.status, 'suggested');
  });

  it('switch off keeps earlier auto-approvals (no mass revoke)', async () => {
    const h = await makeHarness({ fields: SALE_FIELDS });
    h.queue([obs('team_id', 'sale.order')]);
    await h.run();
    await h.registry.updateConfig(GUARD_ID, {
      ...h.registry.get(GUARD_ID)!.config,
      auto_approve_non_personal: false,
    });
    await h.run();
    assert.equal(h.npf(), 'odoo_execute:sale.order/team_id');
    assert.equal((await byPath(h.store, 'sale.order', 'team_id'))?.status, 'auto_approved');
  });

  it('counts auto-approvals since the visit and open revocations', async () => {
    const h = await makeHarness({ fields: SALE_FIELDS });
    await h.store.markVisit('admin', new Date('2020-01-01T00:00:00.000Z'));
    h.queue([obs('team_id', 'sale.order')]);
    await h.run();
    const counts = await h.store.countOpen('admin');
    assert.equal(counts.autoApprovedNew, 1);
    assert.equal(counts.autoRevoked, 0);
    assert.equal((await h.store.countOpen()).autoApprovedNew, 0, 'no visitor → 0');
    assert.equal((await h.store.countOpen('never-visited')).autoApprovedNew, 0, 'no visit → 0');
    await h.store.markVisit('admin', new Date(Date.now() + 60_000));
    assert.equal((await h.store.countOpen('admin')).autoApprovedNew, 0);
  });
});

// ---------------------------------------------------------------------------
// Security review (2026-10-31): one regression test per finding.
// ---------------------------------------------------------------------------

const HAIKU_09 = (req: ModelClassificationRequest): ModelClassificationResult => ({
  model: req.model,
  verdict: 'non-personal',
  confidence: 0.9,
  reason: 'regions',
});

const AUTO_DECISION = {
  action: 'auto_approve',
  fingerprint: 'old',
  byId: null,
  byEmail: 'system:auto-classifier',
  at: '2026-10-30T00:00:00.000Z',
  batchId: null,
} as const;

describe('auto-approval — security review', () => {
  it('H1: an auto-approved field is re-vetted every pass; a name hit revokes it in that same pass', async () => {
    const h = await makeHarness({ fields: SALE_FIELDS });
    h.queue([obs('team_id', 'sale.order')]);
    await h.run();
    assert.equal((await byPath(h.store, 'sale.order', 'team_id'))?.status, 'auto_approved');
    h.vetted.splice(0);
    // The guard reports the cleared field's sightings (and sampled its values).
    h.queue([obs('team_id', 'sale.order', { cleared: true }), obs('ghost_id', 'sale.order', { cleared: true })]);
    h.samples['team_id'] = { c1: 'hit', hitTypes: ['person'] };
    const result = await h.run();
    assert.deepEqual(h.vetted, ['team_id'], 'vetted although its fingerprint is unchanged');
    assert.equal(result.autoApprove?.revoked, 1);
    const team = await byPath(h.store, 'sale.order', 'team_id');
    assert.equal(team?.status, 'auto_revoked');
    assert.equal(team?.sampleVerdict?.c1, 'hit', 'the new verdict replaces the stored one');
    assert.equal(team?.seenCount, 6, 'a cleared sighting of a listed field counts');
    assert.equal(h.npf(), undefined);
    const revoke = h.audits.find((a) => a['action'] === 'privacy.field_auto_revoke');
    assert.equal((revoke?.['after'] as { reason: string }).reason, 'detector_hit');
    assert.equal(await byPath(h.store, 'sale.order', 'ghost_id'), undefined, 'a cleared sighting creates no candidate');
  });

  it('H1: after a fingerprint change, basis haiku is refreshed only on a fresh clean vet', () => {
    const subject = (over: Partial<AutoApproveSubject> & { readonly path?: string }): AutoApproveSubject => {
      const fieldPath = over.path ?? 'region_id';
      return {
        candidate: { id: fieldPath, toolName: 'odoo_execute', scope: 'sale.order', fieldPath, decision: AUTO_DECISION } as never,
        input: input({
          fieldPath,
          relationModels: ['x_custom.region'],
          modelVerdicts: haiku('x_custom.region', 0.9),
          sample: CLEAN,
        }),
        fingerprint: 'new',
        base: { status: 'suggested', reasons: [] },
        ...over,
      };
    };
    const config = 'odoo_execute:sale.order/region_id\nodoo_execute:sale.order/team_id';
    const on = { enabled: true, confidence: 0.85 };
    const stale = planAutoApprove([subject({})], config, on);
    assert.deepEqual(stale.revoke.map((r) => r.reason), ['no_fresh_vet']);
    assert.equal(stale.refresh.length, 0);
    const fresh = planAutoApprove([subject({ freshSample: CLEAN })], config, on);
    assert.equal(fresh.revoke.length, 0);
    assert.equal(fresh.refresh.length, 1);
    const dirty = planAutoApprove([subject({ freshSample: { ...CLEAN, sampleCount: 3 } })], config, on);
    assert.deepEqual(dirty.revoke.map((r) => r.reason), ['no_fresh_vet']);
    // Basis (a) is deterministic: no fresh vet needed.
    const known = planAutoApprove([subject({ path: 'team_id', input: input() })], config, on);
    assert.equal(known.refresh.length, 1);
  });

  it('H2: a many2one field without resolved targets is never approved on the source verdict', () => {
    const m2o = input({ relationModels: [], fieldPath: 'x_id' });
    const verdicts = haiku(sourceKeyOf(m2o), 0.95);
    assert.deepEqual(autoApprovalOf({ ...m2o, modelVerdicts: verdicts, sample: CLEAN }, SETTINGS), {
      eligible: false,
      reason: 'no_relation_target',
    });
    const text = { ...m2o, valueShape: 'text' as const };
    assert.equal(autoApprovalOf({ ...text, modelVerdicts: verdicts, sample: CLEAN }, SETTINGS).eligible, true);
  });

  it('M1: a decision made before the pass takes the lock is re-read there and never overwritten', async () => {
    const h = await makeHarness({ fields: SALE_FIELDS });
    const original = h.store.get.bind(h.store);
    let raced = false;
    h.store.get = async (id) => {
      const row = await original(id);
      if (!raced && row?.fieldPath === 'team_id') {
        raced = true;
        await h.store.saveDecision(
          id,
          { action: 'reject', fingerprint: row.fingerprint, byId: null, byEmail: 'admin@example.com', at: '2026-10-31T00:00:00.000Z' },
          'rejected',
        );
        return original(id);
      }
      return row;
    };
    h.queue([obs('team_id', 'sale.order')]);
    const result = await h.run();
    assert.equal(raced, true);
    assert.equal(result.autoApprove?.approved, 0);
    assert.equal(result.autoApprove?.stale, 1);
    assert.equal(h.npf(), undefined);
    assert.equal((await byPath(h.store, 'sale.order', 'team_id'))?.decision?.action, 'reject');
    assert.deepEqual(h.audits, []);
  });

  it('M1: a decision made after the lock check wins the compare-and-set; the entry is rolled back', async () => {
    const h = await makeHarness({ fields: SALE_FIELDS });
    const write = h.registry.updateConfig.bind(h.registry);
    let raced = false;
    h.registry.updateConfig = async (id, next) => {
      await write(id, next);
      if (raced) return;
      raced = true;
      const team = (await byPath(h.store, 'sale.order', 'team_id'))!;
      await h.store.saveDecision(
        team.id,
        { action: 'keep_masked', fingerprint: team.fingerprint, byId: null, byEmail: 'admin@example.com', at: '2026-10-31T00:00:00.000Z' },
        'kept_masked',
      );
    };
    h.queue([obs('team_id', 'sale.order')]);
    const result = await h.run();
    assert.equal(result.autoApprove?.approved, 0);
    assert.equal(h.npf(), undefined, 'rolled back');
    assert.equal((await byPath(h.store, 'sale.order', 'team_id'))?.decision?.action, 'keep_masked');
  });

  it('M2: a threshold raised above the approval revokes it (not only the safeguards do)', async () => {
    const h = await makeHarness({ fields: SALE_FIELDS, haiku: HAIKU_09 });
    h.queue([obs('region_id', 'sale.order')]);
    await h.run();
    assert.equal((await byPath(h.store, 'sale.order', 'region_id'))?.status, 'auto_approved');
    await h.registry.updateConfig(GUARD_ID, { ...h.registry.get(GUARD_ID)!.config, auto_approve_confidence: '0.95' });
    await h.run();
    assert.equal((await byPath(h.store, 'sale.order', 'region_id'))?.status, 'auto_revoked');
    assert.equal(h.npf(), undefined);
    const revoke = h.audits.find((a) => a['action'] === 'privacy.field_auto_revoke');
    assert.equal((revoke?.['after'] as { reason: string }).reason, 'below_threshold');
  });

  it('M2: a verdict that flipped to personal revokes', async () => {
    const h = await makeHarness({ fields: SALE_FIELDS, haiku: HAIKU_09 });
    h.queue([obs('region_id', 'sale.order')]);
    await h.run();
    await h.store.saveModelVerdicts([
      { model: 'x_custom.region', verdict: 'personal', source: 'haiku', confidence: 0.9, reason: '', fieldsHash: '' },
    ]);
    await h.run();
    assert.equal(h.npf(), undefined);
    const revoke = h.audits.find((a) => a['action'] === 'privacy.field_auto_revoke');
    assert.equal((revoke?.['after'] as { reason: string }).reason, 'not_non_personal');
  });

  it('M2: a new relation target without a verdict revokes', async () => {
    const h = await makeHarness({ fields: structuredClone(SALE_FIELDS) });
    h.queue([obs('team_id', 'sale.order')]);
    await h.run();
    h.fields['sale.order']!['team_id'] = { type: 'many2one', relation: 'x_custom.thing' };
    await h.run();
    assert.equal(h.npf(), undefined);
    const revoke = h.audits.find((a) => a['action'] === 'privacy.field_auto_revoke');
    assert.equal((revoke?.['after'] as { reason: string }).reason, 'no_verdict');
  });

  it('L3: a revoked field a legacy entry still clears says so in the audit row and the status reasons', async () => {
    const h = await makeHarness({ fields: SALE_FIELDS });
    h.queue([obs('team_id', 'sale.order')]);
    await h.run();
    await h.registry.updateConfig(GUARD_ID, {
      ...h.registry.get(GUARD_ID)!.config,
      non_personal_fields: 'odoo_execute:sale.order/team_id\nodoo_execute:team_id',
    });
    await h.run();
    assert.equal(h.npf(), 'odoo_execute:team_id', 'exactly its own entry is removed');
    const revoke = h.audits.find((a) => a['action'] === 'privacy.field_auto_revoke');
    assert.deepEqual(revoke?.['after'], {
      reason: 'covered',
      entry: 'odoo_execute:sale.order/team_id',
      removed: true,
      legacyStillCovers: 'odoo_execute:team_id',
      plugin: GUARD_ID,
    });
    const team = (await byPath(h.store, 'sale.order', 'team_id'))!;
    assert.equal(team.status, 'auto_revoked');
    const shown = liveStatus(team, h.npf() as string, await cachedVerdicts(h.store, [team]));
    assert.equal(shown.status, 'auto_revoked');
    assert.ok(shown.reasons.some((r) => r.code === 'legacy_entry' && r.entry === 'odoo_execute:team_id'));
  });

  it('M3: basis (b) needs a confidence above max(threshold, 0.8)', () => {
    const region = input({ relationModels: ['x_custom.region'], sample: CLEAN });
    const low = { confidence: 0.5 };
    assert.deepEqual(autoApprovalOf({ ...region, modelVerdicts: haiku('x_custom.region', 0.8) }, low), {
      eligible: false,
      reason: 'below_threshold',
    });
    assert.equal(autoApprovalOf({ ...region, modelVerdicts: haiku('x_custom.region', 0.81) }, low).eligible, true);
  });

  it('M4: from a person scope only allow-listed targets are auto-approved', () => {
    const blocked: Array<[string, string, string]> = [
      ['hr.leave', 'holiday_status_id', 'hr.leave.type'],
      ['hr.employee', 'category_ids', 'hr.employee.category'],
      ['res.partner', 'title', 'res.partner.title'],
    ];
    for (const [scope, fieldPath, target] of blocked) {
      assert.deepEqual(
        autoApprovalOf(input({ scope, fieldPath, relationModels: [target], sample: CLEAN }), SETTINGS),
        { eligible: false, reason: 'person_scope' },
        `${scope}/${fieldPath}`,
      );
    }
    for (const [scope, fieldPath, target] of [
      ['hr.employee', 'department_id', 'hr.department'],
      ['res.partner', 'country_id', 'res.country'],
    ] as const) {
      assert.equal(
        autoApprovalOf(input({ scope, fieldPath, relationModels: [target] }), SETTINGS).eligible,
        true,
        `${scope}/${fieldPath}`,
      );
    }
  });

  it('M5: basis (b) needs a clean vet over at least 10 values', () => {
    const region = input({ relationModels: ['x_custom.region'], modelVerdicts: haiku('x_custom.region', 0.9) });
    assert.deepEqual(autoApprovalOf({ ...region, sample: { ...CLEAN, sampleCount: 9 } }, SETTINGS), {
      eligible: false,
      reason: 'no_name_vet',
    });
    assert.equal(autoApprovalOf({ ...region, sample: { ...CLEAN, sampleCount: 10 } }, SETTINGS).eligible, true);
  });

  it('L2: one failing field neither stops the pass nor leaves its entry without a decision row', async () => {
    const fields = structuredClone(SALE_FIELDS);
    fields['sale.order']!['stage_id'] = { type: 'many2one', relation: 'crm.stage' };
    const h = await makeHarness({ fields });
    const save = h.store.saveDecision.bind(h.store);
    h.store.saveDecision = async (id, decision, status, expected) => {
      if ((await h.store.get(id))?.fieldPath === 'stage_id') throw new Error('db down');
      return save(id, decision, status, expected);
    };
    h.queue([obs('stage_id', 'sale.order'), obs('team_id', 'sale.order')]);
    const result = await h.run();
    assert.equal(result.autoApprove?.approved, 1);
    assert.equal(h.npf(), 'odoo_execute:sale.order/team_id');
    assert.equal((await byPath(h.store, 'sale.order', 'stage_id'))?.decision, null);
  });

  it('L2: a revoke of a field that cannot form an entry does not throw mid-pass', async () => {
    const h = await makeHarness({ fields: SALE_FIELDS });
    await h.store.upsertObservation(obs('team_id', 'sale.order', { toolName: '*' }));
    const row = (await h.store.list())[0]!;
    await h.store.saveDecision(row.id, { ...AUTO_DECISION, fingerprint: row.fingerprint }, 'auto_approved');
    const stored = (await h.store.get(row.id))!;
    const subject: AutoApproveSubject = {
      candidate: stored,
      input: input({ toolName: '*' }),
      fingerprint: stored.fingerprint,
      base: { status: 'suggested', reasons: [] },
    };
    const result = await applyAutoApprovePlan(
      { approve: [], refresh: [], revoke: [{ subject, reason: 'invalid_field' }], remaining: 0, blocked: {} },
      { store: h.store, editor: h.editor, audit: { record: async (e) => void h.audits.push(e as never) }, now: () => new Date(), log: () => undefined },
    );
    assert.equal(result.revoked, 1);
    assert.deepEqual(h.audits[0]?.['after'], { reason: 'invalid_field', removed: false, plugin: GUARD_ID });
  });

  it('L4: an auto-approval is decided at the time of the write, not at the start of the pass', async () => {
    let t = Date.parse('2026-10-31T10:00:00.000Z');
    const h = await makeHarness({ fields: SALE_FIELDS, now: () => new Date((t += 1000)) });
    h.queue([obs('team_id', 'sale.order')]);
    const result = await h.run();
    const team = (await byPath(h.store, 'sale.order', 'team_id'))!;
    assert.ok(team.decision!.at > result.computedAt, `${team.decision!.at} > ${result.computedAt}`);
  });
});
