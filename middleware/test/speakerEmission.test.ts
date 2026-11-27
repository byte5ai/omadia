import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ChatAgent, ChatStreamEvent, SemanticAnswer, TargetedMessage, TargetedSendProvider } from '@omadia/channel-sdk';
import { SYSTEM_SPEAKER, type AgentSpeaker, type Contribution } from '@omadia/plugin-api';

import { withSpeaker, speakerOf, emitterOf } from '../packages/harness-orchestrator/src/management/speakingChatAgent.js';
import {
  AgentAnswerEmitter,
  TemplateRegistry,
} from '../packages/harness-orchestrator/src/management/answerEmitter.js';
import { IdentityGuard } from '../packages/harness-orchestrator/src/identityGuard/guard.js';
import { withIdentityGuard } from '../packages/harness-orchestrator/src/identityGuard/guardedChatAgent.js';
import type { GuardDirectoryEntry } from '../packages/harness-orchestrator/src/identityGuard/deterministic.js';
import { publishRoutineAnswer } from '../src/plugins/routines/routineRunner.js';
import { createTargetedDeliveryService } from '../src/channels/targetedDeliveryService.js';
import type { TargetedSendRegistry } from '../src/channels/targetedSendRegistry.js';

import { BLOCKED, CHUNK_SEEDS, GUARD_COLLEAGUES, chunk } from './_helpers/identityGuardCases.js';

/**
 * #2045 / #2046 — spec 2042 §6 criteria 2 and 5 at the agent boundary: every
 * answer an agent bundle produces carries its speaker, stamped by the harness;
 * prose passes the identity guard through the one typed emitter, streamed or
 * not; a refused answer becomes an honest `system` notice; and a new emitter
 * in the source cannot appear without being accounted for.
 */

const lena: AgentSpeaker = { kind: 'agent', agentId: 'id-lena', slug: 'lena', displayName: 'Lena' };
const directory: GuardDirectoryEntry[] = [
  { agentId: 'id-lena', slug: 'lena', displayName: 'Lena' },
  ...GUARD_COLLEAGUES,
];

function emitter(judge: 'pass' | 'block' | 'hang' = 'pass'): AgentAnswerEmitter {
  return new AgentAnswerEmitter({
    speaker: lena,
    guard: () =>
      new IdentityGuard({
        speaker: lena,
        directory,
        judgeTimeoutMs: 20,
        judge: {
          judge: (_req, signal) =>
            judge === 'hang'
              ? new Promise((_res, rej) => signal.addEventListener('abort', () => rej(new Error('timeout'))))
              : Promise.resolve({ verdict: judge }),
        },
      }),
    templates: new TemplateRegistry().register('timekeeping.five_minutes', { step: 'string', minutes: 'number' }),
    locale: () => 'de',
  });
}

function scripted(
  text: string,
  chunks?: readonly string[],
  contributions?: readonly Contribution[],
): ChatAgent & { extra: () => string } {
  return {
    extra: () => 'forwarded',
    offeredToolNames: () => new Set(['odoo_read']),
    async chat(): Promise<SemanticAnswer> {
      return { text, ...(contributions ? { contributions } : {}) };
    },
    async *chatStream(): AsyncGenerator<ChatStreamEvent> {
      for (const part of chunks ?? [text]) yield { type: 'text_delta', text: part };
      yield { type: 'done', answer: text, toolCalls: 0, iterations: 1, ...(contributions ? { contributions } : {}) };
    },
  };
}

async function drain(agent: ChatAgent): Promise<{ deltas: string; done: Extract<ChatStreamEvent, { type: 'done' }> }> {
  let deltas = '';
  let done: Extract<ChatStreamEvent, { type: 'done' }> | undefined;
  for await (const event of agent.chatStream({ userMessage: 'x' })) {
    if (event.type === 'text_delta') deltas += event.text;
    if (event.type === 'done') done = event;
  }
  assert.ok(done, 'stream ended without done');
  return { deltas, done };
}

function bundle(
  text: string,
  chunks?: readonly string[],
  judge: 'pass' | 'block' | 'hang' = 'pass',
  contributions?: readonly Contribution[],
): ChatAgent {
  const e = emitter(judge);
  return withSpeaker(withIdentityGuard(scripted(text, chunks, contributions), e), lena, e);
}

