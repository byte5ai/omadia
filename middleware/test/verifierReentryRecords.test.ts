/**
 * A verifier re-entry is part of the SAME user request: what the request
 * records, it records once.
 *
 * A borderline resample or a correction retry re-generates the answer over the
 * first run's frozen tool results. Before the replay ledger every re-entry was
 * a complete turn of its own, so beyond re-running the tools it wrote a second
 * session-log row, fired every turn hook again, ingested replayed MCP results
 * into the Knowledge Graph a second time and persisted a receipt row per run.
 * Now a re-entry:
 *  - keeps every replayed call in the run trace, flagged `replayed`;
 *  - fires no per-call turn hook of its own; the request's session-log row
 *    and `onAfterTurn` are written once, for the delivered pass
 *    (commit-on-delivery — `verifierDeliveredTurnRecord.test.ts` covers it);
 *  - ingests nothing into the Knowledge Graph for a replayed call;
 *  - persists no receipt row of its own — the request has ONE row, written
 *    once, whose receipt covers every pass (the egress of the resample and the
 *    retry included), and the delivered answer carries that receipt.
 *
 * Drives the REAL `Orchestrator` under the REAL `VerifierService`. All values
 * are synthetic.
 */

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import type {
  KnowledgeGraph,
  NativeToolAttachment,
  PrivacyGuardService,
  TurnReceiptRecordInput,
} from '@omadia/plugin-api';

