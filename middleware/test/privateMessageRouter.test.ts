/**
 * #2089 (spec 2043 §5.3, criteria 41 and 46) — private messages to a
 * facilitator.
 *
 * A facilitator refuses private requests. The exception: a person who takes
 * part in one of its running processes gets that process's status in the
 * private chat. The kernel checks who takes part (a person target of an open
 * scope) and takes the authorization for the answer; the plugin judges what
 * the message is.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ChatAgent, ChatTurnInput } from '@omadia/channel-sdk';
import type {
  AuthorizeActionRequest,
  ExecutionAuthorizationService,
  ExecutionRefusalCode,
  PrivateMessageReply,
  PrivateMessageRequest,
} from '@omadia/plugin-api';

import { facilitatorRefusalText, wrapFacilitatorAgent } from '../packages/harness-orchestrator/src/facilitatorAgent.js';
import { PrivateMessageRouter } from '../src/channels/privateMessageRouter.js';

const ENGINE = '@omadia/agent-facilitator';
const MARA = { id: 'id-mara', slug: 'mara' };
const MESSAGE = { agent: MARA, channelType: 'teams', principalId: 'AAD-Anna', text: 'Wer fehlt noch?' };
const STATUS: PrivateMessageReply = {
  handled: true,
  text: 'Es fehlen noch Bert und Cara.',
  authorization: { scopeId: 'scope-1', processId: 'fac-7', phase: 'active', purpose: 'status', emission: 'template' },
};

function setup(options: {
  listed?: { pluginId: string; processId: string }[];
  reply?: PrivateMessageReply | (() => Promise<PrivateMessageReply>);
  refuse?: ExecutionRefusalCode;
  scopeAgent?: string;
  timeoutMs?: number;
} = {}) {
  const asked: PrivateMessageRequest[] = [];
  const authorized: AuthorizeActionRequest[] = [];
  const logs: string[] = [];
  const execution = {
    listScopes: () => Promise.resolve([{ id: 'scope-1', agentSlug: options.scopeAgent ?? 'mara', processId: 'fac-7' }]),
    authorize: (request: AuthorizeActionRequest) => {
      authorized.push(request);
      return Promise.resolve(
        options.refuse
          ? { outcome: 'refused', code: options.refuse, message: 'no' }
          : { outcome: 'authorized', authorizationId: 'a1', scopeId: request.scopeId, remaining: { actions: 1, modelCalls: 0 } },
      );
    },
  } as unknown as ExecutionAuthorizationService;
  const router = new PrivateMessageRouter({
    processesListingPerson: () => Promise.resolve(options.listed ?? [{ pluginId: ENGINE, processId: 'fac-7' }]),
    executionFor: (pluginId) => (pluginId === ENGINE ? execution : undefined),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    log: (m) => logs.push(m),
  });
  router.register(ENGINE, 'mara', (request) => {
    asked.push(request);
    const reply = options.reply ?? STATUS;
    return typeof reply === 'function' ? reply() : Promise.resolve(reply);
  });
  return { router, asked, authorized, logs };
}

describe('#2089 private message routing', () => {
  it('a participant gets the process\'s answer, authorized as a direct message to that person', async () => {
    const h = setup();
    assert.deepEqual(await h.router.route(MESSAGE), { answer: 'Es fehlen noch Bert und Cara.' });
    assert.deepEqual(h.asked, [
      { agentSlug: 'mara', channelType: 'teams', principalId: 'AAD-Anna', text: 'Wer fehlt noch?', processIds: ['fac-7'] },
    ]);
    assert.deepEqual(h.authorized, [
      {
        scopeId: 'scope-1',
        phase: 'active',
        purpose: 'status',
        action: 'direct_message',
        target: { kind: 'person', channelType: 'teams', principalId: 'AAD-Anna' },
        emission: 'template',
      },
    ]);
  });

  it('a person no open scope lists reaches no plugin at all', async () => {
    const h = setup({ listed: [] });
    assert.equal(await h.router.route(MESSAGE), undefined);
    assert.deepEqual(h.asked, []);
  });

  it('a person in several processes: the plugin is told all of them', async () => {
    const h = setup({ listed: [{ pluginId: ENGINE, processId: 'fac-7' }, { pluginId: ENGINE, processId: 'fac-9' }] });
    await h.router.route(MESSAGE);
    assert.deepEqual(h.asked[0]?.processIds, ['fac-7', 'fac-9']);
  });

  it('no answer when the plugin declines, fails, or takes too long', async () => {
    assert.equal(await setup({ reply: { handled: false } }).router.route(MESSAGE), undefined);
    assert.equal(await setup({ reply: () => Promise.reject(new Error('lease lost')) }).router.route(MESSAGE), undefined);
    const slow = setup({ reply: () => new Promise((resolve) => setTimeout(() => resolve(STATUS), 200)), timeoutMs: 20 });
    assert.equal(await slow.router.route(MESSAGE), undefined);
    assert.deepEqual(slow.authorized, [], 'nothing is drawn from the scope for an answer that never came');
  });

  it('no answer when the authorization refuses (a status-only person asking for more, a stopped scope, no budget)', async () => {
    for (const code of ['target_not_allowed', 'kill_switch', 'budget_exhausted', 'deadline_passed'] as const) {
      const h = setup({ refuse: code });
      assert.equal(await h.router.route(MESSAGE), undefined, code);
      assert.match(h.logs.join('\n'), new RegExp(`answer not authorized \\(${code}\\)`));
    }
  });

  it('the plugin cannot answer from a process the person is not listed in, or from another agent\'s scope', async () => {
    const foreign = setup({ reply: { ...STATUS, authorization: { ...STATUS.authorization, processId: 'fac-99' } } as PrivateMessageReply });
    assert.equal(await foreign.router.route(MESSAGE), undefined);
    assert.deepEqual(foreign.authorized, []);
    const otherAgent = setup({ scopeAgent: 'finn' });
    assert.equal(await otherAgent.router.route(MESSAGE), undefined);
    assert.deepEqual(otherAgent.authorized, []);
    const empty = setup({ reply: { ...STATUS, text: '   ' } as PrivateMessageReply });
    assert.equal(await empty.router.route(MESSAGE), undefined);
  });

  it('only the plugin whose process lists the person is asked, and only for its own agent', async () => {
    const h = setup({ listed: [{ pluginId: '@acme/other', processId: 'x-1' }] });
    assert.equal(await h.router.route(MESSAGE), undefined);
    assert.deepEqual(h.asked, []);
    const otherAgent = setup();
    assert.equal(await otherAgent.router.route({ ...MESSAGE, agent: { id: 'id-nora', slug: 'nora' } }), undefined);
    assert.deepEqual(otherAgent.asked, []);
  });

  it('an unregistered handler is not asked any more', async () => {
    const router = new PrivateMessageRouter({
      processesListingPerson: () => Promise.resolve([{ pluginId: ENGINE, processId: 'fac-7' }]),
      executionFor: () => undefined,
    });
    let asked = 0;
    const off = router.register(ENGINE, 'mara', () => {
      asked += 1;
      return Promise.resolve({ handled: false });
    });
    await router.route(MESSAGE);
    off();
    await router.route(MESSAGE);
    assert.equal(asked, 1);
  });
});

describe('#2089 the facilitator\'s private turn', () => {
  const inner: ChatAgent = {
    chat: () => Promise.reject(new Error('the model must not run for a private request')),
    chatStream: (() => undefined) as never,
  };
  const privateTurn: ChatTurnInput = {
    userMessage: 'Wer fehlt noch?',
    origin: {
      channelType: 'teams',
      scope: { kind: 'personal', userId: 'aad-anna' },
      principal: { kind: 'user', userId: 'aad-anna' },
    },
  } as ChatTurnInput;
  const groupTurn: ChatTurnInput = {
    userMessage: '@Mara status',
    origin: { channelType: 'teams', scope: { kind: 'group', groupId: 'g1' }, principal: { kind: 'user', userId: 'aad-anna' } },
  } as unknown as ChatTurnInput;

  it('answers a participant with the process\'s status instead of the refusal', async () => {
    const seen: unknown[] = [];
    const agent = wrapFacilitatorAgent(inner, {
      agentSlug: 'mara',
      name: 'Mara',
      privateTurn: (agentSlug, message) => {
        seen.push({ agentSlug, message });
        return Promise.resolve('Es fehlen noch Bert und Cara.');
      },
    });
    assert.equal((await agent.chat(privateTurn)).text, 'Es fehlen noch Bert und Cara.');
    assert.deepEqual(seen, [{ agentSlug: 'mara', message: { channelType: 'teams', principalId: 'aad-anna', text: 'Wer fehlt noch?' } }]);
    const events = [];
    for await (const event of agent.chatStream(privateTurn)) events.push(event);
    assert.deepEqual(events.map((e) => e.type), ['text_delta', 'done']);
    assert.equal((events[1] as { answer: string }).answer, 'Es fehlen noch Bert und Cara.');
  });

  it('gives the fixed refusal when no process takes the message, the lookup fails, or the author is unknown', async () => {
    const refusal = facilitatorRefusalText({ name: 'Mara' });
    const none = wrapFacilitatorAgent(inner, { agentSlug: 'mara', name: 'Mara', privateTurn: () => Promise.resolve(undefined) });
    assert.equal((await none.chat(privateTurn)).text, refusal);
    const failing = wrapFacilitatorAgent(inner, { agentSlug: 'mara', name: 'Mara', privateTurn: () => Promise.reject(new Error('db down')) });
    assert.equal((await failing.chat(privateTurn)).text, refusal);
    let asked = 0;
    const anonymous = wrapFacilitatorAgent(inner, {
      agentSlug: 'mara',
      name: 'Mara',
      privateTurn: () => {
        asked += 1;
        return Promise.resolve('status');
      },
    });
    const noPrincipal = { ...privateTurn, origin: { ...privateTurn.origin!, principal: undefined } } as ChatTurnInput;
    assert.equal((await anonymous.chat(noPrincipal)).text, refusal);
    assert.equal(asked, 0, 'without a platform-stated author nobody is asked');
  });

  it('is not asked for a group turn', async () => {
    let asked = 0;
    const agent = wrapFacilitatorAgent(inner, {
      agentSlug: 'mara',
      isEngineUsable: () => false,
      privateTurn: () => {
        asked += 1;
        return Promise.resolve('status');
      },
    });
    await agent.chat(groupTurn);
    assert.equal(asked, 0);
  });
});