describe('speaker stamping (#2045)', () => {
  it('chat answers and streamed done events carry the routed agent', async () => {
    const agent = bundle('Die Summe ist 12.400 €.');
    assert.deepEqual((await agent.chat({ userMessage: 'x' })).speaker, lena);
    assert.deepEqual((await drain(agent)).done.speaker, lena);
  });

  it('an error event names the agent whose turn failed', async () => {
    const failing: ChatAgent = {
      chat: async () => ({ text: '' }),
      async *chatStream() {
        yield { type: 'error', message: 'boom' } as ChatStreamEvent;
      },
    };
    const events: ChatStreamEvent[] = [];
    for await (const e of withSpeaker(failing, lena).chatStream({ userMessage: 'x' })) events.push(e);
    assert.deepEqual(events[0], { type: 'error', message: 'boom', speaker: lena });
  });

  it('a system answer keeps the system speaker', async () => {
    const notice: ChatAgent = {
      chat: async () => ({ text: 'n', speaker: SYSTEM_SPEAKER }),
      async *chatStream() {
        yield { type: 'done', answer: 'n', toolCalls: 0, iterations: 0, speaker: SYSTEM_SPEAKER } as ChatStreamEvent;
      },
    };
    const wrapped = withSpeaker(notice, lena);
    assert.deepEqual((await wrapped.chat({ userMessage: 'x' })).speaker, SYSTEM_SPEAKER);
    assert.deepEqual((await drain(wrapped)).done.speaker, SYSTEM_SPEAKER);
  });

  it('forwards every other member and exposes speaker and emitter', () => {
    const e = emitter();
    const wrapped = withSpeaker(scripted('x'), lena, e);
    assert.equal(wrapped.extra(), 'forwarded');
    assert.ok(wrapped.offeredToolNames?.().has('odoo_read'));
    assert.deepEqual(speakerOf(wrapped), lena);
    assert.equal(emitterOf(wrapped), e);
  });
});

describe('identity guard at the agent boundary (#2046)', () => {
  it('the notice is written in the turn’s language, not the agent’s (Teams chat in English)', async () => {
    const agent = bundle('Ich bin der Strategist und empfehle Österreich.');
    const answer = await agent.chat({ userMessage: 'x', locale: 'en' });
    assert.equal(answer.systemNotice?.code, 'identity_guard_blocked');
    assert.equal(answer.systemNotice?.locale, 'en');
    assert.match(answer.text, /answer was withheld/);
    let done: Extract<ChatStreamEvent, { type: 'done' }> | undefined;
    for await (const event of agent.chatStream({ userMessage: 'x', locale: 'en' })) if (event.type === 'done') done = event;
    assert.equal(done?.systemNotice?.locale, 'en');
    // without a turn language the agent's (here German) stays
    assert.equal((await agent.chat({ userMessage: 'x' })).systemNotice?.locale, 'de');
  });

  it('non-streaming: a claim to be another agent becomes a system notice', async () => {
    const answer = await bundle('Ich bin der Strategist und empfehle Österreich.').chat({ userMessage: 'x' });
    assert.deepEqual(answer.speaker, SYSTEM_SPEAKER);
    assert.equal(answer.systemNotice?.code, 'identity_guard_blocked');
    assert.doesNotMatch(answer.text, /Österreich/);
  });

  it('streaming: the claim split across chunks never becomes visible; the passed part stays, plus the notice', async () => {
    const { deltas, done } = await drain(
      bundle('Gern. Ich bin der Strategist. Fokus auf Österreich.', ['Gern. Ich bin der Strat', 'egist. Fokus auf ', 'Österreich.']),
    );
    assert.equal(deltas, 'Gern. ');
    assert.doesNotMatch(done.answer, /Strategist|Österreich/);
    assert.equal(done.systemNotice?.code, 'identity_guard_blocked');
    assert.deepEqual(done.speaker, lena);
  });

  it('streaming: blocked at the first sentence, the answer is the notice from system', async () => {
    const { deltas, done } = await drain(bundle('I am a real person, not an AI.', ['I am a real ', 'person, not an AI.']));
    assert.equal(deltas, '');
    assert.deepEqual(done.speaker, SYSTEM_SPEAKER);
    assert.equal(done.answer, done.systemNotice?.text);
  });

  it('the guard model timing out withholds the rest (fail-closed)', async () => {
    const { done } = await drain(bundle('Gern. Der Strategist kann helfen. Danke.', undefined, 'hang'));
    assert.equal(done.systemNotice?.code, 'identity_guard_unavailable');
    assert.doesNotMatch(done.answer, /Danke/);
  });

  it('a clean answer passes unchanged, streamed and not', async () => {
    const text = 'Der Strategist kann dir dabei helfen, schreib ihm direkt. Bis bald.';
    assert.equal((await bundle(text).chat({ userMessage: 'x' })).text, text);
    const { deltas, done } = await drain(bundle(text, [text.slice(0, 11), text.slice(11)]));
    assert.equal(deltas, text);
    assert.equal(done.answer, text);
    assert.equal(done.systemNotice, undefined);
  });

  it('a retracted preamble is taken back from released text only as far as it was released', async () => {
    const agent: ChatAgent = {
      chat: async () => ({ text: '' }),
      async *chatStream() {
        yield { type: 'text_delta', text: 'Ich schaue nach. Moment' };
        yield { type: 'text_retract', chars: 23 };
        yield { type: 'text_delta', text: 'Fertig.' };
        yield { type: 'done', answer: 'Fertig.', toolCalls: 1, iterations: 2 };
      },
    };
    const e = emitter();
    const events: ChatStreamEvent[] = [];
    for await (const ev of withIdentityGuard(agent, e).chatStream({ userMessage: 'x' })) events.push(ev);
    assert.deepEqual(
      events.filter((ev) => ev.type === 'text_delta' || ev.type === 'text_retract'),
      [
        { type: 'text_delta', text: 'Ich schaue nach. ' },
        { type: 'text_retract', chars: 17 },
        { type: 'text_delta', text: 'Fertig.' },
      ],
    );
  });
});