import { setMcpKgIngestServers } from '../packages/harness-orchestrator/src/mcpKgIngest.js';
import { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import type { OrchestratorOptions } from '../packages/harness-orchestrator/src/orchestrator.js';
import type { SessionLogger } from '../packages/harness-orchestrator/src/sessionLogger.js';
import type { DomainTool } from '../packages/harness-orchestrator/src/tools/domainQueryTool.js';
import type { TurnHookRunner } from '../packages/harness-orchestrator/src/turnHooks.js';
import {
  REQUEST,
  doneOf,
  drain,
  maskingPrivacy,
  registerWriteTool,
  text,
  toolCalls,
  verifiedTurn,
} from './_helpers/replayTurnFixture.js';
import { approved, blocked } from './_helpers/verifierVerdictFixtures.js';

const INVOICE = { customer: 'K-1001', amount: 1200, currency: 'EUR' };
const CREATED = 'Rechnung INV/2026/0042 über 1.200 EUR angelegt.';
const ANSWER = 'Die Rechnung INV/2026/0042 über 1.200 EUR ist angelegt.';
const CONTRADICTED_ANSWER = 'Die Rechnung INV/2026/0042 über 1.250 EUR ist angelegt.';

const twoRuns = () => [
  toolCalls(['create_invoice', INVOICE]),
  text(ANSWER),
  toolCalls(['create_invoice', INVOICE]),
  text(ANSWER),
];

function invoiceRegistry(): NativeToolRegistry {
  const registry = new NativeToolRegistry();
  registerWriteTool(registry, 'create_invoice', () => Promise.resolve(CREATED));
  return registry;
}

describe('a verifier re-entry records as part of the same request', () => {
  it('a replayed call stays in the run trace, flagged replayed', async () => {
    const t = verifiedTurn({
      registry: invoiceRegistry(),
      responses: twoRuns(),
      verdicts: [blocked(), approved()],
    });

    const terminal = doneOf(await drain(t.service.chatStream(REQUEST)));

    const calls = terminal?.runTrace?.orchestratorToolCalls ?? [];
    assert.equal(calls.length, 1, 'the replayed call is in the delivered trace');
    assert.equal(calls[0]?.toolName, 'create_invoice');
    assert.equal(calls[0]?.replayed, true);
  });

  it('turn hooks fire for the request, not again for its re-entry', async () => {
    const points: string[] = [];
    const turnHookRegistry: TurnHookRunner = {
      run(point) {
        points.push(point);
        return Promise.resolve([]);
      },
    };
    const t = verifiedTurn({
      registry: invoiceRegistry(),
      responses: twoRuns(),
      verdicts: [blocked(), approved()],
      orchestrator: { turnHookRegistry },
    });

    const sa = await t.service.chat(REQUEST);

    assert.deepEqual(sa.verifier, { status: 'corrected' }, 'the retry ran and was delivered');
    // The block is recorded after the request's onAfterTurn, as it was after
    // the first run's: the plan-runner marks the step onAfterTurn finished.
    assert.deepEqual(points, ['onBeforeTurn', 'onAfterToolCall', 'onAfterTurn', 'onVerifierBlocked']);
  });

  it('the session log records the request once, with the delivered answer', async () => {
    const logged: string[] = [];
    const sessionLogger = {
      log(entry: { assistantAnswer: string }) {
        logged.push(entry.assistantAnswer);
        return Promise.resolve({ turnExternalId: `turn-${String(logged.length)}` });
      },
    } as unknown as SessionLogger;
    const t = verifiedTurn({
      registry: invoiceRegistry(),
      // The first answer is contradicted; the retry's is delivered.
      responses: [
        toolCalls(['create_invoice', INVOICE]),
        text(CONTRADICTED_ANSWER),
        toolCalls(['create_invoice', INVOICE]),
        text(ANSWER),
      ],
      verdicts: [blocked(), approved()],
      orchestrator: { sessionLogger },
    });

    const sa = await t.service.chat(REQUEST);

    assert.equal(t.model.requests.length, 4, 'the retry ran');
    assert.deepEqual(sa.verifier, { status: 'corrected' });
    assert.deepEqual(logged, [ANSWER], 'one row, holding the answer the user got');
  });

  it('one receipt row per request, and the delivered answer carries the receipt of every pass', async () => {
    const registry = new NativeToolRegistry();
    // Bypassed by the operator: its raw result reaches the model on every
    // pass, and the receipt must say so.
    const lookups: unknown[] = [];
    registry.register('lookup_partner', {
      handler: (input: unknown) => {
        lookups.push(input);
        return Promise.resolve('{"partner":"K-1001","city":"Musterstadt"}');
      },
      spec: {
        name: 'lookup_partner',
        description: 'lookup (test)',
        input_schema: { type: 'object' as const, properties: {}, required: [] },
      } as never,
      agentId: 'test.crm',
      readConfig: (key: string) => (key === '_privacy_mode' ? 'bypass' : undefined),
    });
    registerWriteTool(registry, 'create_invoice', () => Promise.resolve(CREATED));
    const rows: TurnReceiptRecordInput[] = [];
    const privacy = maskingPrivacy();
    const both = () => [
      toolCalls(['lookup_partner', { partner: 'K-1001' }], ['create_invoice', INVOICE]),
      text(ANSWER),
    ];
    const t = verifiedTurn({
      registry,
      responses: [...both(), ...both()],
      verdicts: [blocked(), approved()],
      orchestrator: {
        privacyGuard: () => privacy.service,
        turnReceiptStore: () => ({
          record(entry: TurnReceiptRecordInput) {
            rows.push(entry);
            return Promise.resolve();
          },
        }),
      } as Partial<OrchestratorOptions>,
    });

    const sa = await t.service.chat(REQUEST);

    assert.equal(lookups.length, 1, 'the lookup ran once');
    assert.equal(privacy.finalized.length, 2, 'both passes finalized their privacy state');
    assert.equal(rows.length, 1, 'one receipt row for one request');
    const row = rows[0]?.receipt;
    assert.deepEqual(row?.bypassedTools?.map((b) => b.toolName), ['lookup_partner']);
    assert.ok((row?.datasetsInterned ?? 0) >= 1, 'the interned result is accounted for');
    assert.deepEqual(sa.privacyReceipt, row, 'the delivered answer carries the request’s receipt');
  });
});

/**
 * `maskingPrivacy` whose every receipt names its turn in `verbsExecuted`, so
 * the request's merged receipt shows which passes it covers.
 */
function passTaggingPrivacy(): { service: PrivacyGuardService; finalized: string[] } {
  const inner = maskingPrivacy();
  const service = {
    ...inner.service,
    async finalizeTurn(turnId: string, turnInput?: string) {
      const receipt = await inner.service.finalizeTurn(turnId, turnInput);
      return receipt === undefined ? undefined : { ...receipt, verbsExecuted: [`pass:${turnId}`] };
    },
  } as PrivacyGuardService;
  return { service, finalized: inner.finalized };
}

function receiptRows(rows: TurnReceiptRecordInput[]): Partial<OrchestratorOptions> {
  return {
    turnReceiptStore: () => ({
      record(entry: TurnReceiptRecordInput) {
        rows.push(entry);
        return Promise.resolve();
      },
    }),
  } as Partial<OrchestratorOptions>;
}

describe('a pass that never delivers keeps its receipt in the request’s row', () => {
  // The retry replays the first run's write (its model saw the result again,
  // so the shield acted in that pass), then fails before it has an answer.
  const retryThatFails = () => [
    toolCalls(['create_invoice', INVOICE]),
    text(CONTRADICTED_ANSWER),
    toolCalls(['create_invoice', INVOICE]),
  ];

  it('MUTATION CHECK: a correction retry that throws on chat()', async () => {
    const rows: TurnReceiptRecordInput[] = [];
    const privacy = passTaggingPrivacy();
    const t = verifiedTurn({
      registry: invoiceRegistry(),
      responses: retryThatFails(),
      verdicts: [blocked()],
      orchestrator: { privacyGuard: () => privacy.service, ...receiptRows(rows) },
    });

    const sa = await t.service.chat(REQUEST);

    assert.equal(t.model.requests.length, 4, 'the retry ran and failed on its second model call');
    assert.equal(privacy.finalized.length, 2, 'both passes finalized their privacy state');
    assert.equal(rows.length, 1, 'one receipt row for one request');
    assert.deepEqual(
      new Set(rows[0]?.receipt.verbsExecuted),
      new Set(privacy.finalized.map((id) => `pass:${id}`)),
      'the failed retry’s receipt is in the request’s row',
    );
    assert.deepEqual(sa.privacyReceipt, rows[0]?.receipt);
  });

  it('MUTATION CHECK: a stream retry the client leaves', async () => {
    const rows: TurnReceiptRecordInput[] = [];
    const privacy = passTaggingPrivacy();
    const t = verifiedTurn({
      registry: invoiceRegistry(),
      responses: [...retryThatFails(), text(ANSWER)],
      verdicts: [blocked(), approved()],
      orchestrator: { privacyGuard: () => privacy.service, ...receiptRows(rows) },
    });

    // Iterations 0 and 1 are the first run's, 2 and 3 the retry's: the
    // client leaves once the retry replayed the write.
    let iterations = 0;
    for await (const event of t.service.chatStream(REQUEST)) {
      if (event.type === 'iteration_start') iterations += 1;
      if (iterations === 4) break;
    }

    assert.equal(privacy.finalized.length, 2, 'both passes finalized their privacy state');
    assert.equal(rows.length, 1, 'one receipt row for one request');
    assert.deepEqual(
      new Set(rows[0]?.receipt.verbsExecuted),
      new Set(privacy.finalized.map((id) => `pass:${id}`)),
      'the abandoned retry’s receipt is in the request’s row',
    );
  });
});

describe('a replayed tool keeps what its first run attached', () => {
  it('a delivered retry carries the file the first run built, built once', async () => {
    const REPORT_URL = 'https://files.example/report-2026-09.xlsx';
    const registry = new NativeToolRegistry();
    const builds: unknown[] = [];
    let pending: NativeToolAttachment[] = [];
    registry.register('build_report', {
      handler: (input: unknown) => {
        builds.push(input);
        pending.push({
          kind: 'file',
          payload: { url: REPORT_URL, altText: 'Monatsbericht', mediaType: 'application/vnd.ms-excel' },
        });
        return Promise.resolve('Bericht erstellt.');
      },
      spec: {
        name: 'build_report',
        description: 'builds a report file (test)',
        input_schema: { type: 'object' as const, properties: {}, required: [] },
      } as never,
      // Drained once per pass, like the office and diagram plugins.
      attachmentSink: () => {
        if (pending.length === 0) return undefined;
        const out = pending;
        pending = [];
        return out;
      },
    });
    const run = () => [toolCalls(['build_report', { month: '2026-09' }]), text(ANSWER)];
    const t = verifiedTurn({
      registry,
      responses: [...run(), ...run()],
      verdicts: [blocked(), approved()],
    });

    const sa = await t.service.chat(REQUEST);

    assert.equal(builds.length, 1, 'the file was built once');
    assert.deepEqual(sa.verifier, { status: 'corrected' }, 'the retry was delivered');
    assert.deepEqual(
      (sa.attachments ?? []).map((a) => a.url),
      [REPORT_URL],
      'the delivered retry still carries the file',
    );
  });
});

describe('a replayed MCP result is not ingested into the Knowledge Graph again', () => {
  afterEach(() => {
    setMcpKgIngestServers([]);
  });

  it('MUTATION CHECK: one Knowledge-Graph row for one request', async () => {
    setMcpKgIngestServers(['srv-crm']);
    const ingested: unknown[] = [];
    const knowledgeGraph = new Proxy(
      {
        createMemorableKnowledge: (row: unknown) => {
          ingested.push(row);
          return Promise.resolve({ id: `mk-${String(ingested.length)}` });
        },
      } as Record<string, unknown>,
      {
        get: (target, prop: string) =>
          prop in target ? target[prop] : () => Promise.resolve(undefined),
      },
    ) as unknown as KnowledgeGraph;
    const crmLookups: unknown[] = [];
    const crm: DomainTool = {
      name: 'crm_find_customer',
      spec: {
        name: 'crm_find_customer',
        description: 'CRM lookup (test MCP tool)',
        input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      },
      domain: 'mcp.crm',
      mcpServerId: 'srv-crm',
      mcpServerName: 'CRM',
      handle: (input: unknown) => {
        crmLookups.push(input);
        return Promise.resolve('{"customer":"K-1001","segment":"B"}');
      },
    } as DomainTool;
    const privacy = maskingPrivacy();
    const run = () => [toolCalls(['crm_find_customer', { q: 'K-1001' }]), text(ANSWER)];
    const t = verifiedTurn({
      responses: [...run(), ...run()],
      verdicts: [blocked(), approved()],
      orchestrator: {
        domainTools: [crm],
        knowledgeGraph,
        privacyGuard: () => privacy.service,
      } as Partial<OrchestratorOptions>,
    });

    await t.service.chat({ ...REQUEST, userId: 'user-1' });

    assert.equal(t.model.requests.length, 4, 'the retry ran');
    assert.equal(crmLookups.length, 1, 'the MCP tool ran once');
    assert.equal(ingested.length, 1, 'one Knowledge-Graph row for one request');
  });
});
