/**
 * Zero-LLM answer cache (@omadia/fast-path answerCache.ts,
 * answerCacheShape.ts, triageTurn.ts, service.ts): a turn that repeats a
 * question shape the fast path already answered skips BOTH triage calls
 * (router + planner); slots are filled from the new question; any doubt
 * falls through to the normal router/planner path; a cached plan that
 * misses is evicted; nothing personal is persisted.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { PluginContext, PrivacyGuardService, PrivacyPromptMaskResult } from '@omadia/plugin-api';

import {
  CHAT_AGENT_SERVICE,
  type ChatAgentBundle,
  type ChatStreamEvent,
  type ChatTurnInput,
} from '../packages/harness-channel-sdk/src/index.js';

import {
  ANSWER_CACHE_PATH,
  createAnswerCache,
  onlySentinelsMasked,
  type AnswerCache,
} from '../packages/harness-plugin-fast-path/src/answerCache.js';
import {
  buildCacheShape,
  fillShape,
  isFollowUpShaped,
} from '../packages/harness-plugin-fast-path/src/answerCacheShape.js';
import { PERSON_CANARY } from '../packages/harness-plugin-fast-path/src/exampleMasking.js';
import type { FastLlm } from '../packages/harness-plugin-fast-path/src/fastPath.js';
import type { PlanMemory } from '../packages/harness-plugin-fast-path/src/learnedPlanStore.js';
import { PLANNER_TOOL } from '../packages/harness-plugin-fast-path/src/planner.js';
import { resolveRecipeInput } from '../packages/harness-plugin-fast-path/src/refreshRecipes.js';
import { ROUTER_TOOL } from '../packages/harness-plugin-fast-path/src/router.js';
import { createFastPathService, FAST_PATH_SERVICE, type FastPathService } from '../packages/harness-plugin-fast-path/src/service.js';
import { validatePlannedQuery, type PlannedQuery } from '../packages/harness-plugin-fast-path/src/triage.js';
import { triageTurn } from '../packages/harness-plugin-fast-path/src/triageTurn.js';
import { activate } from '../packages/omadia-ui-orchestrator/src/plugin.js';

// ── fixtures ──────────────────────────────────────────────────────────────

const ODOO = new Set(['odoo_query']);

/** The planner's answer for "Offene Posten von <name>" (or overdue). */
function planInput(question: string): Record<string, unknown> {
  const overdue = /überfällig/i.test(question);
  const name = /\bvon\s+(.+?)[?.!]*$/i.exec(question)?.[1];
  const domain: unknown[] = [
    ['move_type', '=', 'out_invoice'],
    ['state', '=', 'posted'],
    ['payment_state', 'in', ['not_paid', 'partial']],
  ];
  if (overdue) domain.push(['invoice_date_due', '<', '{today}']);
  if (name !== undefined) domain.push(['partner_id.name', 'ilike', name]);
  return {
    tool: 'odoo_query',
    input: {
      model: 'account.move',
      domain,
      fields: ['name', 'partner_id', 'invoice_date_due', 'amount_residual', 'currency_id'],
      limit: 100,
      order: 'invoice_date_due asc',
    },
    map: { number: 'name', partner: 'partner_id.1', due: 'invoice_date_due', open: 'amount_residual' },
    rowKey: 'id',
    itemsPath: 'records',
    labels: { number: 'Rechnungsnr.', partner: 'Kunde', due: 'Fällig am', open: 'Offener Betrag' },
    summary: name !== undefined ? `{count} offene Posten von ${name}.` : '{count} offene Posten.',
    locale: 'de-DE',
  };
}

/** A validated PlannedQuery as the planner would return it. */
function planned(question: string): PlannedQuery {
  const { tool, input, map, rowKey, itemsPath, ...rest } = planInput(question);
  const v = validatePlannedQuery({ ...rest, fetch: { tool, input, map, rowKey, itemsPath } }, ODOO);
  assert.ok(v.ok);
  return v.plan;
}

const odooOutput = (records: unknown[]): string =>
  JSON.stringify({ model: 'account.move', count: records.length, truncated: false, records });