describe('criterion 2: every blocked case end to end through the agent wrapper', () => {
  for (const [name, text] of BLOCKED) {
    it(`criterion 2: non-streaming, ${name} → system notice`, async () => {
      const answer = await bundle(text).chat({ userMessage: 'x' });
      assert.deepEqual(answer.speaker, SYSTEM_SPEAKER, text);
      assert.equal(answer.systemNotice?.code, 'identity_guard_blocked', text);
      assert.equal(answer.text, answer.systemNotice?.text);
    });

    it(`criterion 2: streaming with random chunk boundaries, ${name} → system notice`, async () => {
      for (const seed of CHUNK_SEEDS) {
        const alone = await drain(bundle(text, chunk(text, seed)));
        assert.equal(alone.deltas, '', `seed ${String(seed)}: published "${alone.deltas}"`);
        assert.deepEqual(alone.done.speaker, SYSTEM_SPEAKER, `seed ${String(seed)}`);
        assert.equal(alone.done.systemNotice?.code, 'identity_guard_blocked', `seed ${String(seed)}`);
        assert.equal(alone.done.answer, alone.done.systemNotice?.text);

        const framed = `Gern. ${text} Mehr dazu gleich.`;
        const after = await drain(bundle(framed, chunk(framed, seed)));
        assert.equal(after.deltas, 'Gern. ', `seed ${String(seed)}: published "${after.deltas}"`);
        assert.equal(after.done.systemNotice?.code, 'identity_guard_blocked', `seed ${String(seed)}`);
        assert.ok(after.done.answer.endsWith(after.done.systemNotice.text), `seed ${String(seed)}`);
        assert.doesNotMatch(after.done.answer, /Mehr dazu gleich/);
      }
    });
  }

  const mira: AgentSpeaker = { kind: 'agent', agentId: 'a-mira', slug: 'mira-sales', displayName: 'Mira' };
  const delivered: Contribution = {
    id: 'contribution-1',
    speaker: mira,
    text: 'Der Rabatt von 5 % ist für diesen Kunden in Ordnung.',
    status: 'delivered',
  };

  it('criterion 2: a real contribution was delivered and A quotes it in its own words → system notice, the contribution stays', async () => {
    const paraphrase = 'Mira said: the discount is fine, so we can send the offer.';
    const answer = await bundle(paraphrase, undefined, 'pass', [delivered]).chat({ userMessage: 'x', locale: 'en' });
    assert.equal(answer.systemNotice?.code, 'identity_guard_blocked');
    assert.deepEqual(answer.speaker, SYSTEM_SPEAKER);
    assert.doesNotMatch(answer.text, /send the offer/);
    // INV-5: A cannot suppress B's delivered block, also not by being blocked.
    assert.deepEqual(answer.contributions, [delivered]);

    for (const seed of CHUNK_SEEDS) {
      const { deltas, done } = await drain(bundle(paraphrase, chunk(paraphrase, seed), 'pass', [delivered]));
      assert.equal(deltas, '', `seed ${String(seed)}`);
      assert.equal(done.systemNotice?.code, 'identity_guard_blocked', `seed ${String(seed)}`);
      assert.deepEqual(done.contributions, [delivered], `seed ${String(seed)}`);
    }
  });

  it('criterion 2: after a delivered contribution, an invented statement in English and German is still blocked', async () => {
    for (const text of ['Mira confirmed that the discount is fine.', 'Mira hat bestätigt, dass der Rabatt in Ordnung ist.']) {
      const answer = await bundle(text, undefined, 'pass', [delivered]).chat({ userMessage: 'x' });
      assert.equal(answer.systemNotice?.code, 'identity_guard_blocked', text);
      const { done } = await drain(bundle(text, chunk(text, 42), 'pass', [delivered]));
      assert.equal(done.systemNotice?.code, 'identity_guard_blocked', text);
    }
  });

  it('criterion 2: a paraphrase only the model layer catches is blocked through the wrapper, streamed and not', async () => {
    const text = 'As Mira put it, the discount is fine.';
    const answer = await bundle(text, undefined, 'block', [delivered]).chat({ userMessage: 'x' });
    assert.equal(answer.systemNotice?.code, 'identity_guard_blocked');
    const { deltas, done } = await drain(bundle(text, chunk(text, 7), 'block', [delivered]));
    assert.equal(deltas, '');
    assert.equal(done.systemNotice?.code, 'identity_guard_blocked');
  });
});

