/**
 * A streamed turn whose consumer stops in the prelude still closes its pass.
 *
 * Before its model runs, `chatStream` installs the turn's calendar auth
 * context, replays a parked MCP call when the message answers an input card —
 * interning the replayed result into the turn's privacy state — and yields the
 * `onBeforeTurn` annotations as its first events. A consumer may stop reading
 * at any of them: a channel adapter behind `createOrchestratorDispatcher` that
 * gives up, or a client that leaves. That prelude used to run before the `try`
 * whose `finally` closes the pass, so a consumer that returned at the first
 * annotation left the pass open: the replayed real values stayed in the
 * privacy service's per-turn maps until restart, no receipt was kept, and the
 * auth context stayed installed on the calendar tools.
 *
 * Imported from SOURCE, not from the `@omadia/orchestrator` barrel (which
 * resolves to `dist/`), so the mutation check sees the code under test.
 * All values are synthetic.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { TurnReceiptRecordInput } from '@omadia/plugin-api';

import {
  InMemoryPendingMcpInputStore,
  formatMcpInputReply,
  type McpInputReplayer,
} from '../../packages/harness-orchestrator/src/mcp/pendingMcpInput.js';
import { NativeToolRegistry } from '../../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { Orchestrator } from '../../packages/harness-orchestrator/src/orchestrator.js';
import type { FindFreeSlotsTool } from '../../packages/harness-orchestrator/src/tools/findFreeSlotsTool.js';
import type { TurnHookRunner } from '../../packages/harness-orchestrator/src/turnHooks.js';
import {
  EMAIL,
  maskingPrivacy,
  scriptedModel,
  text,
  type ScriptedModel,
} from '../_helpers/replayTurnFixture.js';

const SESSION = 'sess-prelude';
const USER = 'user-prelude';
const CORRELATION_ID = 'corr-prelude';
const REPLAYED_ROW = `Personalakte: Erika Mustermann | Email: ${EMAIL}`;

interface PreludeTurn {
  readonly orchestrator: Orchestrator;
  readonly finalized: string[];
  readonly rows: TurnReceiptRecordInput[];
  /** One entry per parked MCP call the replayer ran. */
  readonly replays: string[];
  /** The calendar tool's auth-context calls, in order. */
  readonly auth: Array<'set' | 'clear'>;
  readonly model: ScriptedModel;
}

function preludeTurn(): PreludeTurn {
  const privacy = maskingPrivacy();
  const rows: TurnReceiptRecordInput[] = [];
  const replays: string[] = [];
  const auth: Array<'set' | 'clear'> = [];
  const store = new InMemoryPendingMcpInputStore();
  assert.equal(
    store.put({
      correlationId: CORRELATION_ID,
      serverId: 'srv-hr',
      serverName: 'HR',
      toolName: 'lookup_employee_record',
      originalArgs: { caseId: 'HR-7' },
      inputRequests: [{ name: 'pin', secret: true, required: true }],
      replayDepth: 0,
    }),
    'stored',
  );
  assert.ok(store.claim(CORRELATION_ID, { userId: USER, sessionId: SESSION }));
  const replayer: McpInputReplayer = {
    replay: (record) => {
      replays.push(record.toolName);
      return Promise.resolve(REPLAYED_ROW);
    },
  };
  const turnHookRegistry: TurnHookRunner = {
    run: (point) =>
      Promise.resolve(point === 'onBeforeTurn' ? [{ channel: 'plan', payload: { steps: 1 } }] : []),
  };
  const calendar = {
    setTurnContext: () => auth.push('set'),
    clearTurnContext: () => auth.push('clear'),
    takePendingCard: () => undefined,
    takeConsentRequired: () => false,
  } as unknown as FindFreeSlotsTool;
  const model = scriptedModel([text('Erledigt.')]);
  const orchestrator = new Orchestrator({
    provider: model.provider,
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 2,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    privacyGuard: () => privacy.service,
    turnReceiptStore: () => ({
      record(entry: TurnReceiptRecordInput) {
        rows.push(entry);
        return Promise.resolve();
      },
    }),
    turnHookRegistry,
    pendingMcpInput: store,
    mcpInputReplay: replayer,
    findFreeSlotsTool: calendar,
  });
  return { orchestrator, finalized: privacy.finalized, rows, replays, auth, model };
}

const CARD_ANSWER = {
  userMessage: formatMcpInputReply({ correlationId: CORRELATION_ID, inputResponses: { pin: '4321' } }),
  sessionScope: SESSION,
  userId: USER,
  ssoAssertion: 'sso-assertion-test',
};

describe('chatStream — a consumer that stops in the prelude', () => {
  it('MUTATION CHECK: returning at the first annotation after an MCP input-card replay closes the pass once', async () => {
    const t = preludeTurn();
    const stream = t.orchestrator.chatStream({ ...CARD_ANSWER });

    const first = await stream.next();
    assert.equal(first.done, false);
    assert.equal(first.value?.type, 'turn_annotation', 'the onBeforeTurn annotation comes first');
    assert.deepEqual(t.replays, ['lookup_employee_record'], 'the parked call was replayed');
    await stream.return(undefined);

    assert.equal(t.model.requests.length, 0, 'the turn stopped before its model ran');
    assert.equal(t.finalized.length, 1, 'the pass was finalized exactly once');
    assert.equal(t.rows.length, 1, 'its receipt — the interned replay — was kept');
    assert.equal(t.rows[0]?.receipt.datasetsInterned, 1);
    assert.equal(t.rows[0]?.turnId, t.finalized[0]);
    assert.deepEqual(t.auth, ['set', 'clear'], 'the turn’s auth context was cleared');
  });

  it('a stream that runs to its end still finalizes once and clears the auth context once', async () => {
    const t = preludeTurn();

    const events = [];
    for await (const event of t.orchestrator.chatStream({ ...CARD_ANSWER })) events.push(event);

    assert.ok(events.some((e) => e.type === 'done'));
    assert.equal(t.model.requests.length, 1);
    assert.equal(t.finalized.length, 1);
    assert.equal(t.rows.length, 1);
    assert.equal(t.auth.at(-1), 'clear');
    assert.equal(t.auth.filter((a) => a === 'set').length, 1);
  });
});