const INVOICES = [
  { id: 7, name: 'INV/7', partner_id: [3, 'X'], invoice_date_due: '2026-01-10', amount_residual: 100, currency_id: [1, 'EUR'] },
  { id: 8, name: 'INV/8', partner_id: [3, 'X'], invoice_date_due: '2026-02-10', amount_residual: 50, currency_id: [1, 'EUR'] },
];

function memory(): PlanMemory & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readFile: (p) => Promise.resolve(files.get(p) ?? ''),
    writeFile: (p, c) => {
      files.set(p, c);
      return Promise.resolve();
    },
    exists: (p) => Promise.resolve(files.has(p)),
  };
}

/** A privacy guard whose C1 finds the canary's names and `personIn`. */
function guard(opts: { personIn?: string } = {}): PrivacyGuardService {
  const person = (text: string): boolean =>
    text === PERSON_CANARY || (opts.personIn !== undefined && text.includes(opts.personIn));
  return {
    openStoredTextScope: () => ({
      maskStoredText: (text: string): Promise<PrivacyPromptMaskResult> =>
        Promise.resolve({
          outcome: 'masked',
          maskedText: text,
          spans: person(text) ? [{ type: 'person', detector: 'c1-test' }] : [],
          degraded: false,
        }),
      restoreStoredText: (text: string) => text,
    }),
  } as unknown as PrivacyGuardService;
}

/** Router: always deterministic odoo_query; planner: planInput(turn). */
function fakeLlm(): { llm: FastLlm; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    llm: {
      complete: (req) => {
        const tool = req.toolChoice?.name ?? 'text';
        calls.push(tool);
        const turn = /USER TURN: (.*)$/m.exec(req.messages[0]?.content ?? '')?.[1] ?? '';
        if (tool === ROUTER_TOOL) {
          return Promise.resolve({
            text: '',
            toolCalls: [{ name: ROUTER_TOOL, input: { decision: 'deterministic', tool: 'odoo_query', confidence: 0.9 } }],
          });
        }
        return Promise.resolve({ text: '', toolCalls: [{ name: PLANNER_TOOL, input: planInput(turn) }] });
      },
    },
  };
}

interface Harness {
  service: FastPathService;
  ask: (q: string, sessionKey?: string) => ReturnType<FastPathService['triageChatTurn']>;
  calls: string[];
  invokes: Array<{ name: string; input: unknown }>;
  logs: string[];
  mem: ReturnType<typeof memory>;
  reply: { records: unknown[] | string };
}

function harness(opts: { config?: Record<string, string>; guard?: PrivacyGuardService; mem?: ReturnType<typeof memory> } = {}): Harness {
  const logs: string[] = [];
  const invokes: Array<{ name: string; input: unknown }> = [];
  const reply: Harness['reply'] = { records: INVOICES };
  const mem = opts.mem ?? memory();
  const f = fakeLlm();
  const service = createFastPathService({
    config: { get: <T>(k: string): T | undefined => opts.config?.[k] as T | undefined },
    llm: f.llm,
    model: 'class:fast',
    invoke: (name, input) => {
      invokes.push({ name, input });
      return Promise.resolve(typeof reply.records === 'string' ? reply.records : odooOutput(reply.records));
    },
    memory: mem,
    privacyGuard: () => ('guard' in opts ? opts.guard : guard()),
    privacyForced: () => false,
    log: (m) => logs.push(m),
  });
  return {
    service,
    ask: (q, sessionKey) =>
      service.triageChatTurn({
        channel: 'web',
        userMessage: q,
        permittedTools: ODOO,
        ...(sessionKey !== undefined ? { sessionKey } : {}),
      }),
    calls: f.calls,
    invokes,
    logs,
    mem,
    reply,
  };
}

const settled = async (h: Harness): Promise<void> => {
  await h.service.answerCache?.settled();
};
const lastDomain = (h: Harness): unknown[] =>
  ((h.invokes.at(-1)?.input as { domain: unknown[] } | undefined)?.domain ?? []);

// ── shape (pure) ──────────────────────────────────────────────────────────