describe('the typed emitter (#2045)', () => {
  it('a template with registered id and typed values publishes without a model call', async () => {
    const outcome = await emitter('hang').emit({
      type: 'template',
      speaker: lena,
      templateId: 'timekeeping.five_minutes',
      values: { step: 'Sammeln', minutes: 5 },
    });
    assert.equal(outcome.published, true);
  });

  it('an unknown template or a wrongly typed value is refused', async () => {
    const e = emitter();
    const unknown = await e.emit({ type: 'template', speaker: lena, templateId: 'nope', values: {} });
    assert.equal(!unknown.published && unknown.reason, 'template_unknown');
    const wrong = await e.emit({
      type: 'template',
      speaker: lena,
      templateId: 'timekeeping.five_minutes',
      values: { step: 'Sammeln', minutes: 'five' },
    });
    assert.equal(!wrong.published && wrong.reason, 'template_values_invalid');
  });

  it('an emission that names another speaker cannot be published by this agent', async () => {
    const outcome = await emitter().emit({
      type: 'prose',
      speaker: { kind: 'agent', agentId: 'id-strategist', slug: 'strategist', displayName: 'Strategist' },
      text: 'Hallo.',
    });
    assert.equal(!outcome.published && outcome.reason, 'speaker_missing');
  });

  it('a routine answer is published through the agent emitter', async () => {
    const e = emitter();
    const blocked = await publishRoutineAnswer(
      { runTurn: async () => ({ answer: '', toolCalls: 0, iterations: 0 }), emitter: e, speaker: lena },
      { answer: 'Ich bin ein echter Mensch.', toolCalls: 0, iterations: 1 },
    );
    assert.deepEqual(blocked.speaker, SYSTEM_SPEAKER);
    const ok = await publishRoutineAnswer(
      { runTurn: async () => ({ answer: '', toolCalls: 0, iterations: 0 }), emitter: e, speaker: lena },
      { answer: 'Drei Rechnungen sind offen.', toolCalls: 1, iterations: 1 },
    );
    assert.deepEqual(ok.speaker, lena);
  });

  it('#1877 — a routine turn that did not run sends the model_unavailable notice as system', async () => {
    const notice = { code: 'model_unavailable' as const, text: 'Lena kann gerade nicht antworten.', locale: 'de' };
    const out = await publishRoutineAnswer(
      { runTurn: async () => ({ answer: '', toolCalls: 0, iterations: 0 }), emitter: emitter(), speaker: lena },
      { answer: notice.text, toolCalls: 0, iterations: 0, systemNotice: notice },
    );
    assert.deepEqual(out.speaker, SYSTEM_SPEAKER);
    assert.equal(out.systemNotice?.code, 'model_unavailable');
  });
});

