/**
 * #1556 follow-up (contract v2) — field classification: the pure classifier,
 * the scoped config helpers, and the recompute pass end to end against an
 * in-memory store, a stub privacy guard and a stub Odoo client.
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

import {
  appendConfigEntry,
  candidateFingerprint,
  classifyCandidate,
  configCoverage,
  configEntryOf,
  InvalidFieldEntryError,
  isValidFieldIdentity,
  legacyEntries,
  removeConfigEntry,
  replaceLegacyEntry,
  type CandidateKey,
  type ClassifyInput,
  type ModelVerdictSummary,
} from '../src/privacy/fieldClassification/engine.js';
import { KNOWN_NON_PERSONAL_MODELS, PERSON_MODELS, catalogVerdictOf } from '../src/privacy/fieldClassification/modelCatalog.js';
import {
  createFieldClassificationScheduler,
  isCandidateObservation,
  recomputeFieldClassification,
  type RecomputeDeps,
} from '../src/privacy/fieldClassification/recompute.js';
import { InMemoryFieldClassificationStore } from '../src/privacy/fieldClassification/store.js';

const CLEAN = { sampleCount: 12, identityHit: false, c1: 'clean', hitTypes: [] } as const;
const DATASET = '0f5c1c3a-1111-4222-8333-444455556666';

function input(over: Partial<ClassifyInput>): ClassifyInput {
  return {
    toolName: 'odoo_execute',
    scope: 'hr.employee',
    fieldPath: 'department_id',
    valueShape: 'm2o',
    relationModels: ['hr.department'],
    sample: CLEAN,
    ...over,
  };
}

const key = (over: Partial<CandidateKey> = {}): CandidateKey => ({
  toolName: 'odoo_execute',
  scope: 'hr.employee',
  fieldPath: 'department_id',
  ...over,
});

const codes = (r: { reasons: readonly { code: string }[] }): string[] => r.reasons.map((x) => x.code);

describe('field classification — model catalog', () => {
  it('lists the person models generously and keeps tags out of them', () => {
    for (const m of ['res.partner', 'res.users', 'hr.employee', 'res.partner.bank', 'hr.leave', 'mail.message']) {
      assert.equal(catalogVerdictOf(m), 'personal', m);
    }
    assert.equal(PERSON_MODELS.has('res.partner.category'), false);
    for (const m of ['hr.department', 'hr.job', 'res.company', 'product.product', 'crm.stage']) {
      assert.equal(catalogVerdictOf(m), 'non-personal', m);
    }
    assert.equal(catalogVerdictOf('x_custom.region'), 'unknown');
  });

  it('chat channels and timesheet lines are person models', () => {
    for (const m of ['discuss.channel', 'discuss.channel.member', 'mail.channel', 'account.analytic.line']) {
      assert.equal(catalogVerdictOf(m), 'personal', m);
    }
  });

  it('projects and analytic accounts (often named after a customer) are not known non-personal', () => {
    for (const m of ['project.project', 'account.analytic.account']) {
      assert.equal(KNOWN_NON_PERSONAL_MODELS.has(m), false, m);
      assert.equal(catalogVerdictOf(m), 'unknown', m);
    }
    assert.equal(catalogVerdictOf('res.company'), 'non-personal');
  });
});

describe('field classification — classifyCandidate', () => {
  for (const model of ['res.partner', 'res.users', 'hr.employee', 'res.partner.bank']) {
    it(`a relation to ${model} is personal`, () => {
      const r = classifyCandidate(input({ fieldPath: 'x_id', relationModels: [model] }));
      assert.equal(r.status, 'personal');
      assert.deepEqual(r.reasons, [{ code: 'person_model', models: [model] }]);
    });
  }

  it('one person target among several makes the field personal', () => {
    const r = classifyCandidate(
      input({ relationModels: ['hr.department', 'res.partner', 'x_custom.region'] }),
    );
    assert.equal(r.status, 'personal');
    assert.deepEqual(codes(r), ['person_model']);
  });

  it('a person target beats a confident non-personal schema verdict', () => {
    const verdicts = new Map<string, ModelVerdictSummary>([
      ['res.partner', { verdict: 'non-personal', confidence: 0.99 }],
    ]);
    const r = classifyCandidate(input({ relationModels: ['res.partner'], modelVerdicts: verdicts }));
    assert.equal(r.status, 'personal');
  });

  it('the detectors veto: identity hit and C1 hit are personal, a near-miss needs clarification', () => {
    const identity = classifyCandidate(
      input({ sample: { sampleCount: 3, identityHit: true, c1: 'clean', hitTypes: ['email'] } }),
    );
    assert.equal(identity.status, 'personal');
    assert.deepEqual(identity.reasons, [{ code: 'identity_hit', hitTypes: ['email'] }]);

    const name = classifyCandidate(input({ sample: { ...CLEAN, c1: 'hit' } }));
    assert.equal(name.status, 'personal');
    assert.deepEqual(codes(name), ['name_hit']);

    const near = classifyCandidate(input({ sample: { ...CLEAN, c1: 'near-miss' } }));
    assert.equal(near.status, 'needs_clarification');
    assert.ok(codes(near).includes('name_near_miss'));
  });

  it('a known non-personal target with a clean sample is suggested', () => {
    const r = classifyCandidate(input({}));
    assert.equal(r.status, 'suggested');
    assert.deepEqual(r.reasons, [
      { code: 'known_non_personal', models: ['hr.department'] },
      { code: 'sample_clean', sampleCount: 12 },
    ]);
  });

  it('without the name detector (or without a sample) it is never suggested', () => {
    const unavailable = classifyCandidate(input({ sample: { ...CLEAN, c1: 'unavailable' } }));
    assert.equal(unavailable.status, 'needs_clarification');
    assert.deepEqual(codes(unavailable), ['known_non_personal', 'name_detector_unavailable']);

    const empty = classifyCandidate(input({ sample: { ...CLEAN, sampleCount: 0 } }));
    assert.equal(empty.status, 'needs_clarification');
    assert.deepEqual(codes(empty), ['known_non_personal', 'name_detector_unavailable']);

    const { sample: _none, ...noSample } = input({});
    const none = classifyCandidate(noSample);
    assert.equal(none.status, 'needs_clarification');
    assert.ok(codes(none).includes('name_detector_unavailable'));
  });

  it('targets with mixed catalog verdicts need clarification', () => {
    const r = classifyCandidate(input({ relationModels: ['hr.department', 'x_custom.region'] }));
    assert.equal(r.status, 'needs_clarification');
    assert.deepEqual(r.reasons, [
      { code: 'conflicting_targets', models: ['hr.department', 'x_custom.region'] },
    ]);
  });

  it('an unknown model follows the schema verdict', () => {
    const verdictOf = (verdict: ModelVerdictSummary) =>
      classifyCandidate(
        input({
          relationModels: ['x_custom.region'],
          modelVerdicts: new Map([['x_custom.region', verdict]]),
        }),
      );
    const yes = verdictOf({ verdict: 'non-personal', confidence: 0.9 });
    assert.equal(yes.status, 'suggested');
    assert.deepEqual(yes.reasons[0], {
      code: 'haiku_non_personal',
      model: 'x_custom.region',
      confidence: 0.9,
    });
    assert.equal(verdictOf({ verdict: 'non-personal', confidence: 0.6 }).status, 'needs_clarification');
    assert.deepEqual(codes(verdictOf({ verdict: 'non-personal', confidence: 0.6 })), ['haiku_uncertain']);
    assert.equal(verdictOf({ verdict: 'personal', confidence: 0.9 }).status, 'personal');
    assert.deepEqual(codes(verdictOf({ verdict: 'personal', confidence: 0.9 })), ['haiku_personal']);
    assert.equal(verdictOf({ verdict: 'uncertain', confidence: 0 }).status, 'needs_clarification');

    const noLlm = classifyCandidate(input({ relationModels: ['x_custom.region'] }));
    assert.equal(noLlm.status, 'needs_clarification');
    assert.deepEqual(noLlm.reasons, [{ code: 'unknown_model', models: ['x_custom.region'] }]);
  });

  it('a field without relation information follows its SOURCE verdict', () => {
    const text = input({ valueShape: 'text', fieldPath: 'job_title', scope: 'sale.order', relationModels: [] });
    const none = classifyCandidate(text);
    assert.equal(none.status, 'needs_clarification');
    assert.deepEqual(codes(none), ['no_relation_info']);

    const withVerdict = (verdict: ModelVerdictSummary) =>
      classifyCandidate({ ...text, modelVerdicts: new Map([['odoo_execute:sale.order', verdict]]) });
    const yes = withVerdict({ verdict: 'non-personal', confidence: 0.85 });
    assert.equal(yes.status, 'suggested');
    assert.deepEqual(yes.reasons[0], { code: 'haiku_non_personal', model: 'odoo_execute:sale.order', confidence: 0.85 });
    assert.equal(withVerdict({ verdict: 'personal', confidence: 0.9 }).status, 'personal');
    assert.equal(withVerdict({ verdict: 'non-personal', confidence: 0.5 }).status, 'needs_clarification');
  });

  it('a dataset column is judged by its source verdict, the detectors veto first', () => {
    const column = input({
      toolName: 'query_dataset',
      scope: DATASET,
      fieldPath: 'Abteilung',
      valueShape: 'text',
      relationModels: [],
      modelVerdicts: new Map([[`query_dataset:${DATASET}`, { verdict: 'non-personal', confidence: 0.9 }]]),
    });
    assert.equal(classifyCandidate(column).status, 'suggested');
    const vetoed = classifyCandidate({ ...column, sample: { ...CLEAN, c1: 'hit' } });
    assert.equal(vetoed.status, 'personal');
    assert.deepEqual(codes(vetoed), ['name_hit']);
  });

  it('confirmed by a scoped entry; a legacy entry adds legacy_entry', () => {
    const exact = classifyCandidate(
      input({ coverage: configCoverage('odoo_execute:hr.employee/department_id', key()) }),
    );
    assert.equal(exact.status, 'confirmed');
    assert.equal(codes(exact).includes('legacy_entry'), false);

    for (const entry of ['department_id', '*:department_id', 'odoo_execute:department_id']) {
      const legacy = classifyCandidate(input({ coverage: configCoverage(`a_id\n${entry}`, key()) }));
      assert.equal(legacy.status, 'confirmed', entry);
      assert.deepEqual(legacy.reasons.at(-1), { code: 'legacy_entry', entry }, entry);
    }
    // The scoped entry of another model does not cover it.
    assert.equal(configCoverage('odoo_execute:sale.order/department_id', key()).covered, false);
    assert.equal(configCoverage('odoo_other:department_id', key()).covered, false);
    assert.deepEqual(configCoverage('odoo_execute:hr.employee/department_id\n*:department_id', key()), {
      covered: true,
      exact: true,
      legacyEntry: '*:department_id',
    });
  });

  it('a decision holds until the fingerprint changes, then the field needs clarification again', () => {
    const fp = candidateFingerprint({ scope: 'hr.employee', relationModels: ['hr.department'], valueShape: 'm2o' });
    const kept = classifyCandidate(input({ decision: { action: 'keep_masked', fingerprint: fp } }));
    assert.equal(kept.status, 'kept_masked');
    assert.equal(kept.fingerprint, fp);
    const rejected = classifyCandidate(input({ decision: { action: 'reject', fingerprint: fp } }));
    assert.equal(rejected.status, 'rejected');

    const changed = classifyCandidate(
      input({
        relationModels: ['hr.department', 'hr.job'],
        decision: { action: 'reject', fingerprint: fp },
      }),
    );
    assert.equal(changed.status, 'needs_clarification');
    assert.equal(changed.reasons[0]?.code, 'changed_since_decision');
  });

  it('the fingerprint covers scope, relations and shape; ignores order and duplicates', () => {
    const a = candidateFingerprint({ scope: 's', relationModels: ['y', 'x'], valueShape: 'm2o' });
    const b = candidateFingerprint({ scope: 's', relationModels: ['x', 'y', 'x'], valueShape: 'm2o' });
    assert.equal(a, b);
    assert.notEqual(a, candidateFingerprint({ scope: 's', relationModels: ['x', 'y'], valueShape: 'text' }));
    assert.notEqual(a, candidateFingerprint({ scope: 't', relationModels: ['x', 'y'], valueShape: 'm2o' }));
  });
});

describe('field classification — config entry edits', () => {
  it('appends one scoped line, without duplicates; datasets use the dataset form', () => {
    assert.equal(appendConfigEntry(undefined, key({ fieldPath: 'job_id' })), 'odoo_execute:hr.employee/job_id');
    assert.equal(
      appendConfigEntry('*:a\n', key({ fieldPath: 'job_id' })),
      '*:a\nodoo_execute:hr.employee/job_id',
    );
    assert.equal(
      appendConfigEntry('odoo_execute:hr.employee/job_id', key({ fieldPath: 'job_id' })),
      'odoo_execute:hr.employee/job_id',
    );
    assert.equal(
      configEntryOf({ toolName: 'query_dataset', scope: DATASET, fieldPath: 'Abteilung Name' }),
      `dataset:${DATASET}/Abteilung Name`,
    );
    assert.equal(configEntryOf({ toolName: 'mcp_tool', scope: '-', fieldPath: 'category' }), 'mcp_tool:-/category');
  });

  it('removes exactly that scoped entry and keeps everything else as written', () => {
    const k = key({ fieldPath: 'job_id' });
    assert.equal(
      removeConfigEntry('*:job_id\nodoo_execute:hr.employee/job_id\nbad entry', k),
      '*:job_id\nbad entry',
    );
    assert.equal(
      removeConfigEntry('odoo_execute:hr.employee/job_id, odoo_execute:hr.employee/company_id', k),
      'odoo_execute:hr.employee/company_id',
    );
    assert.equal(removeConfigEntry('odoo_execute:sale.order/job_id', k), 'odoo_execute:sale.order/job_id');
    assert.equal(removeConfigEntry('odoo_execute:hr.employee/job_id', k), '');
  });

  it('lists legacy entries and replaces one by scoped entries, in place', () => {
    const raw = 'a_id\nodoo_execute:hr.employee/x_id\n*:job_id, b_id\na_id';
    assert.deepEqual(
      legacyEntries(raw).map((l) => l.entry),
      ['a_id', '*:job_id', 'b_id'],
    );
    assert.equal(
      replaceLegacyEntry(raw, '*:job_id', ['odoo_execute:hr.employee/job_id', 'odoo_execute:hr.job/job_id']),
      'a_id\nodoo_execute:hr.employee/x_id\nb_id\nodoo_execute:hr.employee/job_id\nodoo_execute:hr.job/job_id\na_id',
    );
    // Every occurrence goes, the replacement lands once; existing entries are not duplicated.
    assert.equal(
      replaceLegacyEntry(raw, 'a_id', ['odoo_execute:hr.employee/x_id', 'odoo_execute:sale.order/a_id']),
      'odoo_execute:sale.order/a_id\nodoo_execute:hr.employee/x_id\n*:job_id, b_id',
    );
    assert.equal(replaceLegacyEntry(raw, 'odoo_execute:hr.employee/x_id', []), undefined, 'not legacy');
    assert.equal(replaceLegacyEntry(raw, 'missing', []), undefined);
  });
});

// ---------------------------------------------------------------------------
// Recompute
// ---------------------------------------------------------------------------

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

interface Harness {
  readonly store: InMemoryFieldClassificationStore;
  readonly haikuCalls: ModelClassificationRequest[][];
  readonly vetCalls: string[];
  readonly odooCalls: string[];
  readonly configWrites: unknown[];
  run(config?: string): ReturnType<typeof recomputeFieldClassification>;
  queue(observations: FieldObservation[]): void;
}

function harness(opts: {
  readonly fields: Record<string, Record<string, { type: string; relation?: string; string?: string }>>;
  readonly samples?: Record<string, Partial<FieldSampleVerdict>>;
  readonly haiku?: (req: ModelClassificationRequest) => ModelClassificationResult;
}): Harness {
  const store = new InMemoryFieldClassificationStore();
  const haikuCalls: ModelClassificationRequest[][] = [];
  const vetCalls: string[] = [];
  const odooCalls: string[] = [];
  const configWrites: unknown[] = [];
  let pending: FieldObservation[] = [];
  const guard: Partial<PrivacyGuardService> = {
    takeFieldObservations: () => {
      const out = pending;
      pending = [];
      return out;
    },
    vetFieldSample: async ({ toolName, scope, fieldPath }) => {
      vetCalls.push(`${scope}/${fieldPath}`);
      return {
        toolName,
        scope,
        fieldPath,
        sampleCount: 5,
        identityHit: false,
        c1: 'clean',
        hitTypes: [],
        ...opts.samples?.[fieldPath],
      };
    },
    maskedFieldPreview: () => ['•••• & ••••'],
    ...(opts.haiku
      ? {
          classifyModelsSchemaOnly: async (requests: readonly ModelClassificationRequest[]) => {
            haikuCalls.push([...requests]);
            return requests.map(opts.haiku!);
          },
        }
      : {}),
  };
  const odoo = {
    execute: async (req: { model: string; method: string }) => {
      assert.equal(req.method, 'fields_get');
      odooCalls.push(req.model);
      return opts.fields[req.model] ?? {};
    },
  };
  const services: Record<string, unknown> = {
    [PRIVACY_REDACT_SERVICE_NAME]: guard,
    'odoo.client': odoo,
  };
  // A registry that WOULD let a writer change config — recompute must never
  // reach for it.
  const installedRegistry = {
    updateConfig: async (...args: unknown[]) => {
      configWrites.push(args);
    },
  };
  return {
    store,
    haikuCalls,
    vetCalls,
    odooCalls,
    configWrites,
    queue(observations) {
      pending = [...pending, ...observations];
    },
    run(config) {
      return recomputeFieldClassification({
        store,
        serviceRegistry: {
          get: <T,>(name: string) =>
            (name === 'installedRegistry' ? installedRegistry : services[name]) as T | undefined,
        },
        readNonPersonalFields: () => config,
        installedRegistry,
      } as RecomputeDeps);
    },
  };
}

const EMPLOYEE_FIELDS = {
  'hr.employee': {
    department_id: { type: 'many2one', relation: 'hr.department', string: 'Department' },
    parent_id: { type: 'many2one', relation: 'hr.employee', string: 'Manager' },
    address_id: { type: 'many2one', relation: 'res.partner', string: 'Work address' },
    region_id: { type: 'many2one', relation: 'x_custom.region', string: 'Region' },
    job_title: { type: 'char', string: 'Job title' },
  },
  'sale.order': {
    department_id: { type: 'many2one', relation: 'hr.department', string: 'Department' },
    note: { type: 'text', string: 'Terms' },
  },
};

const statusOf = async (store: InMemoryFieldClassificationStore, scope: string, path: string) =>
  (await store.list()).find((c) => c.scope === scope && c.fieldPath === path);

describe('field classification — recompute', () => {
  it('every tool is a candidate source except sub-agent and v4 verbs; no link keys, no mixed shapes', () => {
    assert.equal(isCandidateObservation(obs('department_id', 'hr.employee')), true);
    assert.equal(
      isCandidateObservation(obs('Abteilung Name', DATASET, { toolName: 'query_dataset', valueShape: 'text' })),
      true,
    );
    assert.equal(isCandidateObservation(obs('category', '-', { toolName: 'mcp_shop.list' })), true);
    assert.equal(isCandidateObservation(obs('partner_id', 'sale.order', { toolName: 'sub-agent' })), false);
    assert.equal(isCandidateObservation(obs('partner_id', '-', { toolName: 'v4_filter' })), false);
    assert.equal(isCandidateObservation(obs('__k_Name', '-')), false);
    assert.equal(isCandidateObservation(obs('rows.__k_Name', '-')), false);
    assert.equal(isCandidateObservation(obs('x', '-', { valueShape: 'mixed' })), false);
  });

  it('drops field paths, tool names and scopes that cannot form one scoped entry', () => {
    for (const path of ['x\n*:partner_id', 'x,partner_id', 'x;partner_id', 'a:b', 'a/b', ' x', '']) {
      assert.equal(isCandidateObservation(obs(path, 'hr.employee')), false, JSON.stringify(path));
    }
    for (const toolName of ['odoo_x\n*', 'odoo_x:y', 'odoo x', 'odoo_*', '*']) {
      assert.equal(isCandidateObservation(obs('department_id', '-', { toolName })), false, toolName);
    }
    for (const scope of ["x'; drop", 'Bad Model', 'res.partner\n*:x', '', 'a/b']) {
      assert.equal(isCandidateObservation(obs('department_id', scope)), false, scope);
    }
    assert.equal(isValidFieldIdentity(key({ toolName: 'odoo_Execute.v2-x' })), true);
  });

  it('resolves the relation with fields_get on the scope model only', async () => {
    const h = harness({ fields: EMPLOYEE_FIELDS });
    h.queue([obs('department_id', 'hr.employee'), obs('category', '-', { toolName: 'mcp_shop', valueShape: 'text' })]);
    await h.run();
    assert.deepEqual(h.odooCalls, ['hr.employee']);
    assert.deepEqual((await statusOf(h.store, 'hr.employee', 'department_id'))?.relationModels, ['hr.department']);
  });

  it('an unreadable scope model keeps the last relation; without one the field needs clarification', async () => {
    const fields: Record<string, unknown> = { 'x_custom.broken': 'not a schema' };
    const h = harness({ fields: fields as never });
    h.queue([obs('department_id', 'x_custom.broken')]);
    await h.run();
    const first = await statusOf(h.store, 'x_custom.broken', 'department_id');
    assert.deepEqual(first?.relationModels, []);
    assert.equal(first?.status, 'needs_clarification');
    assert.deepEqual(codes(first!), ['no_relation_info']);

    fields['x_custom.broken'] = { department_id: { type: 'many2one', relation: 'hr.department' } };
    await h.run();
    const second = await statusOf(h.store, 'x_custom.broken', 'department_id');
    assert.deepEqual(second?.relationModels, ['hr.department']);
    assert.equal(second?.status, 'suggested');
  });

  it('classifies Odoo fields, never sends a person model to the schema model, never writes config', async () => {
    const h = harness({
      fields: EMPLOYEE_FIELDS,
      haiku: (req) => ({ model: req.model, verdict: 'non-personal', confidence: 0.92, reason: 'regions' }),
    });
    h.queue([
      obs('department_id', 'hr.employee'),
      obs('parent_id', 'hr.employee'),
      obs('address_id', 'hr.employee'),
      obs('region_id', 'hr.employee'),
      obs('job_title', 'hr.employee', { valueShape: 'text' }),
      obs('partner_id', 'sale.order', { toolName: 'sub-agent' }),
    ]);
    const result = await h.run();
    assert.equal(result.candidates, 5);

    const byPath = new Map((await h.store.list()).map((c) => [c.fieldPath, c]));
    assert.equal(byPath.get('department_id')?.status, 'suggested');
    assert.equal(byPath.get('parent_id')?.status, 'personal');
    assert.equal(byPath.get('address_id')?.status, 'personal');
    assert.equal(byPath.get('region_id')?.status, 'suggested');
    // A text field of a person model is about that person — never asked.
    assert.equal(byPath.get('job_title')?.status, 'personal');
    assert.deepEqual(byPath.get('job_title')?.reasons, [{ code: 'person_model', models: ['hr.employee'] }]);
    assert.deepEqual(byPath.get('department_id')?.maskedPreview, ['•••• & ••••']);

    const asked = h.haikuCalls.flat().map((r) => r.model);
    assert.deepEqual(asked, ['x_custom.region']);
    for (const model of asked) assert.equal(PERSON_MODELS.has(model), false);
    assert.deepEqual(h.haikuCalls[0]?.[0]?.fields, [{ path: 'region_id', label: 'Region' }]);
    assert.deepEqual(h.configWrites, []);

    // Cached: a second pass does not ask again, and does not re-vet clean samples.
    const vetsBefore = h.vetCalls.length;
    await h.run();
    assert.equal(h.haikuCalls.length, 1);
    assert.equal(h.vetCalls.length, vetsBefore);
    assert.deepEqual(h.configWrites, []);
  });

  it('a generic source goes to the schema model once per source, schema only', async () => {
    const h = harness({
      fields: EMPLOYEE_FIELDS,
      haiku: (req) =>
        req.model === `query_dataset:${DATASET}`
          ? { model: req.model, verdict: 'non-personal', confidence: 0.9, reason: 'org data' }
          : { model: req.model, verdict: 'personal', confidence: 0.9, reason: 'customers' },
    });
    h.queue([
      obs('Abteilung', DATASET, { toolName: 'query_dataset', valueShape: 'text', label: 'Abteilung' }),
      obs('Standort', DATASET, { toolName: 'query_dataset', valueShape: 'text' }),
      obs('customer', '-', { toolName: 'mcp_shop', valueShape: 'text' }),
      obs('note', 'sale.order', { valueShape: 'text' }),
    ]);
    await h.run();
    const requests = h.haikuCalls.flat();
    assert.equal(h.haikuCalls.length, 1, 'one call for all requests');
    assert.deepEqual(
      requests.map((r) => r.model).sort(),
      ['mcp_shop:-', 'odoo_execute:sale.order', `query_dataset:${DATASET}`],
    );
    assert.deepEqual(requests.find((r) => r.model === `query_dataset:${DATASET}`)?.fields, [
      { path: 'Abteilung', label: 'Abteilung' },
      { path: 'Standort' },
    ]);
    assert.deepEqual(requests.find((r) => r.model === 'odoo_execute:sale.order')?.fields, [
      { path: 'note', label: 'Terms' },
    ]);
    // Schema only: no request carries a sampled value.
    assert.equal(JSON.stringify(requests).includes('••'), false);

    assert.equal((await statusOf(h.store, DATASET, 'Abteilung'))?.status, 'suggested');
    assert.equal((await statusOf(h.store, DATASET, 'Standort'))?.status, 'suggested');
    assert.equal((await statusOf(h.store, '-', 'customer'))?.status, 'personal');

    // Cached per source; a new field of the source re-asks only that source.
    await h.run();
    assert.equal(h.haikuCalls.length, 1);
    h.queue([obs('Kostenstelle', DATASET, { toolName: 'query_dataset', valueShape: 'text' })]);
    await h.run();
    assert.equal(h.haikuCalls.length, 2);
    assert.deepEqual(h.haikuCalls[1]?.map((r) => r.model), [`query_dataset:${DATASET}`]);
  });

  it('a source whose field set changed and gets no fresh answer does not keep its old verdict', async () => {
    let answer = true;
    const h = harness({
      fields: {},
      haiku: (req) => ({
        model: answer ? req.model : 'something-else',
        verdict: 'non-personal',
        confidence: 0.9,
        reason: '',
      }),
    });
    h.queue([obs('category', '-', { toolName: 'mcp_shop', valueShape: 'text' })]);
    await h.run();
    assert.equal((await statusOf(h.store, '-', 'category'))?.status, 'suggested');
    answer = false;
    h.queue([obs('buyer', '-', { toolName: 'mcp_shop', valueShape: 'text' })]);
    await h.run();
    assert.equal((await statusOf(h.store, '-', 'buyer'))?.status, 'needs_clarification');
    assert.equal((await statusOf(h.store, '-', 'category'))?.status, 'needs_clarification');
  });

  it('a scoped entry confirms only its model; a legacy entry confirms every model', async () => {
    const h = harness({ fields: EMPLOYEE_FIELDS });
    h.queue([obs('department_id', 'hr.employee'), obs('department_id', 'sale.order')]);
    await h.run('odoo_execute:hr.employee/department_id');
    assert.equal((await statusOf(h.store, 'hr.employee', 'department_id'))?.status, 'confirmed');
    assert.equal((await statusOf(h.store, 'sale.order', 'department_id'))?.status, 'suggested');

    await h.run('odoo_execute:department_id');
    for (const scope of ['hr.employee', 'sale.order']) {
      const c = await statusOf(h.store, scope, 'department_id');
      assert.equal(c?.status, 'confirmed', scope);
      assert.deepEqual(c?.reasons.at(-1), { code: 'legacy_entry', entry: 'odoo_execute:department_id' });
    }
    await h.run(undefined);
    assert.equal((await statusOf(h.store, 'hr.employee', 'department_id'))?.status, 'suggested');
    assert.deepEqual(h.configWrites, []);
  });

  it('drift is per scope: a changed relation flags only that scope as a conflict', async () => {
    const fields = structuredClone(EMPLOYEE_FIELDS) as Record<string, Record<string, { type: string; relation?: string }>>;
    const h = harness({ fields });
    h.queue([obs('department_id', 'hr.employee'), obs('department_id', 'sale.order')]);
    const config = 'odoo_execute:hr.employee/department_id\nodoo_execute:sale.order/department_id';
    await h.run(config);
    for (const c of await h.store.list()) {
      await h.store.saveDecision(
        c.id,
        { action: 'confirm', fingerprint: c.fingerprint, byId: null, byEmail: 'a@x', at: '2026-10-30T10:00:00.000Z' },
        'confirmed',
      );
    }
    fields['sale.order']!['department_id'] = { type: 'many2one', relation: 'x_custom.team' };
    await h.run(config);
    assert.equal((await statusOf(h.store, 'hr.employee', 'department_id'))?.status, 'confirmed');
    const drifted = await statusOf(h.store, 'sale.order', 'department_id');
    assert.equal(drifted?.status, 'confirmed_conflict');
    assert.equal(drifted?.reasons[0]?.code, 'confirmed_conflict');
  });

  it('a detector hit makes a known non-personal field personal', async () => {
    const h = harness({
      fields: EMPLOYEE_FIELDS,
      samples: { department_id: { c1: 'hit', hitTypes: ['person'] } },
    });
    h.queue([obs('department_id', 'hr.employee')]);
    await h.run();
    assert.equal((await h.store.list())[0]?.status, 'personal');
  });

  it('without the name detector a known non-personal field needs clarification', async () => {
    const h = harness({ fields: EMPLOYEE_FIELDS, samples: { department_id: { c1: 'unavailable' } } });
    h.queue([obs('department_id', 'hr.employee')]);
    await h.run();
    const [c] = await h.store.list();
    assert.equal(c?.status, 'needs_clarification');
    assert.deepEqual(codes(c!), ['known_non_personal', 'name_detector_unavailable']);
  });

  it('without the schema model an unknown target needs clarification', async () => {
    const h = harness({ fields: EMPLOYEE_FIELDS });
    h.queue([obs('region_id', 'hr.employee')]);
    await h.run();
    const [c] = await h.store.list();
    assert.equal(c?.status, 'needs_clarification');
    assert.deepEqual(c?.reasons, [{ code: 'unknown_model', models: ['x_custom.region'] }]);
  });

  it('an uncertain schema verdict needs clarification and is asked again next pass', async () => {
    const h = harness({
      fields: EMPLOYEE_FIELDS,
      haiku: (req) => ({ model: req.model, verdict: 'uncertain', confidence: 0, reason: '' }),
    });
    h.queue([obs('region_id', 'hr.employee')]);
    await h.run();
    assert.equal((await h.store.list())[0]?.status, 'needs_clarification');
    await h.run();
    assert.equal(h.haikuCalls.length, 2);
  });
});

describe('field classification — scheduler', () => {
  it('debounces triggers and runs single-flight', async () => {
    let runs = 0;
    let release: (() => void) | undefined;
    const scheduler = createFieldClassificationScheduler({
      debounceMs: 10,
      run: async () => {
        runs += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { computedAt: new Date().toISOString(), candidates: 0, observations: 0 };
      },
    });
    scheduler.trigger('a');
    scheduler.trigger('b');
    scheduler.trigger('c');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(runs, 1);
    const joined = scheduler.runNow();
    release?.();
    await new Promise((r) => setTimeout(r, 5));
    release?.();
    await joined;
    assert.equal(runs, 2, 'a run requested mid-flight runs once more afterwards');
    scheduler.stop();
  });
});

describe('field classification — security review fixes', () => {
  it('M2: a field without relation info read from a person model is personal', () => {
    const name = classifyCandidate(
      input({ fieldPath: 'name', valueShape: 'text', scope: 'res.partner', relationModels: [] }),
    );
    assert.equal(name.status, 'personal');
    assert.deepEqual(name.reasons, [{ code: 'person_model', models: ['res.partner'] }]);

    // Even a confident source verdict does not clear a person model's text.
    const confident = classifyCandidate(
      input({
        fieldPath: 'name',
        valueShape: 'text',
        scope: 'res.partner',
        relationModels: [],
        modelVerdicts: new Map([['odoo_execute:res.partner', { verdict: 'non-personal', confidence: 0.99 }]]),
      }),
    );
    assert.equal(confident.status, 'personal');

    // A resolved non-person relation wins over the person SCOPE model.
    assert.equal(classifyCandidate(input({})).status, 'suggested');
  });

  describe('H1: confirmed_conflict', () => {
    const covered = configCoverage('odoo_execute:hr.employee/x_id', key({ fieldPath: 'x_id' }));
    const personal = { fieldPath: 'x_id', relationModels: ['res.partner'], coverage: covered };
    const personalFp = candidateFingerprint({ scope: 'hr.employee', relationModels: ['res.partner'], valueShape: 'm2o' });

    it('a covered field whose base status is personal is a conflict', () => {
      const r = classifyCandidate(input(personal));
      assert.equal(r.status, 'confirmed_conflict');
      assert.deepEqual(codes(r), ['confirmed_conflict', 'person_model']);
    });

    it('a covered field whose fingerprint changed since the confirm is a conflict', () => {
      const r = classifyCandidate(
        input({
          coverage: configCoverage('odoo_execute:hr.employee/department_id', key()),
          decision: { action: 'confirm', fingerprint: 'an-older-fingerprint' },
        }),
      );
      assert.equal(r.status, 'confirmed_conflict');
      assert.equal(r.reasons[0]?.code, 'confirmed_conflict');
    });

    it('an acknowledged conflict (confirm on the current fingerprint) stays confirmed, reason kept', () => {
      const r = classifyCandidate(input({ ...personal, decision: { action: 'confirm', fingerprint: personalFp } }));
      assert.equal(r.status, 'confirmed');
      assert.deepEqual(r.reasons, [{ code: 'person_model', models: ['res.partner'] }]);
    });

    it('a legacy entry covering a person field is a conflict too', () => {
      const r = classifyCandidate(
        input({ ...personal, coverage: configCoverage('*:x_id', key({ fieldPath: 'x_id' })) }),
      );
      assert.equal(r.status, 'confirmed_conflict');
      assert.deepEqual(codes(r), ['confirmed_conflict', 'person_model', 'legacy_entry']);
    });

    it('a covered non-personal field without a confirm decision stays confirmed', () => {
      const r = classifyCandidate(input({ coverage: configCoverage('odoo_execute:hr.employee/department_id', key()) }));
      assert.equal(r.status, 'confirmed');
    });
  });

  describe('H2: config entries are exactly one scoped entry', () => {
    const injected = ['x\n*:partner_id', 'x,partner_id', 'x;partner_id', 'a:b', 'a/b', ' a', ''];

    it('configEntryOf and appendConfigEntry refuse paths that would add other entries', () => {
      for (const path of injected) {
        const k = key({ fieldPath: path });
        assert.throws(() => configEntryOf(k), InvalidFieldEntryError, JSON.stringify(path));
        assert.throws(
          () => appendConfigEntry('odoo_execute:hr.employee/job_id', k),
          InvalidFieldEntryError,
          JSON.stringify(path),
        );
        assert.equal(isValidFieldIdentity(k), false, JSON.stringify(path));
      }
      assert.throws(() => configEntryOf(key({ toolName: '*' })), InvalidFieldEntryError);
      assert.throws(() => configEntryOf(key({ toolName: 'odoo:x' })), InvalidFieldEntryError);
      assert.throws(() => configEntryOf(key({ scope: 'Bad Scope' })), InvalidFieldEntryError);
      assert.equal(configEntryOf(key({ fieldPath: 'job_id' })), 'odoo_execute:hr.employee/job_id');
    });

    it('link keys are never an entry', () => {
      assert.equal(isValidFieldIdentity(key({ fieldPath: '__k_name' })), false);
    });
  });
});
