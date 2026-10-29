/**
 * Fast-path findings from the live v410 run (2026-10-29):
 *
 *   1. learned plans were "kept in-process only": the plugin activated before
 *      the memory provider published `memoryStore`, so ctx.memory was absent
 *      — the manifest now `requires: memoryStore@^1` (activation edge) and a
 *      plugin activated with ctx.memory persists its plans;
 *   2. a valid plan without a usable summary is no longer discarded
 *      (`invalid-plan:no-summary`): a deterministic count sentence in the
 *      planner's locale (else a de/en guess from the request) replaces it —
 *      chat triage, canvas composer path and in-place planner alike;
 *   3. turn-critical stored-text masking (triage, skeleton, in-place planner)
 *      runs on the sidecar's interactive lane; memory jobs and learned-example
 *      masking stay background;
 *   4. canvas refresh recipes persist per canvas session in plugin memory,
 *      bounded, lazily loaded, corrupt-tolerant;
 *   5. the composer / planners take the first balanced JSON object from a
 *      fenced or prefaced answer instead of discarding it.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import type { PluginContext, PrivacyGuardService, PrivacyStoredTextScopeRequest } from '@omadia/plugin-api';
import { parse as parseYaml } from 'yaml';

import { defaultSummary, summaryLanguage } from '../packages/harness-plugin-fast-path/src/fastPath.js';
import { extractFirstJsonObject } from '../packages/harness-plugin-fast-path/src/jsonExtract.js';
import { InMemoryMemoryStore } from '@omadia/memory';

import { createMemoryAccessor } from '../src/platform/memoryAccessor.js';
import { createLearnedPlanStore, planId } from '../packages/harness-plugin-fast-path/src/learnedPlanStore.js';
import { activate } from '../packages/harness-plugin-fast-path/src/plugin.js';
import { createRecipeStore, type RecipeMemory } from '../packages/harness-plugin-fast-path/src/recipeStore.js';
import type { RefreshSource } from '../packages/harness-plugin-fast-path/src/refreshRecipes.js';
import type { FastPathService } from '../packages/harness-plugin-fast-path/src/service.js';
import { createFastPathService } from '../packages/harness-plugin-fast-path/src/service.js';
import {
  openSkeletonPrivacy,
  openStoredTextPrivacy,
} from '../packages/harness-plugin-fast-path/src/storedTextPrivacy.js';
import { parsePlan, plannerTool } from '../packages/harness-plugin-fast-path/src/planner.js';
import { parseTriage, withRouterPlanner } from './_helpers/fastPathRouterPlanner.js';
import { createC1HttpDetector } from '../packages/harness-plugin-privacy-guard/src/c1Detector.js';
import { createPrivacyGuardService } from '../packages/harness-plugin-privacy-guard/src/service.js';
import { createStoredTextScope } from '../packages/harness-plugin-privacy-guard/src/storedTextScope.js';
import { composeSkeleton } from '../packages/omadia-ui-orchestrator/src/composition.js';
import { parseInPlacePlan, type CanvasTable } from '../packages/omadia-ui-orchestrator/src/learnedFastPath.js';

// ── fixtures ──────────────────────────────────────────────────────────────

const FETCH = {
  tool: 'odoo_query',
  input: { model: 'hr.employee', fields: ['name', 'birthday'], limit: 100 },
  map: { name: 'name', birthday: 'birthday' },
  rowKey: 'id',
};
const ALLOWED = new Set(['odoo_query']);

/** A file-backed memory stub: survives a "restart" (a new store over it). */
function memoryStub(seed: Record<string, string> = {}): RecipeMemory & {
  files: Map<string, string>;
  writes: string[];
} {
  const files = new Map(Object.entries(seed));
  const writes: string[] = [];
  return {
    files,
    writes,
    exists: async (p) => files.has(p),
    readFile: async (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    writeFile: async (p, c) => {
      writes.push(p);
      files.set(p, c);
    },
    delete: async (p) => {
      files.delete(p);
    },
  };
}

const recipe = (n: number): RefreshSource => ({
  tool: 'odoo_query',
  input: { model: 'res.partner', domain: [['id', '=', n]] },
  map: { name: 'name' },
  rowKey: 'id',
});

// ── 1. learned plans persist ──────────────────────────────────────────────

describe('fast-path — learned plans persist (ctx.memory)', () => {
  it('the manifest declares memory AND requires the memory provider (activation order)', () => {
    const manifest = parseYaml(
      readFileSync(new URL('../packages/harness-plugin-fast-path/manifest.yaml', import.meta.url), 'utf8'),
    ) as { requires?: string[]; permissions?: { memory?: { reads?: string[]; writes?: string[] } } };
    assert.deepEqual(manifest.permissions?.memory?.reads, ['agent:@omadia/fast-path:*']);
    assert.deepEqual(manifest.permissions?.memory?.writes, ['agent:@omadia/fast-path:*']);
    assert.ok(manifest.requires?.includes('memoryStore@^1'), 'memoryStore@^1 must be an activation edge');
  });

  it('a plugin activated with ctx.memory writes learned plans to its plugin-wide tree', async () => {
    const perAgent = memoryStub();
    const memory = memoryStub();
    const ctxMemory = { ...perAgent, pluginWide: memory };
    const logs: string[] = [];
    let service: FastPathService | undefined;
    const ctx = {
      agentId: '@omadia/fast-path',
      log: (m: string) => logs.push(m),
      config: { get: <T>(k: string): T | undefined => (k === 'fast_path_tools' ? ('odoo_query' as T) : undefined) },
      memory: ctxMemory,
      services: {
        get: () => undefined,
        provide: (_name: string, impl: unknown) => {
          service = impl as FastPathService;
          return () => undefined;
        },
      },
    } as unknown as PluginContext;
    const handle = await activate(ctx);
    assert.ok(service);
    await service.plans.load();
    await service.plans.recordSuccess({ tool: 'odoo_query', inputTemplate: FETCH.input, map: FETCH.map });
    assert.ok(memory.writes.some((p) => p.endsWith('plans.json')), `writes: ${memory.writes.join(',')}`);
    assert.equal(perAgent.writes.length, 0, 'never the per-Agent view');
    assert.ok(!logs.some((l) => l.includes('no ctx.memory')));
    await handle.close();
  });

  it('two turns under different Agents write and read the SAME plans file', async () => {
    const store = new InMemoryMemoryStore();
    let slug: string | undefined = 'agent-a';
    const accessor = createMemoryAccessor({ pluginId: '@omadia/fast-path', store, resolveAgentSlug: () => slug });
    assert.ok(accessor.pluginWide);
    const underA = createLearnedPlanStore({ memory: accessor.pluginWide, log: () => undefined });
    await underA.load();
    await underA.recordSuccess({ tool: 'odoo_query', inputTemplate: FETCH.input, map: FETCH.map });

    slug = 'agent-b';
    const underB = createLearnedPlanStore({ memory: accessor.pluginWide, log: () => undefined });
    await underB.load();
    const id = planId({ tool: 'odoo_query', inputTemplate: FETCH.input, map: FETCH.map });
    assert.equal(underB.get(id)?.successes, 1, 'agent-b reads what agent-a learned');
    await underB.recordSuccess({ tool: 'odoo_query', inputTemplate: FETCH.input, map: FETCH.map });

    slug = undefined; // outside any turn
    const outside = createLearnedPlanStore({ memory: accessor.pluginWide, log: () => undefined });
    await outside.load();
    assert.equal(outside.get(id)?.successes, 2, 'agent-b extended the plan agent-a learned');
    assert.ok(await store.fileExists('/memories/agents/@omadia/fast-path/fastpath/plans.json'));
    assert.equal(await store.directoryExists('/memories/orchestrators'), false, 'nothing under any Agent');
    // the per-Agent view stays per Agent
    slug = 'agent-a';
    await accessor.writeFile('x.txt', 'a');
    slug = 'agent-b';
    assert.equal(await accessor.exists('x.txt'), false);
  });
});

// ── 2. missing summary keeps a valid plan ─────────────────────────────────

describe('fast-path — a missing summary defaults instead of discarding the plan', () => {
  it('default sentence follows the planner locale, else a de/en guess', () => {
    assert.equal(defaultSummary('de-DE'), '{count} Einträge gefunden.');
    assert.equal(defaultSummary('en-US'), '{count} results found.');
    assert.equal(defaultSummary(undefined, 'Geburtstage im Januar'), '{count} Einträge gefunden.');
    assert.equal(defaultSummary(undefined, 'birthdays in January'), '{count} results found.');
    assert.equal(summaryLanguage('de-AT'), 'de');
  });

  it('parseTriage: no summary / placeholder-less summary → deterministic with the default', () => {
    const noSummary = parseTriage(
      JSON.stringify({ decision: 'deterministic', fetch: FETCH, labels: { name: 'Name' }, locale: 'de-DE' }),
      ALLOWED,
    );
    assert.equal(noSummary.decision, 'deterministic');
    assert.ok(noSummary.decision === 'deterministic');
    assert.equal(noSummary.summary, '{count} Einträge gefunden.');
    assert.equal(noSummary.summaryDefaulted, true);

    const fixedSentence = parseTriage(
      JSON.stringify({ decision: 'deterministic', fetch: FETCH, summary: 'Here they are.' }),
      ALLOWED,
      { question: 'list all employees' },
    );
    assert.ok(fixedSentence.decision === 'deterministic');
    assert.equal(fixedSentence.summary, '{count} results found.');

    const kept = parseTriage(
      JSON.stringify({ decision: 'deterministic', fetch: FETCH, summary: '{count} Leute.', locale: 'de-DE' }),
      ALLOWED,
    );
    assert.ok(kept.decision === 'deterministic');
    assert.equal(kept.summary, '{count} Leute.');
    assert.equal(kept.summaryDefaulted, undefined);
  });

  it('the planner tool requires summary and locale (a forced call has no fences / prose)', () => {
    const schema = plannerTool('odoo_query').inputSchema as { required: string[] };
    assert.deepEqual(schema.required, ['tool', 'input', 'map', 'summary', 'locale']);
  });

  it('service: a summary-less deterministic triage answers with the default sentence', async () => {
    const logs: string[] = [];
    const service = createFastPathService({
      config: { get: <T>(k: string): T | undefined => (k === 'fast_path_tools' ? ('odoo_query' as T) : undefined) },
      llm: withRouterPlanner({
        complete: async () => ({
          text: JSON.stringify({ decision: 'deterministic', fetch: FETCH, labels: { name: 'Name', birthday: 'Geburtstag' } }),
        }),
      }),
      model: 'class:fast',
      invoke: async () =>
        JSON.stringify({ records: [{ id: 1, name: 'Anna', birthday: '1990-01-12' }, { id: 2, name: 'Peter', birthday: '1985-01-30' }] }),
      privacyGuard: () => undefined,
      privacyForced: () => false,
      log: (m) => logs.push(m),
    });
    const out = await service.triageChatTurn({
      channel: 'web',
      userMessage: 'Zeig mir alle Mitarbeitenden',
      permittedTools: ALLOWED,
    });
    assert.equal(out.kind, 'answer', logs.join('\n'));
    assert.ok(out.kind === 'answer');
    assert.match(out.text, /^2 Einträge gefunden\./);
    assert.ok(logs.some((l) => /\[fast-path\] planner channel=web tool=odoo_query ok ms=\d+ summary=default/.test(l)));
  });

  it('in-place planner: a summary-less plan for a visible table is kept', () => {
    const tables: CanvasTable[] = [{ containerId: 't1', fieldKeys: ['name', 'birthday'] }];
    const plan = parseInPlacePlan(
      JSON.stringify({ containerId: 't1', fetch: FETCH }),
      tables,
      ALLOWED,
      { question: 'und im Februar?' },
    );
    assert.ok(plan.ok);
    assert.equal(plan.summary, '{count} Einträge gefunden.');
    assert.equal(plan.summaryDefaulted, true);
  });

  it('canvas planner: locale is kept without a summary (the fast path defaults the sentence)', () => {
    const res = parsePlan(
      { containerId: 'root', ...FETCH, locale: 'de-DE' },
      { allowedTools: ALLOWED, containers: [{ containerId: 'root', description: 'x', fields: [] }] },
    );
    assert.ok(res.ok);
    assert.equal(res.containerId, 'root');
    assert.equal(res.plan.locale, 'de-DE');
    assert.equal(res.plan.summaryDefaulted, true);
  });
});

// ── 3. interactive lane for turn-critical masking ─────────────────────────

describe('privacy stored-text scope — priority lane per request', () => {
  const SIDECAR = 'http://pii-detector:8812';
  function sidecar(): { detector: ReturnType<typeof createC1HttpDetector>; lanes: Array<string | null> } {
    const lanes: Array<string | null> = [];
    const detector = createC1HttpDetector({
      resolveUrl: () => SIDECAR,
      fetchFn: (async (_url: string, init?: RequestInit) => {
        lanes.push(new Headers(init?.headers).get('x-pii-priority'));
        return new Response(JSON.stringify({ ok: true, spans: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    return { detector, lanes };
  }

  it('createStoredTextScope: background by default, interactive on request', async () => {
    const { detector, lanes } = sidecar();
    await createStoredTextScope({ job: 'j', detectors: [], c1Detector: detector }).maskStoredText('Hallo Anna');
    await createStoredTextScope({ job: 'j', detectors: [], c1Detector: detector, priority: 'interactive' }).maskStoredText(
      'Hallo Anna',
    );
    assert.deepEqual(lanes, ['background', 'interactive']);
  });

  it('service.openStoredTextScope honours request.priority (default background)', async () => {
    const { detector, lanes } = sidecar();
    const svc = createPrivacyGuardService({ readConfig: () => 'on', c1Detector: detector });
    await svc.openStoredTextScope!({ job: 'memory-job' }).maskStoredText('Hallo Anna');
    await svc.openStoredTextScope!({ job: 'fast-path-triage', priority: 'interactive' }).maskStoredText('Hallo Anna');
    assert.deepEqual(lanes, ['background', 'interactive']);
  });

  it('fast-path callers: triage + skeleton/in-place open interactive; a bare job stays default', async () => {
    const requests: PrivacyStoredTextScopeRequest[] = [];
    const guard = {
      openStoredTextScope: (req: PrivacyStoredTextScopeRequest) => {
        requests.push(req);
        return {
          maskStoredText: async (text: string) => ({ outcome: 'masked', maskedText: text, spans: [], degraded: false }),
          restoreStoredText: (t: string) => t,
        };
      },
    } as unknown as PrivacyGuardService;
    await openSkeletonPrivacy(guard).mask('x');
    await openStoredTextPrivacy(guard, 'some-job').mask('x');

    const service = createFastPathService({
      config: { get: <T>(k: string): T | undefined => (k === 'fast_path_tools' ? ('odoo_query' as T) : undefined) },
      llm: withRouterPlanner({ complete: async () => ({ text: JSON.stringify({ decision: 'agent', route: 'simple' }) }) }),
      model: 'class:fast',
      invoke: async () => '[]',
      privacyGuard: () => guard,
      privacyForced: () => false,
      log: () => undefined,
    });
    await service.triageChatTurn({ channel: 'web', userMessage: 'hallo', permittedTools: ALLOWED });

    assert.deepEqual(
      requests.map((r) => [r.job, r.priority]),
      [
        ['canvas-skeleton', 'interactive'],
        ['some-job', undefined],
        ['fast-path-triage', 'interactive'],
      ],
    );
  });
});

// ── 4. persistent canvas refresh recipes ──────────────────────────────────

describe('canvas refresh recipes — persisted per canvas session', () => {
  it('survives a restart: a new store over the same memory serves get after load', async () => {
    const memory = memoryStub();
    const before = createRecipeStore({ memory, log: () => undefined });
    await before.load('canvas-A');
    before.set('canvas-A', 'table_1', recipe(1));
    before.set('canvas-A', 'table_2', recipe(2));
    await before.flush();

    const after = createRecipeStore({ memory, log: () => undefined });
    assert.equal(after.get('canvas-A', 'table_1'), undefined, 'lazy: nothing before load');
    await after.load('canvas-A');
    assert.deepEqual(after.get('canvas-A', 'table_1'), recipe(1));
    assert.deepEqual(after.get('canvas-A', 'table_2'), recipe(2));
    assert.equal(after.get('canvas-B', 'table_1'), undefined, 'per canvas session, not tenant-wide');
  });

  it('never stores the raw canvas session id in a path', async () => {
    const memory = memoryStub();
    const store = createRecipeStore({ memory, log: () => undefined });
    await store.load('../../etc/passwd');
    store.set('../../etc/passwd', 't', recipe(1));
    await store.flush();
    for (const p of memory.files.keys()) {
      assert.ok(!p.includes('passwd') && !p.includes('..'), p);
      assert.match(p, /^canvas-recipes\//);
    }
  });

  it('caps containers per session (oldest dropped)', async () => {
    const memory = memoryStub();
    const store = createRecipeStore({ memory, log: () => undefined, maxContainersPerSession: 3 });
    await store.load('s');
    for (let i = 1; i <= 5; i += 1) store.set('s', `t${i}`, recipe(i));
    await store.flush();
    const reloaded = createRecipeStore({ memory, log: () => undefined, maxContainersPerSession: 3 });
    await reloaded.load('s');
    assert.equal(reloaded.get('s', 't1'), undefined);
    assert.equal(reloaded.get('s', 't2'), undefined);
    assert.deepEqual(reloaded.get('s', 't5'), recipe(5));
  });

  it('global LRU: the least recently used session is evicted, its file deleted', async () => {
    const memory = memoryStub();
    const store = createRecipeStore({ memory, log: () => undefined, maxEntries: 4 });
    for (const s of ['s1', 's2', 's3']) {
      await store.load(s);
      store.set(s, 'a', recipe(1));
      store.set(s, 'b', recipe(2));
    }
    await store.flush();
    // 6 entries > 4 → s1 (oldest) evicted
    assert.equal(store.get('s1', 'a'), undefined);
    assert.deepEqual(store.get('s3', 'a'), recipe(1));
    const sessionFiles = [...memory.files.keys()].filter((p) => !p.endsWith('index.json'));
    assert.equal(sessionFiles.length, 2);
    const reloaded = createRecipeStore({ memory, log: () => undefined, maxEntries: 4 });
    await reloaded.load('s1');
    assert.equal(reloaded.get('s1', 'a'), undefined);
  });

  it('corrupt files start empty and never throw', async () => {
    const memory = memoryStub();
    const store = createRecipeStore({ memory, log: () => undefined });
    await store.load('s');
    store.set('s', 't', recipe(1));
    await store.flush();
    for (const p of memory.files.keys()) memory.files.set(p, '{not json');
    const logs: string[] = [];
    const reloaded = createRecipeStore({ memory, log: (m) => logs.push(m) });
    await reloaded.load('s');
    assert.equal(reloaded.get('s', 't'), undefined);
    assert.ok(logs.some((l) => l.includes('unreadable')));
    // still writable afterwards
    reloaded.set('s', 't', recipe(2));
    await reloaded.flush();
    const again = createRecipeStore({ memory, log: () => undefined });
    await again.load('s');
    assert.deepEqual(again.get('s', 't'), recipe(2));
  });

  it('a failing memory write is logged, the in-process recipe still serves', async () => {
    const memory = memoryStub();
    memory.writeFile = async () => {
      throw new Error('disk full');
    };
    const logs: string[] = [];
    const store = createRecipeStore({ memory, log: (m) => logs.push(m) });
    await store.load('s');
    store.set('s', 't', recipe(1));
    await store.flush();
    assert.deepEqual(store.get('s', 't'), recipe(1));
    assert.ok(logs.some((l) => l.includes('write failed')));
  });

  it('without memory it behaves as the in-process store', async () => {
    const store = createRecipeStore();
    await store.load('s');
    store.set('s', 't', recipe(1));
    assert.deepEqual(store.get('s', 't'), recipe(1));
  });
});

// ── 5. tolerant JSON extraction ───────────────────────────────────────────

describe('extractFirstJsonObject — fenced / prefaced model output', () => {
  const OBJ = { tree: { type: 'container', id: 'root' }, note: 'a } brace and a "quote" in a string' };
  const json = JSON.stringify(OBJ);

  it('raw object → shape raw', () => {
    const r = extractFirstJsonObject(`  ${json}\n`);
    assert.ok(r.ok);
    assert.equal(r.shape, 'raw');
    assert.deepEqual(r.value, OBJ);
  });

  for (const [name, text] of [
    ['fenced', `\`\`\`json\n${json}\n\`\`\``],
    ['preface', `Here is the skeleton {as requested}:\n${json}`],
    ['trailing text', `${json}\nLet me know if you need {anything} else.`],
    ['two objects (first wins)', `${json}\n${JSON.stringify({ tree: 'second' })}`],
  ] as const) {
    it(`${name} → recovered, the first object`, () => {
      const r = extractFirstJsonObject(text);
      assert.ok(r.ok, name);
      assert.equal(r.shape, 'recovered');
      assert.deepEqual(r.value, OBJ);
    });
  }

  it('invalid / truncated / empty → not ok with a PII-free shape', () => {
    assert.deepEqual(extractFirstJsonObject(''), { ok: false, shape: 'empty' });
    assert.deepEqual(extractFirstJsonObject('no json here'), { ok: false, shape: 'no-object' });
    assert.deepEqual(extractFirstJsonObject('{"tree": {"type": "contai'), { ok: false, shape: 'unbalanced' });
    assert.deepEqual(extractFirstJsonObject('[1,2]'), { ok: false, shape: 'no-object' });
  });

  it('composer: a fenced answer is recovered and logged; garbage still falls back', async () => {
    const tree = { type: 'container', id: 'root', layout: 'stack', children: [] };
    const logs: string[] = [];
    const fenced = await composeSkeleton({
      llm: { complete: async () => ({ text: `Sure!\n\`\`\`json\n${JSON.stringify({ tree, dataRequirements: [] })}\n\`\`\`\nDone.` }) },
      model: 'class:fast',
      userText: 'x',
      log: (m) => logs.push(m),
    });
    assert.equal(fenced.source, 'model');
    assert.ok(logs.includes('[composition] attempt 1: recovered JSON from fenced output'), logs.join('\n'));

    const garbageLogs: string[] = [];
    const garbage = await composeSkeleton({
      llm: { complete: async () => ({ text: 'I cannot do that.' }) },
      model: 'class:fast',
      userText: 'x',
      log: (m) => garbageLogs.push(m),
    });
    assert.equal(garbage.source, 'fallback');
    assert.ok(garbageLogs.some((l) => l.includes('not parseable as raw JSON (shape=no-object')));
  });

  it('triage and in-place planner accept a fenced answer', () => {
    const triage = parseTriage(
      `\`\`\`json\n${JSON.stringify({ decision: 'agent', route: 'simple' })}\n\`\`\` trailing {x}`,
      ALLOWED,
    );
    assert.deepEqual(triage, { decision: 'agent', route: 'simple' });
    const plan = parseInPlacePlan(
      `Plan:\n\`\`\`json\n${JSON.stringify({ containerId: 't1', fetch: FETCH, summary: '{count} x' })}\n\`\`\`\n{"none":true}`,
      [{ containerId: 't1', fieldKeys: ['name', 'birthday'] }],
      ALLOWED,
    );
    assert.ok(plan.ok);
  });
});