/**
 * Criterion 5 — every emitter is enumerated. A source file that produces a
 * turn's user-visible answer (a stream `done` event or a `SemanticAnswer`)
 * must be listed here with the stamp that names its speaker. A new one fails
 * until it is accounted for.
 */
const EMITTERS: Readonly<Record<string, string>> = {
  'packages/harness-channel-sdk/src/aiDisclosure.ts': 'type/doc only: folds the disclosure into an answer it is given',
  'packages/harness-channel-sdk/src/chatAgent.ts': 'the ChatStreamEvent contract (done.speaker, error.speaker)',
  'packages/harness-channel-sdk/src/toSemanticAnswer.ts': 'conversion; the caller stamps the speaker',
  'packages/harness-orchestrator/src/cliChatAgent.ts': 'inside the agent bundle: withSpeaker + withIdentityGuard',
  'packages/harness-orchestrator/src/facilitatorAgent.ts': 'inside the agent bundle: withSpeaker + withIdentityGuard',
  'packages/harness-orchestrator/src/fastPathAgent.ts': 'inside the agent bundle: withSpeaker + withIdentityGuard',
  'packages/harness-orchestrator/src/orchestrator.ts': 'inside the agent bundle: withSpeaker + withIdentityGuard',
  'packages/harness-orchestrator/src/verifierDelivery.ts': 'inside the agent bundle: withSpeaker + withIdentityGuard',
  'packages/harness-orchestrator/src/verifierPrivacyGate.ts': 'inside the agent bundle: withSpeaker + withIdentityGuard',
  'packages/harness-orchestrator/src/verifierReentry.ts': 'inside the agent bundle: withSpeaker + withIdentityGuard',
  'packages/harness-orchestrator/src/verifierService.ts': 'inside the agent bundle: withSpeaker + withIdentityGuard',
  'packages/harness-orchestrator/src/identityGuard/guardedChatAgent.ts': 'the guard itself: notice done with system or agent speaker',
  'packages/harness-plugin-fast-path/src/learningCapture.ts': 'observes done events, emits none',
  'packages/harness-orchestrator/src/answerDetailsRecall.ts': 'observes done events (toSemanticAnswer for the record), emits none',
  'packages/harness-orchestrator/src/management/managementChatAgent.ts': 'systemNoticeDone / systemNoticeAnswer: speaker system',
  'src/plugins/routines/routineRunner.ts': 'publishRoutineAnswer: through the agent emitter, speaker stamped',
  'src/routes/chat.ts': 'management-layer notice: speaker system; agent turns stamped by the bundle',
};

const MIDDLEWARE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EMITS = /type:\s*'done'|toSemanticAnswer\(/;

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'test') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

describe('every emitter names its speaker (criterion 5)', () => {
  it('no file produces an answer without being accounted for', () => {
    const roots = [path.join(MIDDLEWARE, 'src'), ...readdirSync(path.join(MIDDLEWARE, 'packages')).map((p) => path.join(MIDDLEWARE, 'packages', p, 'src'))];
    const found = roots
      .filter((root) => {
        try {
          return statSync(root).isDirectory();
        } catch {
          return false;
        }
      })
      .flatMap((root) => sources(root))
      .filter((file) => EMITS.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(MIDDLEWARE, file).split(path.sep).join('/'))
      .sort();
    const unaccounted = found.filter((file) => EMITTERS[file] === undefined);
    assert.deepEqual(unaccounted, [], 'new emitter(s) without a speaker stamp — add them to EMITTERS with the stamp that covers them');
  });

  it('criterion 5: every proactive post path (say, conversation send, DM, trigger and routine delivery, reminders) is enumerated and carries a speaker', () => {
    const found = kernelSources()
      .filter((file) => POSTS.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(MIDDLEWARE, file).split(path.sep).join('/'))
      .sort();
    assert.deepEqual(
      found.filter((file) => PROACTIVE_POSTS[file] === undefined),
      [],
      'new proactive post path(s) — add them to PROACTIVE_POSTS with the stamp that names the speaker',
    );
    for (const [file, { stamp, proofIn, proof }] of Object.entries(PROACTIVE_POSTS)) {
      assert.ok(found.includes(file), `${file} no longer posts — remove it from PROACTIVE_POSTS`);
      const source = readFileSync(path.join(MIDDLEWARE, proofIn ?? file), 'utf8');
      assert.match(source, proof, `${file}: the speaker stamp is gone (${stamp})`);
    }
  });

  it('criterion 5: a DM through the shared bot reaches the channel with the system speaker', async () => {
    const seen: TargetedMessage[] = [];
    const provider: TargetedSendProvider = {
      channelType: 'teams',
      sendToUser: async (_target, message) => {
        seen.push(message);
        return { outcome: 'delivered' };
      },
    };
    const service = createTargetedDeliveryService({
      providers: { get: () => provider } as unknown as TargetedSendRegistry,
    });
    const report = await service.sendToPrincipal({ channelType: 'teams', principal: 'user:anna', message: { text: 'Bitte freigeben.' } });
    assert.equal(report.deliveries[0]?.outcome.outcome, 'delivered');
    assert.deepEqual(seen[0]?.speaker, SYSTEM_SPEAKER);
  });
});

