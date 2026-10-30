/**
 * #1556 follow-up — field classification: the pure classifier, the config
 * helpers, and the recompute pass end to end against an in-memory store, a
 * stub privacy guard and a stub Odoo client.
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
  removeConfigEntry,
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

function input(over: Partial<ClassifyInput>): ClassifyInput {
  return {
    toolName: 'odoo_execute',
    fieldPath: 'department_id',
    valueShape: 'm2o',
    sourceModels: ['hr.employee'],
    relationModels: ['hr.department'],
    sample: CLEAN,
    ...over,
  };
}

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

  it('says so when the name detector could not vet the sample', () => {
    const r = classifyCandidate(input({ sample: { ...CLEAN, c1: 'unavailable' } }));
    assert.equal(r.status, 'suggested');
    assert.deepEqual(codes(r), ['known_non_personal', 'name_detector_unavailable']);
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

  it('a field without relation information needs clarification', () => {
    const r = classifyCandidate(
      input({ valueShape: 'text', fieldPath: 'job_title', sourceModels: ['sale.order'], relationModels: [] }),
    );
    assert.equal(r.status, 'needs_clarification');
    assert.deepEqual(codes(r), ['no_relation_info']);
  });

  it('is confirmed when the setting covers it, with wildcard_entry for a * entry only', () => {
    const exact = classifyCandidate(
      input({ coverage: configCoverage('odoo_execute:department_id', 'odoo_execute', 'department_id') }),
    );
    assert.equal(exact.status, 'confirmed');
    assert.equal(codes(exact).includes('wildcard_entry'), false);

    const bare = classifyCandidate(
      input({ coverage: configCoverage('department_id', 'odoo_execute', 'department_id') }),
    );
    assert.equal(bare.status, 'confirmed');
    assert.deepEqual(bare.reasons.at(-1), { code: 'wildcard_entry', entry: 'department_id' });

    const star = configCoverage('a_id\n*:department_id', 'odoo_execute', 'department_id');
    assert.deepEqual(star, { covered: true, exact: false, wildcardEntry: '*:department_id' });
    assert.equal(configCoverage('odoo_other:department_id', 'odoo_execute', 'department_id').covered, false);
  });

  it('a decision holds until the fingerprint changes, then the field needs clarification again', () => {
    const fp = candidateFingerprint({
      sourceModels: ['hr.employee'],
      relationModels: ['hr.department'],
      valueShape: 'm2o',
    });
    const kept = classifyCandidate(input({ decision: { action: 'keep_masked', fingerprint: fp } }));
    assert.equal(kept.status, 'kept_masked');
    assert.equal(kept.fingerprint, fp);
    const rejected = classifyCandidate(input({ decision: { action: 'reject', fingerprint: fp } }));
    assert.equal(rejected.status, 'rejected');

    const changed = classifyCandidate(
      input({
        sourceModels: ['hr.employee', 'hr.applicant.public'],
        decision: { action: 'reject', fingerprint: fp },
      }),
    );
    assert.equal(changed.status, 'needs_clarification');
    assert.equal(changed.reasons[0]?.code, 'changed_since_decision');
  });

  it('the fingerprint ignores order and duplicates', () => {
    const a = candidateFingerprint({ sourceModels: ['b', 'a'], relationModels: ['x'], valueShape: 'm2o' });
    const b = candidateFingerprint({ sourceModels: ['a', 'b', 'a'], relationModels: ['x'], valueShape: 'm2o' });
    assert.equal(a, b);
    assert.notEqual(a, candidateFingerprint({ sourceModels: ['a', 'b'], relationModels: ['x'], valueShape: 'text' }));
  });
});

describe('field classification — config entry edits', () => {
  it('appends one tool:field line, without duplicates', () => {
    assert.equal(appendConfigEntry(undefined, 'odoo_execute', 'job_id'), 'odoo_execute:job_id');
    assert.equal(appendConfigEntry('*:a\n', 'odoo_execute', 'job_id'), '*:a\nodoo_execute:job_id');
    assert.equal(appendConfigEntry('odoo_execute:job_id', 'odoo_execute', 'job_id'), 'odoo_execute:job_id');
  });

  it('removes exactly that entry and keeps everything else as written', () => {
    assert.equal(
      removeConfigEntry('*:job_id\nodoo_execute:job_id\nbad entry', 'odoo_execute', 'job_id'),
      '*:job_id\nbad entry',
    );
    assert.equal(
      removeConfigEntry('odoo_execute:job_id, odoo_execute:company_id', 'odoo_execute', 'job_id'),
      'odoo_execute:company_id',
    );
    assert.equal(removeConfigEntry('odoo_execute:job_id', 'odoo_execute', 'job_id'), '');
  });
});

// ---------------------------------------------------------------------------
// Recompute
// ---------------------------------------------------------------------------

function obs(fieldPath: string, sourceModels: string[], over: Partial<FieldObservation> = {}): FieldObservation {
  return {
    toolName: 'odoo_execute',
    fieldPath,
    valueShape: 'm2o',
    sourceModels,
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
  const configWrites: unknown[] = [];
  let pending: FieldObservation[] = [];
  const guard: Partial<PrivacyGuardService> = {
    takeFieldObservations: () => {
      const out = pending;
      pending = [];
      return out;
    },
    vetFieldSample: async ({ toolName, fieldPath }) => {
      vetCalls.push(fieldPath);
      return {
        toolName,
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
    configWrites,
    queue(observations) {
      pending = [...pending, ...observations];
    },
    run(config) {
      // The deps carry a writer-capable registry (also as a service) on
      // purpose: the pass must leave it untouched.
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
};

describe('field classification — recompute', () => {
  it('only odoo_* tools, no link keys and no mixed shapes become candidates', () => {
    assert.equal(isCandidateObservation(obs('department_id', [])), true);
    assert.equal(isCandidateObservation(obs('department_id', [], { toolName: 'query_dataset' })), false);
    assert.equal(isCandidateObservation(obs('__k_Name', [])), false);
    assert.equal(isCandidateObservation(obs('rows.__k_Name', [])), false);
    assert.equal(isCandidateObservation(obs('x', [], { valueShape: 'mixed' })), false);
  });

  it('drops field paths, tool names and source models outside the Odoo grammar', () => {
    for (const path of ['x\n*:partner_id', 'x,partner_id', 'x;partner_id', 'a b', '*', 'a:b', 'Name', 'a.b', '1x', '']) {
      assert.equal(isCandidateObservation(obs(path, ['hr.department'])), false, JSON.stringify(path));
    }
    for (const toolName of ['odoo_x\n*', 'odoo_x:y', 'odoo x', 'odoo_*']) {
      assert.equal(isCandidateObservation(obs('department_id', [], { toolName })), false, toolName);
    }
    assert.equal(isCandidateObservation(obs('department_id', [], { toolName: 'odoo_Execute.v2-x' })), true);
    for (const model of ["x'; drop", 'Bad Model', 'res.partner\n*:x', '']) {
      assert.equal(isCandidateObservation(obs('department_id', ['hr.employee', model])), false, model);
    }
  });

  it('one unreadable source model makes the relation unknown, not a partial answer (M1)', async () => {
    const fields: Record<string, unknown> = {
      'sale.order': { department_id: { type: 'many2one', relation: 'hr.department' } },
      'x_custom.broken': 'not a schema',
    };
    const h = harness({ fields: fields as never });
    h.queue([obs('department_id', ['sale.order', 'x_custom.broken'])]);
    await h.run();
    const [first] = await h.store.list();
    assert.deepEqual(first?.relationModels, [], 'the partial answer is not taken');
    assert.equal(first?.status, 'needs_clarification');
    assert.deepEqual(codes(first!), ['no_relation_info']);

    fields['x_custom.broken'] = {};
    await h.run();
    const [second] = await h.store.list();
    assert.deepEqual(second?.relationModels, ['hr.department']);
    assert.equal(second?.status, 'suggested');
  });

  it('classifies, never sends a person model to the schema model, never writes config', async () => {
    const h = harness({
      fields: EMPLOYEE_FIELDS,
      haiku: (req) => ({ model: req.model, verdict: 'non-personal', confidence: 0.92, reason: 'regions' }),
    });
    h.queue([
      obs('department_id', ['hr.employee']),
      obs('parent_id', ['hr.employee']),
      obs('address_id', ['hr.employee']),
      obs('region_id', ['hr.employee']),
      obs('job_title', ['hr.employee'], { valueShape: 'text' }),
      obs('partner_id', ['sale.order'], { toolName: 'sub-agent' }),
    ]);
    const result = await h.run();
    assert.equal(result.candidates, 5);

    const byPath = new Map((await h.store.list()).map((c) => [c.fieldPath, c]));
    assert.equal(byPath.get('department_id')?.status, 'suggested');
    assert.equal(byPath.get('parent_id')?.status, 'personal');
    assert.equal(byPath.get('address_id')?.status, 'personal');
    assert.equal(byPath.get('region_id')?.status, 'suggested');
    // A text field of a person model is about that person.
    assert.equal(byPath.get('job_title')?.status, 'personal');
    assert.deepEqual(byPath.get('job_title')?.reasons, [{ code: 'person_model', models: ['hr.employee'] }]);
    assert.deepEqual(byPath.get('department_id')?.relationModels, ['hr.department']);
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

  it('marks a field confirmed only from the existing setting, never by itself', async () => {
    const h = harness({ fields: EMPLOYEE_FIELDS });
    h.queue([obs('department_id', ['hr.employee'])]);
    await h.run('odoo_execute:department_id');
    assert.equal((await h.store.list())[0]?.status, 'confirmed');
    await h.run(undefined);
    assert.equal((await h.store.list())[0]?.status, 'suggested');
    assert.deepEqual(h.configWrites, []);
  });

  it('a detector hit makes a known non-personal field personal', async () => {
    const h = harness({
      fields: EMPLOYEE_FIELDS,
      samples: { department_id: { c1: 'hit', hitTypes: ['person'] } },
    });
    h.queue([obs('department_id', ['hr.employee'])]);
    await h.run();
    assert.equal((await h.store.list())[0]?.status, 'personal');
  });

  it('without the schema model an unknown target needs clarification', async () => {
    const h = harness({ fields: EMPLOYEE_FIELDS });
    h.queue([obs('region_id', ['hr.employee'])]);
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
    h.queue([obs('region_id', ['hr.employee'])]);
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
      input({ fieldPath: 'name', valueShape: 'text', sourceModels: ['res.partner'], relationModels: [] }),
    );
    assert.equal(name.status, 'personal');
    assert.deepEqual(name.reasons, [{ code: 'person_model', models: ['res.partner'] }]);

    const value = classifyCandidate(
      input({
        fieldPath: 'value',
        valueShape: 'text',
        sourceModels: ['sale.order', 'hr.employee'],
        relationModels: [],
      }),
    );
    assert.equal(value.status, 'personal');
    assert.deepEqual(value.reasons, [{ code: 'person_model', models: ['hr.employee'] }]);

    // A resolved non-person relation wins over the person SOURCE model.
    const dept = classifyCandidate(input({ sourceModels: ['hr.employee'], relationModels: ['hr.department'] }));
    assert.equal(dept.status, 'suggested');
  });

  describe('H1: confirmed_conflict', () => {
    const covered = configCoverage('odoo_execute:x_id', 'odoo_execute', 'x_id');
    const personal = { fieldPath: 'x_id', relationModels: ['res.partner'], coverage: covered };
    const personalFp = candidateFingerprint({
      sourceModels: ['hr.employee'],
      relationModels: ['res.partner'],
      valueShape: 'm2o',
    });

    it('a covered field whose base status is personal is a conflict', () => {
      const r = classifyCandidate(input(personal));
      assert.equal(r.status, 'confirmed_conflict');
      assert.deepEqual(codes(r), ['confirmed_conflict', 'person_model']);
    });

    it('a covered field whose fingerprint changed since the confirm is a conflict', () => {
      const r = classifyCandidate(
        input({
          coverage: configCoverage('odoo_execute:department_id', 'odoo_execute', 'department_id'),
          decision: { action: 'confirm', fingerprint: 'an-older-fingerprint' },
        }),
      );
      assert.equal(r.status, 'confirmed_conflict');
      assert.equal(r.reasons[0]?.code, 'confirmed_conflict');
    });

    it('an acknowledged conflict (confirm on the current fingerprint) stays confirmed, reason kept', () => {
      const r = classifyCandidate(
        input({ ...personal, decision: { action: 'confirm', fingerprint: personalFp } }),
      );
      assert.equal(r.status, 'confirmed');
      assert.deepEqual(r.reasons, [{ code: 'person_model', models: ['res.partner'] }]);
    });

    it('a wildcard entry covering a person field is a conflict too', () => {
      const r = classifyCandidate(
        input({ ...personal, coverage: configCoverage('*:x_id', 'odoo_execute', 'x_id') }),
      );
      assert.equal(r.status, 'confirmed_conflict');
      assert.deepEqual(codes(r), ['confirmed_conflict', 'person_model', 'wildcard_entry']);
    });

    it('a covered non-personal field without a confirm decision stays confirmed', () => {
      const r = classifyCandidate(
        input({ coverage: configCoverage('odoo_execute:department_id', 'odoo_execute', 'department_id') }),
      );
      assert.equal(r.status, 'confirmed');
    });
  });

  describe('H2: config entries are exactly one tool:field', () => {
    const injected = ['x\n*:partner_id', 'x,partner_id', 'x;partner_id', 'a b', '*', 'a:b', ''];

    it('configEntryOf and appendConfigEntry refuse paths that would add other entries', () => {
      for (const path of injected) {
        assert.throws(() => configEntryOf('odoo_execute', path), InvalidFieldEntryError, JSON.stringify(path));
        assert.throws(
          () => appendConfigEntry('odoo_execute:job_id', 'odoo_execute', path),
          InvalidFieldEntryError,
          JSON.stringify(path),
        );
        assert.equal(isValidFieldIdentity('odoo_execute', path), false, JSON.stringify(path));
      }
      assert.throws(() => configEntryOf('*', 'partner_id'), InvalidFieldEntryError);
      assert.throws(() => configEntryOf('odoo:x', 'partner_id'), InvalidFieldEntryError);
      assert.equal(configEntryOf('odoo_execute', 'job_id'), 'odoo_execute:job_id');
      assert.equal(isValidFieldIdentity('odoo_execute', 'job_id'), true);
    });

    it('the grammar also refuses names the parser would accept', () => {
      assert.equal(isValidFieldIdentity('odoo_execute', 'Name'), false);
      assert.equal(isValidFieldIdentity('odoo_execute', 'a.b'), false);
      assert.equal(isValidFieldIdentity('odoo_execute', '__k_name'), false, 'the parser refuses link keys');
    });
  });
});