describe('answer cache — question shape and slots', () => {
  it('a plan literal the question names becomes a slot; summary echo too', () => {
    const built = buildCacheShape('Offene Posten von Müller?', planned('Offene Posten von Müller?'));
    assert.ok(built.ok, built.ok ? '' : built.reason);
    assert.equal(built.shape.key, 'offene posten von {{text_1}}');
    assert.equal(built.shape.plan.summary, '{count} offene Posten von {{text_1}}.');
    assert.doesNotMatch(JSON.stringify(built.shape), /Müller|müller/);
  });

  it('fills slots from the new question in its own casing; multi-word values', () => {
    const built = buildCacheShape('Offene Posten von Müller', planned('Offene Posten von Müller'));
    assert.ok(built.ok);
    const filled = fillShape(built.shape, 'offene posten von Schmidt GmbH');
    assert.ok(filled.ok);
    assert.deepEqual((filled.filled.fetch.input as { domain: unknown[] }).domain.at(-1), [
      'partner_id.name',
      'ilike',
      'Schmidt GmbH',
    ]);
    assert.equal(filled.filled.summary, '{count} offene Posten von Schmidt GmbH.');
  });

  it('never fills a slot with structure words or a mismatching shape', () => {
    const built = buildCacheShape('Offene Posten von Müller', planned('Offene Posten von Müller'));
    assert.ok(built.ok);
    for (const q of ['Offene Posten von Müller im Januar', 'Offene Posten von', 'Offene Posten', 'Posten von Müller']) {
      assert.equal(fillShape(built.shape, q).ok, false, q);
    }
  });

  it('a slot the question does not name verbatim is not cacheable', () => {
    const plan = planned('Offene Posten von Müller');
    const r = buildCacheShape('Offene Posten von Mueller', plan);
    assert.deepEqual(r, { ok: false, reason: 'slot-not-in-question' });
  });

  it('relative dates: {today} tokens are kept; derived literal dates are refused', () => {
    const overdue = buildCacheShape('Überfällige Rechnungen', planned('Überfällige Rechnungen'));
    assert.ok(overdue.ok);
    assert.match(JSON.stringify(overdue.shape.plan.fetch.input), /"\{today\}"/);
    const literal = planned('Überfällige Rechnungen');
    const domain = (literal.fetch.input as { domain: unknown[][] }).domain;
    domain[domain.length - 1] = ['invoice_date_due', '<', '2026-10-29'];
    assert.deepEqual(buildCacheShape('Überfällige Rechnungen', literal), { ok: false, reason: 'derived-date' });
    // "diesen Monat" + a datePart filter would replay a stale month
    const month = { ...literal, fetch: { ...planned('Offene Posten').fetch, filter: [{ field: 'invoice_date_due', datePart: 'month' as const, eq: 10 }] } };
    assert.deepEqual(buildCacheShape('Offene Posten diesen Monat', month), { ok: false, reason: 'relative-literal-date' });
  });

  it('follow-up shaped turns are recognised', () => {
    for (const q of ['und im Februar?', 'Und von Weber?', 'davon nur die offenen', 'what about Weber', 'Februar']) {
      assert.equal(isFollowUpShaped(q), true, q);
    }
    for (const q of ['Offene Posten von Müller', 'wie viele Kunden in Berlin', 'show open invoices']) {
      assert.equal(isFollowUpShaped(q), false, q);
    }
  });
});

// ── service (chat channel) ────────────────────────────────────────────────