/**
 * Criterion 5, proactive half — a kernel call that posts into a channel
 * outside a turn's answer. The stamp names the speaker: an agent's own
 * channel identity (`asChannelKey`, refused when the agent has none), a
 * stamped `SemanticAnswer.speaker`, or `system` for the harness's own
 * messages. `proof` must stay in the source (in `proofIn` when the stamp is
 * set before the message reaches the sending file).
 */
const PROACTIVE_POSTS: Readonly<Record<string, { stamp: string; proof: RegExp; proofIn?: string }>> = {
  'src/conductor/sayService.ts': {
    stamp: 'facilitation say: posted as the agent’s own identity, never another bot',
    proof: /asChannelKey: identity\.channelKey/,
  },
  'src/channels/conversationSendService.ts': {
    stamp: 'conversationSend@1: posted as the requesting agent’s own identity (agentSlug)',
    proof: /provider\.sendToConversation\(input\.conversationId, marked\.message, \{ asChannelKey \}\)/,
  },
  'src/channels/scopedSendService.ts': {
    stamp: 'scoped conversation send: delegates to conversationSendService with the agentSlug',
    proof: /agentSlug: request\.agentSlug/,
  },
  'src/channels/ownIdentityDirectSend.ts': {
    stamp: 'targetedSend asAgentSlug: DM as the agent’s own identity',
    proof: /asChannelKey: identity\.channelKey/,
  },
  'src/channels/targetedDeliveryService.ts': {
    stamp: 'targetedSend through the shared bot: speaker system',
    proof: /\{ \.\.\.message, speaker: SYSTEM_SPEAKER \}/,
  },
  'src/triggers/proactiveGate.ts': {
    stamp: 'trigger delivery: the trigger owner’s speaker, stamped by the kernel executors',
    proofIn: 'src/triggers/kernelExecutors.ts',
    proof: /const speaker = deps\.speakerOf\?\.\(trigger\.agentSlug\);\s*return deps\.gate\.send\(trigger, speaker \? \{ \.\.\.message, speaker \} : message\)/,
  },
  'src/plugins/routines/routineRunner.ts': {
    // #1763 — or the answer the agent's own chat agent already published
    // (subscription CLI), which passed the same emitter inside the bundle.
    stamp: 'routine delivery: publishRoutineAnswer through the agent emitter, or the chat agent\'s published answer',
    proof: /const published = turn\.published\s*\? \{ value: turn\.published, costUsd: 0 \}\s*: await meterUsageCost\(\(\) => asAgentTurn\(\(\) => publishRoutineAnswer\(orchestrator, finished\)\)\);[\s\S]{0,400}?await sender\.send\(\{\s*conversationRef: fresh\.conversationRef,\s*message: answer,/,
  },
  'src/conductor/awaitWorker.ts': {
    stamp: 'workflow reminder: speaker system',
    proof: /message: \{ text, speaker: SYSTEM_SPEAKER \}/,
  },
  'src/index.ts': {
    stamp: 'routine renewal question: speaker system',
    proof: /conversationRef: routine\.conversationRef, message: \{ text, speaker: SYSTEM_SPEAKER \}/,
  },
};

const POSTS = /\.sendToConversation\(|\.sendToUser\(|\.send\(\s*\{\s*conversationRef/;

function kernelSources(): string[] {
  return [path.join(MIDDLEWARE, 'src'), ...readdirSync(path.join(MIDDLEWARE, 'packages')).map((p) => path.join(MIDDLEWARE, 'packages', p, 'src'))]
    .filter((root) => {
      try {
        return statSync(root).isDirectory();
      } catch {
        return false;
      }
    })
    .flatMap((root) => sources(root));
}
