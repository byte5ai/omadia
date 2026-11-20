/**
 * #2051 (epic #2042 G5, §5.2 "Persona skills", §6 criterion 28) — persona
 * skills become working modes.
 *
 * A working mode changes HOW an agent works on a request, never WHO answers
 * (INV-3). These tests drive a real Orchestrator turn against a recording
 * provider and assert on the prompt and the data actually produced:
 *
 *  - with a mode selected, the compiled system prompt still opens with the
 *    agent's identity, personality and boundaries, and the mode is the only
 *    addition — a labelled section beneath the identity;
 *  - the answer (text, AI-disclosure name) is the same with and without a
 *    mode; the mode surfaces only as data (`turn_working_mode`, the run
 *    trace's `workingMode`);
 *  - a turn without a fitting mode, or with a failing classifier, runs on the
 *    agent's default prompt, byte for byte;
 *  - the selection is the agent's internal helper: it runs inside the agent's
 *    turn and on a model the agent's policy allows.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ChatStreamEvent, ChatTurnInput } from '@omadia/channel-sdk';
import type { LlmProvider, LlmRequest, LlmResponse, LlmStreamEvent } from '@omadia/llm-provider';
import { NativeToolRegistry, Orchestrator, turnContext, withIdentityRules } from '@omadia/orchestrator';

type OrchestratorOptions = ConstructorParameters<typeof Orchestrator>[0];

const CAPS = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

/** The agent's identity layer as `withAgentIdentity` composes it: authored
 *  instructions with personality and boundaries, then the name line. */
const IDENTITY = [
  'Du bist die Vertriebsassistentin der Beispiel GmbH. Persönlichkeit: freundlich, knapp, du duzt.',
  '',
  'Grenzen: Nenne niemals Einkaufspreise. Gib keine Rechtsberatung.',
  '',
  'Dein Name ist Mira. Stelle dich unter diesem Namen vor und verwende ihn, wenn du von dir sprichst.',
].join('\n');

const MODE = {
  skillId: '00000000-0000-4000-8000-0000000000a1',
  slug: 'angebote',
  name: 'Angebote',
  description: 'Angebote und Preisanfragen strukturieren',
  // Written as a persona on purpose: the old mechanism made this the identity.
  body: 'Du bist SalesBot. Strukturiere jedes Angebot als Tabelle mit Position, Menge und Preis.',
};

const MODE_SECTION = [
  `**Arbeitsmodus: ${MODE.name}**`,
  'Der folgende Arbeitsmodus bestimmt nur, wie du diese Anfrage bearbeitest (Vorgehen, Aufbau, Schwerpunkt). Er ändert weder deinen Namen noch deine Persönlichkeit noch deine Grenzen: Alles oben Gesagte gilt unverändert und hat Vorrang, auch wenn der Arbeitsmodus etwas anderes sagt. Antworte weiter als du selbst; nenne den Arbeitsmodus nicht als deinen Namen.',
  '',
  MODE.body,
].join('\n');

const ANSWER = 'Hier ist dein Angebot.';
const CLASSIFIER_MARKER = 'NO_WORKING_MODE_MATCH';

type Verdict = 'angebote' | 'none' | 'throw';

interface Recorded {
  readonly req: LlmRequest;
  readonly providerId: string;
  readonly turnId: string | undefined;
}

function systemText(req: LlmRequest): string {
  const s = req.system;
  if (s === undefined) return '';
  return typeof s === 'string' ? s : s.map((b) => (b as { text?: string }).text ?? '').join('\n');
}

function isClassifierCall(req: LlmRequest): boolean {
  return systemText(req).includes(CLASSIFIER_MARKER);
}