describe('answer cache — chat triage', () => {
  it('a repeated shape skips BOTH model calls and fills the slot', async () => {
    const h = harness();
    const first = await h.ask('Offene Posten von Müller');
    assert.equal(first.kind, 'answer');
    assert.deepEqual([...h.calls].sort(), [PLANNER_TOOL, ROUTER_TOOL].sort(), 'router + planner ran');
    await settled(h);
    assert.equal(h.service.answerCache?.entries().length, 1);

    h.calls.length = 0;
    const second = await h.ask('Offene Posten von Schmidt');
    assert.equal(second.kind, 'answer');
    assert.equal(h.calls.length, 0, 'zero llm.complete calls');
    assert.deepEqual(lastDomain(h).at(-1), ['partner_id.name', 'ilike', 'Schmidt']);
    assert.match(second.kind === 'answer' ? second.text : '', /2 offene Posten von Schmidt\./);
    assert.ok(h.logs.some((m) => /^\[fast-path\] cache hit channel=web tool=odoo_query slots=1 ms=\d+$/.test(m)));
    assert.ok(h.logs.some((m) => / via=cache/.test(m)));
    await settled(h);
    assert.equal(h.service.answerCache?.entries()[0]?.hits, 1);
  });

  it('nothing personal is persisted: no slot value, no raw question', async () => {
    const h = harness();
    await h.ask('Offene Posten von Müller');
    await settled(h);
    const file = h.mem.files.get(ANSWER_CACHE_PATH) ?? '';
    assert.ok(file.length > 0);
    assert.doesNotMatch(file, /Müller|müller/);
    assert.match(file, /offene posten von \{\{text_1\}\}/);
  });

  it('personal data outside the slots, or no privacy shield → not stored (failure-closed)', async () => {
    const withName = harness({ guard: guard({ personIn: 'Anna Schmidt' }) });
    await withName.ask('Anna Schmidt fragt: Offene Posten von Müller');
    await settled(withName);
    assert.equal(withName.service.answerCache?.entries().length, 0);
    assert.ok(withName.logs.includes('[fast-path] cache skip reason=privacy:personal-data'));

    const noShield = harness({ guard: undefined });
    await noShield.ask('Offene Posten von Müller');
    await settled(noShield);
    assert.equal(noShield.service.answerCache?.entries().length, 0);
    assert.ok(noShield.logs.includes('[fast-path] cache skip reason=privacy:privacy-unavailable'));
  });

  it('an unfillable slot falls through to router + planner', async () => {
    const h = harness();
    await h.ask('Offene Posten von Müller');
    await settled(h);
    h.calls.length = 0;
    await h.ask('Offene Posten von Müller im Januar');
    assert.equal(h.calls.length, 2);
    assert.ok(h.logs.some((m) => m.startsWith('[fast-path] cache miss channel=web reason=no-match')));
  });

  it('relative date token: the replay resolves {today} at execution, never a stored date', async () => {
    const h = harness();
    await h.ask('Überfällige Rechnungen');
    await settled(h);
    h.calls.length = 0;
    await h.ask('überfällige Rechnungen!');
    assert.equal(h.calls.length, 0);
    const today = resolveRecipeInput('{today}', new Date(), 'Europe/Berlin');
    assert.deepEqual(lastDomain(h).at(-1), ['invoice_date_due', '<', today]);
    assert.match(JSON.stringify(h.service.answerCache?.entries()[0]?.plan.fetch.input), /\{today\}/);
  });

  it('a cached plan that misses on execution is evicted', async () => {
    const h = harness();
    await h.ask('Offene Posten von Müller');
    await settled(h);
    h.reply.records = 'Error: access denied';
    const r = await h.ask('Offene Posten von Schmidt');
    assert.equal(r.kind, 'agent');
    await settled(h);
    assert.equal(h.service.answerCache?.entries().length, 0);
    assert.ok(h.logs.includes('[fast-path] cache evicted tool=odoo_query reason=tool-error'));
  });

  it('a slot-filled cached plan with no rows is a doubt: re-planned, entry kept', async () => {
    const h = harness();
    await h.ask('Offene Posten von Müller');
    await settled(h);
    h.calls.length = 0;
    h.reply.records = [];
    const r = await h.ask('Offene Posten von Niemand');
    assert.equal(h.calls.length, 2, 'router + planner ran after the doubt');
    assert.equal(r.kind, 'answer');
    assert.ok(h.logs.includes('[fast-path] cache miss channel=web reason=cache-empty-result'));
    await settled(h);
    assert.equal(h.service.answerCache?.entries().length, 1);
  });

  it('previous query: a follow-up never hits nor stores; a self-contained turn may hit', async () => {
    const h = harness();
    await h.ask('Offene Posten von Müller', 's1');
    await settled(h);
    h.calls.length = 0;
    await h.ask('Offene Posten von Schmidt', 's1');
    assert.equal(h.calls.length, 0, 'self-contained with a previous query → cache');
    await h.ask('und von Weber?', 's1');
    assert.equal(h.calls.length, 2);
    assert.ok(h.logs.some((m) => m.startsWith('[fast-path] cache miss channel=web reason=follow-up')));
    await settled(h);
    assert.equal(h.service.answerCache?.entries().length, 1, 'the follow-up plan was not stored');
  });

  it('disabled flag: no cache, both calls every turn', async () => {
    const h = harness({ config: { fast_path_answer_cache: 'false' } });
    assert.equal(h.service.answerCache, undefined);
    await h.ask('Offene Posten von Müller');
    await h.ask('Offene Posten von Müller');
    assert.equal(h.calls.length, 4);
    assert.ok(!h.logs.some((m) => m.includes('cache ')));
  });

  it('persisted entries survive a restart', async () => {
    const mem = memory();
    const a = harness({ mem });
    await a.ask('Offene Posten von Müller');
    await settled(a);
    const b = harness({ mem });
    await b.ask('Offene Posten von Weber');
    assert.equal(b.calls.length, 0);
  });
});

