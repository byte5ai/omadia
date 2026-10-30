/**
 * #1556 follow-up — the privacy guard's half of field classification:
 * schema-only observations of masked Odoo fields, a bounded value sample per
 * field vetted by the guard's own detectors, schema-only model
 * classification and the shape-masked preview. No value may ever leave
 * except as a detector verdict or a shape-masked preview.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { PromptPiiDetector, PromptPiiSpan } from '@omadia/plugin-api';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';
import {
  MAX_SAMPLE_VALUES,
  SAMPLE_TTL_MS,
  createFieldObservationRecorder,
} from '@omadia/plugin-privacy-guard/dist/fieldObservations.js';
import { maskedPreview, shapeMask } from '@omadia/plugin-privacy-guard/dist/fieldVetting.js';
import {
  MODELS_PER_CALL,
  classifyModelsSchemaOnly,
} from '@omadia/plugin-privacy-guard/dist/v4/modelClassifier.js';
import { buildDigest } from '@omadia/plugin-privacy-guard/dist/v4/digest.js';
import { createDatasetStore } from '@omadia/plugin-privacy-guard/dist/v4/datasetStore.js';
import { createShapeClassifier } from '@omadia/plugin-privacy-guard/dist/v4/shapeClassifier.js';

const RND = 'Research & Development';
const NAMES = ['Paul Williams', 'Beth Evans', 'Anna Rüsche', 'Thomas Görres'];
const EMPLOYEES = [
  { id: 1, name: NAMES[0], department_id: [4, RND], ref: 'X-1', __k_name: 'h1' },
  { id: 2, name: NAMES[1], department_id: [5, 'Sales Team'], ref: 7, __k_name: 'h2' },
  { id: 3, name: NAMES[2], department_id: [6, 'Management'], ref: 'X-3', __k_name: 'h3' },
  { id: 4, name: NAMES[3], department_id: false, ref: 'X-4', __k_name: 'h4' },
];
const SAMPLE_VALUES = [...NAMES, RND, 'Sales Team', 'Management'];

let turnSeq = 0;
async function intern(
  svc: ReturnType<typeof createPrivacyGuardService>,
  toolName: string,
  raw: unknown,
  toolInput?: unknown,
): Promise<void> {
  turnSeq += 1;
  await svc.internToolResultV4({
    sessionId: 's',
    turnId: `t-fc-${String(turnSeq)}`,
    toolName,
    rawResult: JSON.stringify(raw),
    ...(toolInput !== undefined ? { toolInput } : {}),
  });
}

function span(type: string, confidence: number): PromptPiiSpan {
  return { start: 0, end: 1, type, confidence };
}

function fakeC1(spans: readonly PromptPiiSpan[] | Error): PromptPiiDetector {
  return {
    id: 'c1-fake',
    detect: async () => {
      if (spans instanceof Error) throw spans;
      return spans;
    },
  };
}

describe('#1556 follow-up — field observations', () => {
  it('records masked m2o/text fields of odoo tools, schema only', async () => {
    const svc = createPrivacyGuardService();
    await intern(svc, 'odoo_execute', EMPLOYEES, { model: 'hr.employee', method: 'search_read' });
    await intern(svc, 'odoo_execute', EMPLOYEES, { model: 'hr.employee' });
    const obs = svc.takeFieldObservations!();
    const byPath = new Map(obs.map((o) => [o.fieldPath, o]));
    assert.equal(byPath.get('department_id')?.valueShape, 'm2o');
    assert.equal(byPath.get('name')?.valueShape, 'text');
    assert.deepEqual(byPath.get('department_id')?.sourceModels, ['hr.employee']);
    assert.equal(byPath.get('department_id')?.seenCount, 2);
    assert.equal(byPath.get('department_id')?.toolName, 'odoo_execute');
    assert.ok(byPath.get('department_id')!.firstSeenAt <= byPath.get('department_id')!.lastSeenAt);
    // __k_ link keys, mixed shapes and cleartext fields are never candidates.
    assert.ok(!byPath.has('__k_name'), 'link key observed');
    assert.ok(!byPath.has('ref'), 'mixed shape observed');
    assert.ok(!byPath.has('id'), 'cleartext id observed');
    const text = JSON.stringify(obs);
    for (const v of SAMPLE_VALUES) assert.ok(!text.includes(v), `value leaked: ${v}`);
    assert.deepEqual(svc.takeFieldObservations!(), [], 'take() drains');
  });

  it('reads the source model from an envelope', async () => {
    const svc = createPrivacyGuardService();
    await intern(svc, 'odoo_query', {
      model: 'hr.employee',
      count: 4,
      truncated: false,
      records: EMPLOYEES,
    });
    const dept = svc.takeFieldObservations!().find((o) => o.fieldPath === 'department_id');
    assert.deepEqual(dept?.sourceModels, ['hr.employee']);
    assert.equal(dept?.toolName, 'odoo_query');
  });

  it('ignores non-odoo tools, sub-agent narration and canvas producers', async () => {
    const svc = createPrivacyGuardService();
    await intern(svc, 'hr_export', EMPLOYEES);
    await intern(svc, 'query_dataset', EMPLOYEES);
    await intern(svc, 'canvas_publish_rows', EMPLOYEES);
    await svc.subAgentResultV4({
      sessionId: 's',
      turnId: 't-fc-sub',
      datasetIds: [],
      narration: JSON.stringify(EMPLOYEES),
    } as Parameters<NonNullable<typeof svc.subAgentResultV4>>[0]);
    assert.deepEqual(svc.takeFieldObservations!(), []);
    assert.deepEqual(svc.maskedFieldPreview!({ toolName: 'hr_export', fieldPath: 'name' }), []);
  });

  it('skips a field an operator rule already cleared as a label', async () => {
    const svc = createPrivacyGuardService({
      readConfig: (key) => (key === 'non_personal_fields' ? 'odoo_execute:department_id' : undefined),
    });
    await intern(svc, 'odoo_execute', EMPLOYEES, { model: 'hr.employee' });
    const paths = svc.takeFieldObservations!().map((o) => o.fieldPath);
    assert.ok(!paths.includes('department_id'));
    assert.ok(paths.includes('name'));
  });
});

describe('#1556 follow-up — value sample buffer', () => {
  function dataset(rows: readonly Record<string, unknown>[], toolName = 'odoo_execute') {
    const store = createDatasetStore({ classify: createShapeClassifier({}), buildDigest, turnId: 't' });
    const { datasetId } = store.internToolResult(toolName, rows);
    return store.get(datasetId)!;
  }

  it('keeps at most MAX_SAMPLE_VALUES distinct values per field', () => {
    const rec = createFieldObservationRecorder();
    const rows = Array.from({ length: MAX_SAMPLE_VALUES + 30 }, (_, i) => ({
      id: i,
      name: `Person Number ${String(i)}`,
    }));
    rec.record('odoo_execute', dataset(rows), new Set());
    rec.record('odoo_execute', dataset(rows), new Set());
    const sample = rec.sample({ toolName: 'odoo_execute', fieldPath: 'name' });
    assert.equal(sample.length, MAX_SAMPLE_VALUES);
    assert.equal(new Set(sample).size, sample.length);
  });

  it('drops values older than the TTL', () => {
    let clock = 1_000_000;
    const rec = createFieldObservationRecorder({ now: () => clock });
    rec.record('odoo_execute', dataset(EMPLOYEES), new Set());
    const key = { toolName: 'odoo_execute', fieldPath: 'name' };
    assert.equal(rec.sample(key).length, 4);
    clock += SAMPLE_TTL_MS + 1;
    assert.deepEqual(rec.sample(key), []);
  });

  it('vetting clears the sample', async () => {
    const svc = createPrivacyGuardService();
    await intern(svc, 'odoo_execute', EMPLOYEES, { model: 'hr.employee' });
    const field = { toolName: 'odoo_execute', fieldPath: 'department_id' };
    assert.equal(svc.maskedFieldPreview!({ ...field, limit: 10 }).length, 3);
    const verdict = await svc.vetFieldSample!(field);
    assert.equal(verdict.sampleCount, 3);
    assert.deepEqual(svc.maskedFieldPreview!(field), []);
    const again = await svc.vetFieldSample!(field);
    assert.equal(again.sampleCount, 0);
    for (const v of SAMPLE_VALUES) assert.ok(!JSON.stringify(verdict).includes(v));
  });
});

describe('#1556 follow-up — vetFieldSample', () => {
  const field = { toolName: 'odoo_execute', fieldPath: 'department_id' };

  it('an e-mail in a label is an identity hit', async () => {
    const svc = createPrivacyGuardService();
    await intern(svc, 'odoo_execute', [
      { id: 1, department_id: [1, 'Sales'] },
      { id: 2, department_id: [2, 'ops lead jonas.weber@example.com'] },
      { id: 3, department_id: [3, 'Finance'] },
    ]);
    const v = await svc.vetFieldSample!(field);
    assert.equal(v.identityHit, true);
    assert.deepEqual(v.hitTypes, ['email']);
    assert.equal(v.c1, 'unavailable', 'no C1 configured');
  });

  it('a deny-list term is an identity hit', async () => {
    const svc = createPrivacyGuardService({
      readConfig: (key) => (key === 'custom_terms' ? 'Projekt Falke' : undefined),
    });
    await intern(svc, 'odoo_execute', [
      { id: 1, department_id: [1, 'Projekt Falke Team'] },
      { id: 2, department_id: [2, 'Sales'] },
      { id: 3, department_id: [3, 'Finance'] },
    ]);
    const v = await svc.vetFieldSample!(field);
    assert.equal(v.identityHit, true);
    assert.deepEqual(v.hitTypes, ['custom']);
  });

  async function vetWith(c1: PromptPiiDetector, nearMiss?: PromptPiiDetector) {
    const svc = createPrivacyGuardService({
      c1Detector: c1,
      ...(nearMiss !== undefined ? { c1NearMissDetector: nearMiss } : {}),
    });
    await intern(svc, 'odoo_execute', EMPLOYEES);
    return svc.vetFieldSample!(field);
  }

  it('C1: a confident span is a hit, a weak one a near-miss, none clean', async () => {
    const hit = await vetWith(fakeC1([span('person', 0.9)]));
    assert.equal(hit.c1, 'hit');
    assert.deepEqual(hit.hitTypes, ['person']);
    assert.equal(hit.identityHit, false);
    assert.equal((await vetWith(fakeC1([]), fakeC1([span('person', 0.35)]))).c1, 'near-miss');
    assert.equal((await vetWith(fakeC1([]), fakeC1([]))).c1, 'clean');
  });

  it('C1 failing or unconfigured is unavailable', async () => {
    assert.equal((await vetWith(fakeC1(new Error('down')))).c1, 'unavailable');
    const svc = createPrivacyGuardService({
      c1Detector: fakeC1([span('person', 0.9)]),
      c1CacheScope: () => undefined,
    });
    await intern(svc, 'odoo_execute', EMPLOYEES);
    assert.equal((await svc.vetFieldSample!(field)).c1, 'unavailable');
  });

  it('C1 sees the sample, never the observation log', async () => {
    const seen: string[] = [];
    const c1: PromptPiiDetector = {
      id: 'c1-spy',
      detect: async (text) => {
        seen.push(text);
        return [];
      },
    };
    await vetWith(c1);
    assert.equal(seen.length, 1);
    assert.ok(seen[0]!.includes(RND));
  });
});

describe('#1556 follow-up — classifyModelsSchemaOnly', () => {
  const requests = [
    {
      model: 'hr.department',
      modelLabel: 'Department',
      fields: [{ path: 'department_id', label: 'Department', help: 'The team.' }],
    },
    { model: 'x_custom.region', fields: [{ path: 'x_region_id' }] },
  ];

  it('sends schema only and parses the verdicts', async () => {
    const svc = createPrivacyGuardService();
    await intern(svc, 'odoo_execute', EMPLOYEES, { model: 'hr.employee' });
    const prompts: string[] = [];
    const llm = async (req: { system?: string; messages: ReadonlyArray<{ content: string }> }) => {
      prompts.push(`${req.system ?? ''}\n${req.messages.map((m) => m.content).join('\n')}`);
      return {
        text:
          'Here you go:\n```json\n{"models":[{"model":"hr.department","verdict":"non-personal",' +
          '"confidence":0.92,"reason":"Organisational unit."},' +
          '{"model":"x_custom.region","verdict":"personal","confidence":0.6,"reason":"Unclear."},' +
          '{"model":"res.partner","verdict":"non-personal","confidence":1,"reason":"x"}]}\n```',
      };
    };
    const results = await classifyModelsSchemaOnly(requests, llm);
    assert.deepEqual(results, [
      { model: 'hr.department', verdict: 'non-personal', confidence: 0.92, reason: 'Organisational unit.' },
      { model: 'x_custom.region', verdict: 'personal', confidence: 0.6, reason: 'Unclear.' },
    ]);
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0]!.includes('hr.department'));
    for (const v of SAMPLE_VALUES) assert.ok(!prompts[0]!.includes(v), `value in prompt: ${v}`);

    // Through the service as well: same prompt contract, no buffered value.
    const viaSvc: string[] = [];
    const svc2 = createPrivacyGuardService({
      llmComplete: async (req) => {
        viaSvc.push(JSON.stringify(req));
        return { text: '[]' };
      },
    });
    await intern(svc2, 'odoo_execute', EMPLOYEES, { model: 'hr.employee' });
    viaSvc.length = 0; // drop the intern-time schema classifier call
    const out = await svc2.classifyModelsSchemaOnly!(requests);
    assert.deepEqual(out.map((r) => r.verdict), ['uncertain', 'uncertain']);
    assert.equal(viaSvc.length, 1);
    for (const v of SAMPLE_VALUES) assert.ok(!viaSvc[0]!.includes(v), `value in prompt: ${v}`);
  });

  it('garbage, a failed call or no LLM yield uncertain with confidence 0', async () => {
    const uncertain = requests.map((r) => ({
      model: r.model,
      verdict: 'uncertain',
      confidence: 0,
      reason: '',
    }));
    assert.deepEqual(await classifyModelsSchemaOnly(requests, async () => ({ text: 'no idea' })), uncertain);
    assert.deepEqual(
      await classifyModelsSchemaOnly(requests, async () => {
        throw new Error('boom');
      }),
      uncertain,
    );
    assert.deepEqual(await classifyModelsSchemaOnly(requests, undefined), uncertain);
    assert.deepEqual(await createPrivacyGuardService().classifyModelsSchemaOnly!(requests), uncertain);
    // A definite verdict without a confidence is not trusted.
    const noConf = await classifyModelsSchemaOnly(requests.slice(0, 1), async () => ({
      text: '[{"model":"hr.department","verdict":"non-personal"}]',
    }));
    assert.deepEqual(noConf, uncertain.slice(0, 1));
  });

  it('batches requests', async () => {
    let calls = 0;
    const many = Array.from({ length: MODELS_PER_CALL * 2 + 1 }, (_, i) => ({
      model: `x_m${String(i)}`,
      fields: [{ path: `f${String(i)}` }],
    }));
    const out = await classifyModelsSchemaOnly(many, async () => {
      calls += 1;
      return { text: '[]' };
    });
    assert.equal(calls, 3);
    assert.equal(out.length, many.length);
  });
});

describe('#1556 follow-up — maskedFieldPreview', () => {
  it('replaces every letter and digit, keeps punctuation and spaces', () => {
    assert.equal(shapeMask(RND), '•••••••• & •••••••••••');
    assert.equal(shapeMask('Büro 42-B, Köln'), '•••• ••-•, ••••');
    assert.deepEqual(maskedPreview(['a', 'b', 'c', 'd', 'e', 'f']).length, 5);
    assert.deepEqual(maskedPreview(['ab', 'c'], 1), ['••']);
  });

  it('the service preview never contains a letter of the sample', async () => {
    const svc = createPrivacyGuardService();
    await intern(svc, 'odoo_execute', EMPLOYEES);
    const preview = svc.maskedFieldPreview!({ toolName: 'odoo_execute', fieldPath: 'name' });
    assert.equal(preview.length, 4);
    for (const p of preview) assert.ok(!/[\p{L}\p{N}]/u.test(p), p);
  });
});