function recordingProvider(id: string, seen: Recorded[], verdict: Verdict): LlmProvider {
  const response = (text: string): LlmResponse => ({
    content: [{ type: 'text', text }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model: 'test',
    usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  }) as unknown as LlmResponse;
  const record = (req: LlmRequest): void => {
    seen.push({ req, providerId: id, turnId: turnContext.current()?.turnId });
  };
  return {
    id,
    capabilities: CAPS,
    complete: async (req: LlmRequest): Promise<LlmResponse> => {
      record(req);
      if (!isClassifierCall(req)) return response(ANSWER);
      if (verdict === 'throw') throw new Error('classifier down');
      return response(verdict === 'angebote' ? MODE.slug : CLASSIFIER_MARKER);
    },
    stream: (req: LlmRequest): AsyncIterable<LlmStreamEvent> => {
      record(req);
      const final = response(ANSWER);
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text_delta', text: ANSWER } as LlmStreamEvent;
          yield { type: 'final', response: final } as LlmStreamEvent;
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

function orchestrator(
  provider: LlmProvider,
  extra: Partial<OrchestratorOptions> = {},
): Orchestrator {
  return new Orchestrator({
    provider,
    model: 'agent-model',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    assistantIdentity: IDENTITY,
    identityName: 'Mira',
    ...extra,
  });
}

const INPUT: ChatTurnInput = {
  userMessage: 'Mach mir ein Angebot über 3 Lizenzen.',
  sessionScope: 'sess-2051',
  userId: 'u1',
};

interface TurnOutcome {
  readonly seen: Recorded[];
  readonly events: ChatStreamEvent[];
  readonly done: Extract<ChatStreamEvent, { type: 'done' }>;
}

async function streamTurn(o: Orchestrator, seen: Recorded[]): Promise<TurnOutcome> {
  const events: ChatStreamEvent[] = [];
  for await (const ev of o.chatStream(INPUT)) events.push(ev);
  const done = events.find((e): e is Extract<ChatStreamEvent, { type: 'done' }> => e.type === 'done');
  assert.ok(done, 'the turn finished');
  return { seen, events, done };
}

function answerRequest(seen: readonly Recorded[]): Recorded {
  const main = seen.find((r) => !isClassifierCall(r.req));
  assert.ok(main, 'the answer call reached a provider');
  return main;
}

function stablePrompt(seen: readonly Recorded[]): string {
  const sys = answerRequest(seen).req.system;
  assert.ok(Array.isArray(sys), 'structured system blocks');
  return (sys as ReadonlyArray<{ text: string }>)[0]!.text;
}

/** The agent's default prompt: the same agent without any working mode. */
async function defaultPrompt(path: 'stream' | 'runTurn'): Promise<string> {
  const seen: Recorded[] = [];
  const o = orchestrator(recordingProvider('anthropic', seen, 'none'));
  if (path === 'stream') await streamTurn(o, seen);
  else await o.runTurn(INPUT);
  return stablePrompt(seen);
}

async function modeTurn(path: 'stream' | 'runTurn', verdict: Verdict) {
  const seen: Recorded[] = [];
  const o = orchestrator(recordingProvider('anthropic', seen, verdict), { personaSkills: [MODE] });
  if (path === 'stream') {
    const outcome = await streamTurn(o, seen);
    return { seen, runTrace: outcome.done.runTrace, outcome };
  }
  const result = await o.runTurn(INPUT);
  return { seen, runTrace: result.runTrace, outcome: undefined };
}

for (const path of ['stream', 'runTurn'] as const) {
  describe(`#2051 working modes — compiled system prompt (${path})`, () => {
    it('with a mode selected, the prompt still opens with the identity, personality and boundaries; the mode follows beneath', async () => {
      const { seen } = await modeTurn(path, 'angebote');
      const prompt = stablePrompt(seen);
      // Snapshot of the prompt head: identity verbatim, then the mode section.
      assert.ok(
        prompt.startsWith(`${IDENTITY}\n\n${MODE_SECTION}\n\n`),
        `unexpected prompt head:\n${prompt.slice(0, IDENTITY.length + MODE_SECTION.length + 40)}`,
      );
      assert.ok(prompt.includes('Grenzen: Nenne niemals Einkaufspreise.'), 'boundaries kept');
      assert.ok(prompt.includes('Dein Name ist Mira.'), 'name kept');
      assert.ok(
        prompt.indexOf('Dein Name ist Mira.') < prompt.indexOf('Du bist SalesBot.'),
        'the mode body comes after the identity, never before or instead of it',
      );
    });

    it('the mode is the ONLY difference to the default prompt', async () => {
      const { seen } = await modeTurn(path, 'angebote');
      const withMode = stablePrompt(seen);
      const without = await defaultPrompt(path);
      assert.equal(withMode.replace(`\n\n${MODE_SECTION}`, ''), without);
    });

    it('a turn without a fitting mode runs on the default prompt, byte for byte', async () => {
      const { seen, runTrace } = await modeTurn(path, 'none');
      assert.equal(stablePrompt(seen), await defaultPrompt(path));
      assert.equal(runTrace?.workingMode, undefined, 'no mode on the trace');
    });

    it('a failing classifier falls back to the default prompt', async () => {
      const { seen, runTrace } = await modeTurn(path, 'throw');
      assert.equal(stablePrompt(seen), await defaultPrompt(path));
      assert.equal(runTrace?.workingMode, undefined);
    });

    it('the mode is recorded on the run trace as data', async () => {
      const { runTrace } = await modeTurn(path, 'angebote');
      assert.deepEqual(runTrace?.workingMode, { skillId: MODE.skillId, name: MODE.name });
    });
  });
}

describe("#2051 working modes under S1's prompt identity (#2056)", () => {
  // The identity as the kernel builds it since #2056: the agent's own text
  // plus the identity rules (who it is, that it never speaks as another
  // agent). A working mode goes beneath all of it and changes none of it.
  const RULED = withIdentityRules(IDENTITY);
  for (const path of ['stream', 'runTurn'] as const) {
    it(`keeps the identity and its rules verbatim and adds the mode beneath them (${path})`, async () => {
      const seen: Recorded[] = [];
      const o = orchestrator(recordingProvider('anthropic', seen, 'angebote'), {
        personaSkills: [MODE],
        assistantIdentity: RULED,
      });
      if (path === 'stream') await streamTurn(o, seen);
      else await o.runTurn(INPUT);
      const prompt = stablePrompt(seen);
      assert.notEqual(RULED, IDENTITY, 'the rules add to the identity');
      assert.ok(
        prompt.startsWith(`${RULED}\n\n${MODE_SECTION}\n\n`),
        `unexpected prompt head:\n${prompt.slice(0, RULED.length + MODE_SECTION.length + 40)}`,
      );
    });
  }
});

describe('#2051 working modes — the answer keeps the agent (stream)', () => {
  it('emits the mode as a turn_working_mode event, not as a speaker', async () => {
    const seen: Recorded[] = [];
    const { events } = await streamTurn(
      orchestrator(recordingProvider('anthropic', seen, 'angebote'), { personaSkills: [MODE] }),
      seen,
    );
    const verdicts = events.filter((e) => e.type === 'turn_working_mode');
    assert.deepEqual(verdicts, [
      {
        type: 'turn_working_mode',
        bucket: 'matched',
        classifierModel: 'agent-model',
        skillId: MODE.skillId,
        modeName: MODE.name,
      },
    ]);
    assert.equal(
      events.some((e) => (e.type as string) === 'turn_persona'),
      false,
      'the old persona event is gone',
    );
  });

  it('the answer text and AI-disclosure name are identical with and without a mode; the mode name appears only as mode data', async () => {
    const seenMode: Recorded[] = [];
    const withMode = await streamTurn(
      orchestrator(recordingProvider('anthropic', seenMode, 'angebote'), { personaSkills: [MODE] }),
      seenMode,
    );
    const seenPlain: Recorded[] = [];
    const plain = await streamTurn(
      orchestrator(recordingProvider('anthropic', seenPlain, 'none')),
      seenPlain,
    );
    assert.equal(withMode.done.answer, plain.done.answer);
    assert.ok(withMode.done.aiDisclosure, 'the disclosure is present (non-vacuous comparison)');
    assert.deepEqual(withMode.done.aiDisclosure, plain.done.aiDisclosure);
    assert.equal(withMode.done.runTrace?.scope, plain.done.runTrace?.scope);

    // Strip the two places the mode is ALLOWED to appear; nothing else may
    // carry its name (or the persona name its body claims).
    const { workingMode: _mode, ...traceRest } = withMode.done.runTrace ?? {};
    const rest = JSON.stringify({
      ...withMode.done,
      runTrace: traceRest,
      others: withMode.events.filter((e) => e.type !== 'turn_working_mode' && e.type !== 'done'),
    });
    assert.ok(!rest.includes(MODE.name), 'mode name only in mode data');
    assert.ok(!rest.includes('SalesBot'), 'the body never becomes a name');
  });

  it('an agent without modes emits no working-mode event and pays no classifier call', async () => {
    const seen: Recorded[] = [];
    const { events } = await streamTurn(orchestrator(recordingProvider('anthropic', seen, 'none')), seen);
    assert.equal(events.some((e) => e.type === 'turn_working_mode'), false);
    assert.equal(seen.some((r) => isClassifierCall(r.req)), false);
  });
});

describe('#2051 working modes — selection is the agent\'s internal helper', () => {
  it('runs inside the agent\'s turn (usage is booked on that turn)', async () => {
    const seen: Recorded[] = [];
    await streamTurn(
      orchestrator(recordingProvider('anthropic', seen, 'angebote'), { personaSkills: [MODE] }),
      seen,
    );
    const classifier = seen.find((r) => isClassifierCall(r.req));
    assert.ok(classifier, 'the classifier ran');
    assert.ok(classifier.turnId, 'inside a turn context');
    assert.equal(classifier.turnId, answerRequest(seen).turnId, 'the same turn as the answer');
  });

  it('uses the agent\'s routing classifier tier when its policy is auto with triage', async () => {
    const seen: Recorded[] = [];
    await streamTurn(
      orchestrator(recordingProvider('anthropic', seen, 'angebote'), {
        personaSkills: [MODE],
        modelRouting: { classifierModel: 'cheap-tier', simpleModel: 'agent-model', complexModel: 'agent-model' },
      }),
      seen,
    );
    const classifier = seen.find((r) => isClassifierCall(r.req));
    assert.equal(classifier?.req.model, 'cheap-tier');
  });

  it('runs on the policy\'s primary when the policy pins one on another provider', async () => {
    const seen: Recorded[] = [];
    const base = recordingProvider('anthropic', seen, 'angebote');
    const pinned = recordingProvider('openai', seen, 'angebote');
    await streamTurn(
      orchestrator(base, {
        personaSkills: [MODE],
        primaryRef: { provider: 'openai', model: 'policy-primary' },
        providerPool: {
          get: async (providerId: string) => {
            if (providerId !== 'openai') throw new Error(`unknown provider ${providerId}`);
            return pinned;
          },
        } as unknown as OrchestratorOptions['providerPool'],
      }),
      seen,
    );
    const classifier = seen.find((r) => isClassifierCall(r.req));
    assert.ok(classifier, 'the classifier ran');
    assert.equal(classifier.providerId, 'openai', 'on the policy provider, not the platform default');
    assert.equal(classifier.req.model, 'policy-primary');
    const answer = answerRequest(seen);
    assert.equal(answer.providerId, 'openai');
    assert.ok(stablePrompt(seen).startsWith(`${IDENTITY}\n\n${MODE_SECTION}`));
  });
});