// ── store + triage level ──────────────────────────────────────────────────

describe('answer cache — store bounds and tool scope', () => {
  const scope = (): ReturnType<NonNullable<PrivacyGuardService['openStoredTextScope']>> =>
    guard().openStoredTextScope!({ job: 'test' });

  async function stored(cache: AnswerCache, question: string): Promise<void> {
    const r = await cache.remember({ question, plan: planned(question), previous: false, openScope: scope });
    assert.ok(r.stored, r.reason ?? 'stored');
  }

  it('LRU bound: the least recently used entry goes first', async () => {
    let t = 0;
    const cache = createAnswerCache({ log: () => {}, maxEntries: 2, now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, (t += 1))) });
    await stored(cache, 'Offene Posten von Müller');
    await stored(cache, 'Überfällige Rechnungen');
    const hit = cache.lookup({ question: 'Offene Posten von Weber', tools: ODOO, previous: false });
    assert.ok(hit.hit);
    cache.recordHit(hit.key); // Müller-shape is now the most recent
    await stored(cache, 'Offene Posten');
    assert.deepEqual(
      cache.entries().map((e) => e.key),
      ['offene posten von {{text_1}}', 'offene posten'],
    );
  });

  it('a tool this agent is not offered never runs from the cache', async () => {
    const cache = createAnswerCache({ log: () => {} });
    await stored(cache, 'Offene Posten von Müller');
    const logs: string[] = [];
    const calls: string[] = [];
    const out = await triageTurn({
      llm: {
        complete: (req) => {
          calls.push(req.toolChoice?.name ?? '');
          return Promise.resolve({
            text: '',
            toolCalls: [{ name: ROUTER_TOOL, input: { decision: 'agent_complex', confidence: 0.9 } }],
          });
        },
      },
      model: 'm',
      channel: 'web',
      question: 'Offene Posten von Weber',
      tools: [{ name: 'crm_search', spec: 'crm_search — read' }],
      offered: [],
      allowedTools: new Set(['crm_search', 'odoo_query']),
      answerCache: cache,
      log: (m) => logs.push(m),
    });
    assert.equal(out.kind, 'agent');
    assert.ok(calls.includes(ROUTER_TOOL), 'fell through to the router');
    assert.ok(logs.some((m) => m.startsWith('[fast-path] cache miss channel=web reason=tool-not-offered')));
  });
});

// ── canvas channel ────────────────────────────────────────────────────────

