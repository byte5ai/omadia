/**
 * #1556 follow-up — the privacy guard's half of field classification:
 * schema-only observations of masked fields per (tool, scope, path) from any
 * interned tool, a bounded value sample per field vetted by the guard's own
 * detectors, schema-only model classification, the shape-masked preview and
 * the admin-only real sample (contract v2). No value may ever leave except
 * as a detector verdict, a shape-masked preview, or `fieldSampleForAdmin` on
 * the separate kernel-only `privacyFieldSamples` service (never for an
 * uploaded dataset).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { PromptPiiDetector, PromptPiiSpan } from '@omadia/plugin-api';
import {
  createPrivacyGuardService,
  createPrivacyGuardServices,
} from '@omadia/plugin-privacy-guard/dist/index.js';
import {
  MAX_SAMPLE_VALUES,
  SAMPLE_TTL_MS,
  createFieldObservationRecorder,
  isObservedTool,
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
  it('records masked m2o/text fields per (tool, scope, path), schema only', async () => {
    const svc = createPrivacyGuardService();
    await intern(svc, 'odoo_execute', EMPLOYEES, { model: 'hr.employee', method: 'search_read' });
    await intern(svc, 'odoo_execute', EMPLOYEES, { model: 'hr.employee' });
    const obs = svc.takeFieldObservations!();
    const byPath = new Map(obs.map((o) => [o.fieldPath, o]));
    assert.equal(byPath.get('department_id')?.valueShape, 'm2o');
    assert.equal(byPath.get('name')?.valueShape, 'text');
    assert.equal(byPath.get('department_id')?.scope, 'hr.employee');
    assert.ok(!('sourceModels' in byPath.get('department_id')!));
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

  it('reads the scope from an envelope', async () => {
    const svc = createPrivacyGuardService();
    await intern(svc, 'odoo_query', {
      model: 'hr.employee',
      count: 4,
      truncated: false,
      records: EMPLOYEES,
    });
    const dept = svc.takeFieldObservations!().find((o) => o.fieldPath === 'department_id');
    assert.equal(dept?.scope, 'hr.employee');
    assert.equal(dept?.toolName, 'odoo_query');
  });

  it('records every tool: plugin, MCP-like and query_dataset with its dataset id', async () => {
    const { service: svc, fieldSamples } = createPrivacyGuardServices();
    const DS = '0f8e2c1a-7b3d-4e5f-9a1b-2c3d4e5f6a7b';
    const upload = EMPLOYEES.map((e) => ({ id: e.id, 'Mitarbeiter name': e.name }));
    await intern(svc, 'hr_export', EMPLOYEES);
    await intern(svc, 'mcp__crm__list_contacts', EMPLOYEES, { query: 'all' });
    await intern(svc, 'query_dataset', upload, { query: 'query_rows', dataset_id: DS.toUpperCase() });
    await intern(svc, 'query_dataset', upload, { query: 'get_schema', dataset_id: DS });
    const obs = svc.takeFieldObservations!();
    const keys = obs.map((o) => `${o.toolName}|${o.scope}|${o.fieldPath}`).sort();
    assert.deepEqual(keys, [
      'hr_export|-|department_id',
      'hr_export|-|name',
      'mcp__crm__list_contacts|-|department_id',
      'mcp__crm__list_contacts|-|name',
      'query_dataset|-|Mitarbeiter name',
      `query_dataset|${DS}|Mitarbeiter name`,
    ]);
    const key = { toolName: 'query_dataset', scope: DS, fieldPath: 'Mitarbeiter name' };
    // An uploaded dataset's rows belong to the uploading user: no real value
    // leaves, the masked preview still does.
    assert.deepEqual(fieldSamples.fieldSampleForAdmin(key), []);
    assert.equal(svc.maskedFieldPreview!({ ...key, limit: 10 }).length, NAMES.length);
  });

  it('one observation per scope: the same field of two models stays two candidates', async () => {
    const svc = createPrivacyGuardService();
    await intern(svc, 'odoo_execute', EMPLOYEES, { model: 'hr.employee' });
    await intern(svc, 'odoo_execute', EMPLOYEES, { model: 'res.partner' });
    await intern(svc, 'odoo_execute', EMPLOYEES, { model: 'res.partner' });
    const dept = svc.takeFieldObservations!().filter((o) => o.fieldPath === 'department_id');
    assert.deepEqual(
      dept.map((o) => [o.scope, o.seenCount]).sort(),
      [
        ['hr.employee', 1],
        ['res.partner', 2],
      ],
    );
  });

  it('ignores sub-agent narration, canvas producers and v4_* verbs', async () => {
    const svc = createPrivacyGuardService();
    await intern(svc, 'canvas_publish_rows', EMPLOYEES);
    await intern(svc, 'v4_filter', EMPLOYEES);
    await svc.subAgentResultV4({
      sessionId: 's',
      turnId: 't-fc-sub',
      datasetIds: [],
      narration: JSON.stringify(EMPLOYEES),
    } as Parameters<NonNullable<typeof svc.subAgentResultV4>>[0]);
    assert.deepEqual(svc.takeFieldObservations!(), []);
    assert.deepEqual(
      svc.maskedFieldPreview!({ toolName: 'canvas_publish_rows', scope: '-', fieldPath: 'name' }),
      [],
    );
    assert.equal(isObservedTool('v4_join', new Set()), false);
    assert.equal(isObservedTool('sub-agent', new Set(['sub-agent'])), false);
    assert.equal(isObservedTool('mcp__x__y', new Set()), true);
  });

  it('skips a field an operator rule already cleared as a label', async () => {
    const svc = createPrivacyGuardService({
      readConfig: (key) =>
        key === 'non_personal_fields' ? 'odoo_execute:hr.employee/department_id' : undefined,
    });
    await intern(svc, 'odoo_execute', EMPLOYEES, { model: 'hr.employee' });
    await intern(svc, 'odoo_execute', EMPLOYEES, { model: 'res.partner' });
    const keys = svc.takeFieldObservations!().map((o) => `${o.scope}|${o.fieldPath}`);
    assert.ok(!keys.includes('hr.employee|department_id'));
    assert.ok(keys.includes('res.partner|department_id'), 'another model is still a candidate');
    assert.ok(keys.includes('hr.employee|name'));
  });
});

describe('#1556 follow-up — observation grammar (security review H2)', () => {
  const INVALID_PATHS = [
    'x\n*:partner_id',
    'x,partner_id',
    'x;partner_id',
    'a:b',
    'a/b',
    ' lead',
    'trail ',
    'x\ry',
    '__k_x',
  ];
  const VALID_PATHS = ['Abteilung name', 'Name', '1x'];

  it('records only scoped-field names — never a key that could become several entries', async () => {
    const { service: svc, fieldSamples } = createPrivacyGuardServices();
    const rows = NAMES.map((name, i) => {
      const row: Record<string, unknown> = { id: i + 1, name };
      for (const path of [...INVALID_PATHS, ...VALID_PATHS]) row[path] = name;
      return row;
    });
    await intern(svc, 'odoo_execute', rows, { model: 'res.partner' });
    const paths = svc.takeFieldObservations!().map((o) => o.fieldPath);
    assert.ok(paths.includes('name'), 'a valid field is still observed');
    for (const path of VALID_PATHS) assert.ok(paths.includes(path), JSON.stringify(path));
    for (const path of INVALID_PATHS) assert.ok(!paths.includes(path), JSON.stringify(path));
    for (const path of INVALID_PATHS) {
      const key = { toolName: 'odoo_execute', scope: 'res.partner', fieldPath: path };
      assert.deepEqual(svc.maskedFieldPreview!(key), []);
      assert.deepEqual(fieldSamples.fieldSampleForAdmin(key), []);
    }
  });

  it('a model outside the scope grammar becomes scope -', async () => {
    const svc = createPrivacyGuardService();
    await intern(svc, 'odoo_execute', EMPLOYEES, { model: 'res.partner\n*:name' });
    await intern(svc, 'odoo_execute', EMPLOYEES, { model: 'Bad Model' });
    const names = svc.takeFieldObservations!().filter((o) => o.fieldPath === 'name');
    assert.deepEqual(
      names.map((o) => [o.scope, o.seenCount]),
      [['-', 2]],
    );
  });

  it('ignores tools whose name is outside the tool grammar', async () => {
    const svc = createPrivacyGuardService();
    await intern(svc, 'odoo_x:y', EMPLOYEES, { model: 'hr.employee' });
    await intern(svc, 'odoo_x y', EMPLOYEES, { model: 'hr.employee' });
    assert.deepEqual(svc.takeFieldObservations!(), []);
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
    const sample = rec.sample({ toolName: 'odoo_execute', scope: '-', fieldPath: 'name' });
    assert.equal(sample.length, MAX_SAMPLE_VALUES);
    assert.equal(new Set(sample).size, sample.length);
  });

  it('drops values older than the TTL', () => {
    let clock = 1_000_000;
    const rec = createFieldObservationRecorder({ now: () => clock });
    rec.record('odoo_execute', dataset(EMPLOYEES), new Set());
    const key = { toolName: 'odoo_execute', scope: '-', fieldPath: 'name' };
    assert.equal(rec.sample(key).length, 4);
    clock += SAMPLE_TTL_MS + 1;
    assert.deepEqual(rec.sample(key), []);
  });

  it('vetting clears the sample', async () => {
    const svc = createPrivacyGuardService();
    await intern(svc, 'odoo_execute', EMPLOYEES, { model: 'hr.employee' });
    const field = { toolName: 'odoo_execute', scope: 'hr.employee', fieldPath: 'department_id' };
    assert.equal(svc.maskedFieldPreview!({ ...field, limit: 10 }).length, 3);
    const verdict = await svc.vetFieldSample!(field);
    assert.equal(verdict.sampleCount, 3);
    assert.equal(verdict.scope, 'hr.employee');
    assert.deepEqual(svc.maskedFieldPreview!(field), []);
    const again = await svc.vetFieldSample!(field);
    assert.equal(again.sampleCount, 0);
    for (const v of SAMPLE_VALUES) assert.ok(!JSON.stringify(verdict).includes(v));
  });
});

describe('#1556 follow-up — vetFieldSample', () => {
  const field = { toolName: 'odoo_execute', scope: '-', fieldPath: 'department_id' };

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

  it('is an allowlist: only whitespace and & - . , / ( ) \' : + survive, one • per code point', () => {
    assert.equal(shapeMask("a&b-c.d,e/f(g)h'i:j+k"), "•&•-•.•,•/•(•)•'•:•+•");
    assert.equal(shapeMask('a\tb\nc'), '•\t•\n•');
    // Circled and full-width letters, CJK, symbols.
    assert.equal(shapeMask('ⒶⓑⒸ'), '•••');
    assert.equal(shapeMask('Ａｂ'), '••');
    assert.equal(shapeMask('東京 支店'), '•• ••');
    assert.equal(shapeMask('€5 % # @ _ ! ? * = ~'), '•• • • • • • • • • •');
    // Astral code points: one • each, never a lone surrogate.
    assert.equal(shapeMask('🇩🇪 GmbH'), '•• ••••');
    assert.equal(shapeMask('👩‍💻'), '•••', 'a ZWJ sequence is three code points');
    assert.equal(shapeMask('𝐀𝐁'), '••');
    for (const out of ['🇩🇪', '👩‍💻', '𝐀', 'Ⓐ', '東']) {
      assert.ok(/^[•\s&\-.,/()':+]*$/u.test(shapeMask(out)), out);
    }
  });

  it('the service preview never contains a letter of the sample', async () => {
    const svc = createPrivacyGuardService();
    await intern(svc, 'odoo_execute', EMPLOYEES);
    const preview = svc.maskedFieldPreview!({ toolName: 'odoo_execute', scope: '-', fieldPath: 'name' });
    assert.equal(preview.length, 4);
    for (const p of preview) assert.ok(!/[\p{L}\p{N}]/u.test(p), p);
  });
});

describe('contract v2 — fieldSampleForAdmin', () => {
  function spyConsole(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    const capture = (...args: unknown[]): void => {
      lines.push(args.map(String).join(' '));
    };
    console.log = capture;
    console.warn = capture;
    console.error = capture;
    console.info = capture;
    return {
      lines,
      restore: () => {
        Object.assign(console, saved);
      },
    };
  }

  it('is not part of the plugin-facing privacyRedact service', () => {
    const svc = createPrivacyGuardService() as unknown as Record<string, unknown>;
    assert.ok(!('fieldSampleForAdmin' in svc));
  });

  it('returns the real buffered values, logs nothing and keeps the sample', async () => {
    const { service: svc, fieldSamples } = createPrivacyGuardServices();
    await intern(svc, 'odoo_execute', EMPLOYEES, { model: 'hr.employee' });
    const key = { toolName: 'odoo_execute', scope: 'hr.employee', fieldPath: 'name' };
    const spy = spyConsole();
    let sample: readonly string[];
    try {
      sample = fieldSamples.fieldSampleForAdmin(key);
    } finally {
      spy.restore();
    }
    assert.deepEqual([...sample].sort(), [...NAMES].sort());
    assert.deepEqual(spy.lines, [], 'fieldSampleForAdmin logged');
    // Not drained: the preview and the vetting still see it.
    assert.equal(fieldSamples.fieldSampleForAdmin(key).length, 4);
    const preview = svc.maskedFieldPreview!(key);
    assert.equal(preview.length, 4);
    for (const p of preview) assert.ok(!/[\p{L}\p{N}]/u.test(p), p);
    assert.equal((await svc.vetFieldSample!(key)).sampleCount, 4);
  });

  it('is keyed by scope and bounded: default 10, max 50', async () => {
    const { service: svc, fieldSamples } = createPrivacyGuardServices();
    const rows = Array.from({ length: 80 }, (_, i) => ({ id: i, name: `Person Number ${String(i)}` }));
    await intern(svc, 'odoo_execute', rows, { model: 'res.partner' });
    const key = { toolName: 'odoo_execute', scope: 'res.partner', fieldPath: 'name' };
    assert.equal(fieldSamples.fieldSampleForAdmin(key).length, 10);
    assert.equal(fieldSamples.fieldSampleForAdmin({ ...key, limit: 3 }).length, 3);
    assert.equal(fieldSamples.fieldSampleForAdmin({ ...key, limit: 500 }).length, MAX_SAMPLE_VALUES);
    assert.equal(fieldSamples.fieldSampleForAdmin({ ...key, limit: -1 }).length, 0);
    assert.deepEqual(fieldSamples.fieldSampleForAdmin({ ...key, scope: 'hr.employee' }), []);
    assert.deepEqual(fieldSamples.fieldSampleForAdmin({ ...key, scope: '-' }), []);
  });
});

describe('security review — recorder refuses non-columns and value-like keys', () => {
  const DS = '0f8e2c1a-7b3d-4e5f-9a1b-2c3d4e5f6a7b';

  it('skips key / value / groups of a grouped query_dataset result', async () => {
    const svc = createPrivacyGuardService();
    const grouped = {
      groups: [
        { key: 'Paul Williams', value: 'Research & Development' },
        { key: 'Beth Evans', value: 'Sales Team' },
        { key: 'Anna Rüsche', value: 'Management' },
      ],
    };
    await intern(svc, 'query_dataset', grouped, { query: 'group_by', dataset_id: DS });
    await intern(svc, 'query_dataset', grouped.groups, { query: 'query_rows', dataset_id: DS });
    const paths = svc.takeFieldObservations!().map((o) => o.fieldPath);
    for (const p of ['key', 'value', 'groups']) assert.ok(!paths.includes(p), p);
    // The same names from any other tool are still observed.
    await intern(svc, 'mcp__crm__groups', grouped.groups);
    const other = svc.takeFieldObservations!().map((o) => o.fieldPath).sort();
    assert.deepEqual(other, ['key', 'value']);
  });

  it('drops keys that are values: e-mail-keyed maps and person-name headers', async () => {
    const { service: svc, fieldSamples } = createPrivacyGuardServices();
    const byMail = [
      { 'anna.mueller@example.com': 'Sales', 'bob@example.de': 'HR', Abteilung: 'Sales' },
      { 'anna.mueller@example.com': 'HR', 'bob@example.de': 'Sales', Abteilung: 'HR' },
    ];
    await intern(svc, 'mcp__dir__members', byMail);
    const sheet = NAMES.map((name, i) => ({
      'Anna Müller': name,
      'Jean-Luc Picard': name,
      Abteilung: i % 2 === 0 ? 'Sales Team' : 'Management',
      department_id: [i + 1, i % 2 === 0 ? 'Sales Team' : 'Management'],
    }));
    await intern(svc, 'odoo_execute', sheet, { model: 'hr.employee' });
    const paths = svc.takeFieldObservations!().map((o) => o.fieldPath);
    for (const dropped of ['anna.mueller@example.com', 'bob@example.de', 'Anna Müller', 'Jean-Luc Picard']) {
      assert.ok(!paths.includes(dropped), dropped);
      const key = { toolName: 'odoo_execute', scope: 'hr.employee', fieldPath: dropped };
      assert.deepEqual(fieldSamples.fieldSampleForAdmin(key), [], 'no sample either');
    }
    assert.ok(paths.includes('Abteilung'), 'Abteilung is kept');
    assert.ok(paths.includes('department_id'), 'department_id is kept');
  });

  it('refuses invisible format characters and a tool literally named dataset', async () => {
    const svc = createPrivacyGuardService();
    const rows = NAMES.map((name) => ({
      'name​': name,
      'ab‮teilung': name,
      'dept⁦x': name,
      name,
    }));
    await intern(svc, 'odoo_execute', rows, { model: 'res.partner' });
    await intern(svc, 'dataset', EMPLOYEES);
    const obs = svc.takeFieldObservations!();
    assert.deepEqual(
      obs.map((o) => `${o.toolName}|${o.fieldPath}`),
      ['odoo_execute|name'],
    );
  });
});