describe('answer cache — canvas', () => {
  const COLUMNS = [{ fieldKey: 'number', label: 'Nummer' }];
  const COMPOSER = JSON.stringify({
    tree: {
      type: 'container',
      id: 'root',
      layout: 'stack',
      children: [{ type: 'table', id: 'invoices', loading: 'skeleton', columns: COLUMNS, rows: [] }],
    },
    dataRequirements: [{ containerId: 'invoices', description: 'Offene Posten', fields: COLUMNS }],
  });

  async function canvasHarness(): Promise<{
    ask: (q: string, session: string) => Promise<ChatStreamEvent[]>;
    forced: string[];
    invokes: Array<{ name: string; input: unknown }>;
    logs: string[];
    fp: FastPathService;
  }> {
    const reg = new Map<string, unknown>();
    const logs: string[] = [];
    const forced: string[] = [];
    const invokes: Array<{ name: string; input: unknown }> = [];
    const routerPlanner = fakeLlm();
    reg.set('privacyRedact', guard());
    const ctx = {
      log: (m: string) => logs.push(m),
      services: {
        get: <T>(name: string): T | undefined => reg.get(name) as T | undefined,
        provide: (name: string, impl: unknown) => {
          reg.set(name, impl);
          return () => reg.delete(name);
        },
      },
      llm: {
        complete: (req: Parameters<FastLlm['complete']>[0]) => {
          const tool = req.toolChoice?.name;
          if (tool === ROUTER_TOOL || tool === PLANNER_TOOL) {
            forced.push(tool);
            return routerPlanner.llm.complete(req);
          }
          return Promise.resolve({ text: COMPOSER });
        },
      },
      config: { get: <T>(): T | undefined => undefined },
      memory: memory(),
      tools: {
        register: () => () => {},
        invoke: (name: string, input: unknown): Promise<string> => {
          invokes.push({ name, input });
          return Promise.resolve(odooOutput(INVOICES));
        },
      },
    } as unknown as PluginContext;
    reg.set(CHAT_AGENT_SERVICE, {
      agent: {
        offeredToolNames: () => ODOO,
        chat: () => Promise.reject(new Error('unused')),
        async *chatStream() {
          await Promise.resolve();
          yield { type: 'done', answer: 'agent', toolCalls: 0, iterations: 1 } as ChatStreamEvent;
        },
      },
    } satisfies ChatAgentBundle);
    const fp = createFastPathService({
      config: ctx.config,
      model: 'class:fast',
      memory: memory(),
      privacyGuard: () => reg.get('privacyRedact') as PrivacyGuardService,
      privacyForced: () => false,
      log: (m) => logs.push(m),
    });
    reg.set(FAST_PATH_SERVICE, fp);
    await activate(ctx);
    const agent = (reg.get('canvasChatAgent') as ChatAgentBundle).agent;
    const ask = async (q: string, session: string): Promise<ChatStreamEvent[]> => {
      const out: ChatStreamEvent[] = [];
      for await (const e of agent.chatStream({ userMessage: q, canvasSessionId: session } as ChatTurnInput)) out.push(e);
      return out;
    };
    return { ask, forced, invokes, logs, fp };
  }

  it('a repeated shape skips router + planner on the canvas; the plan binds as before', async () => {
    const h = await canvasHarness();
    await h.ask('Offene Posten von Müller', 'cs-1');
    assert.deepEqual([...h.forced].sort(), [PLANNER_TOOL, ROUTER_TOOL].sort());
    await h.fp.answerCache?.settled();
    assert.equal(h.fp.answerCache?.entries().length, 1);

    h.forced.length = 0;
    const events = await h.ask('Offene Posten von Schmidt', 'cs-2');
    assert.equal(h.forced.length, 0, 'no router/planner call');
    assert.ok(h.logs.some((m) => m.startsWith('[fast-path] cache hit channel=canvas tool=odoo_query')));
    assert.ok(h.logs.some((m) => m.startsWith('[fast-path] hit channel=canvas')));
    const domain = (h.invokes.at(-1)?.input as { domain: unknown[] }).domain;
    assert.deepEqual(domain.at(-1), ['partner_id.name', 'ilike', 'Schmidt']);
    const text = events.find((e) => e.type === 'text_delta') as { text?: string } | undefined;
    assert.equal(text?.text, '2 offene Posten von Schmidt.');
  });
});

// ── live finding v429: the person detector masks the slot SENTINEL ─────────

describe('answer cache — a span that only masked a slot sentinel is no personal data', () => {
  /** C1 like live: "von <Capitalised>" reads as a name — also the sentinel
   *  and a placeholder; `personIn` is a real name in the fixed text. */
  const liveGuard = (personIn?: string): PrivacyGuardService =>
    ({
      openStoredTextScope: () => ({
        maskStoredText: (text: string): Promise<PrivacyPromptMaskResult> => {
          let masked = text.replace(/zzslot\d+zz/g, '{{person_1}}');
          if (personIn !== undefined) masked = masked.replace(personIn, '{{person_2}}');
          const hits = masked !== text || text === PERSON_CANARY;
          return Promise.resolve({
            outcome: 'masked',
            maskedText: text === PERSON_CANARY ? '{{person_1}}' : masked,
            spans: hits ? [{ type: 'person', detector: 'c1-test' }] : [],
            degraded: false,
          });
        },
        restoreStoredText: (t: string) => t,
      }),
    }) as unknown as PrivacyGuardService;

  it('onlySentinelsMasked: fixed parts verbatim and in order', () => {
    assert.equal(onlySentinelsMasked('Posten von zzslot1zz', 'Posten von {{person_1}}'), true);
    assert.equal(onlySentinelsMasked('zzslot1zz und zzslot2zz heute', '{{a}} und {{b}} heute'), true);
    // a fixed word swallowed with the sentinel → refused
    assert.equal(onlySentinelsMasked('Posten von zzslot1zz', 'Posten {{person_1}}'), false);
    // a name in the fixed text masked too → refused
    assert.equal(onlySentinelsMasked('Frau Weber: Posten von zzslot1zz', 'Frau {{p_2}}: Posten von {{p_1}}'), false);
    // no sentinel at all → every span is real
    assert.equal(onlySentinelsMasked('Posten von Weber', 'Posten von {{p}}'), false);
  });

  it('the live question is stored although C1 flags its slot', async () => {
    const cache = createAnswerCache({ log: () => {} });
    const q = 'Zeige die offenen Posten von Europemobile GmbH';
    const r = await cache.remember({
      question: q,
      plan: planned(q),
      previous: false,
      openScope: () => liveGuard().openStoredTextScope!({ job: 'test' }),
    });
    assert.ok(r.stored, r.reason ?? 'stored');
    assert.ok(cache.lookup({ question: 'Zeige die offenen Posten von Carrera Toys GmbH', tools: ODOO, previous: false }).hit);
  });

  it('a real name OUTSIDE the slot still blocks the entry', async () => {
    const cache = createAnswerCache({ log: () => {} });
    const q = 'Frau Weber fragt: offene Posten von Europemobile GmbH';
    const r = await cache.remember({
      question: q,
      plan: planned(q),
      previous: false,
      openScope: () => liveGuard('Weber').openStoredTextScope!({ job: 'test' }),
    });
    assert.equal(r.stored, false);
  });
});

describe('answer cache — column headers are not run through the person detector', () => {
  it('a role-noun header C1 tags as a person ("Kunde", live) does not block the entry', async () => {
    const cache = createAnswerCache({ log: () => {} });
    const q = 'Offene Posten von Müller';
    const plan = planned(q);
    const withRoleHeader = { ...plan, labels: { ...plan.labels, partner: 'Kunde' } };
    const r = await cache.remember({
      question: q,
      plan: withRoleHeader,
      previous: false,
      openScope: () => guard({ personIn: 'Kunde' }).openStoredTextScope!({ job: 'test' }),
    });
    assert.ok(r.stored, r.reason ?? 'stored');
  });

  it('an e-mail in a header still blocks it', async () => {
    const cache = createAnswerCache({ log: () => {} });
    const q = 'Offene Posten von Müller';
    const plan = planned(q);
    const r = await cache.remember({
      question: q,
      plan: { ...plan, labels: { ...plan.labels, partner: 'a.b@example.com' } },
      previous: false,
      openScope: () => guard().openStoredTextScope!({ job: 'test' }),
    });
    assert.equal(r.stored, false);
  });
});
