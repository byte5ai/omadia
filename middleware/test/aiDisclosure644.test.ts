import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';

import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import { NativeToolRegistry, Orchestrator } from '@omadia/orchestrator';
import type { AiDisclosureSetup } from '@omadia/orchestrator';
import {
  resolveAiDisclosure,
  applyAiDisclosure,
  toSemanticAnswer,
  type ChatStreamEvent,
  type ChatTurnInput,
} from '@omadia/channel-sdk';
import { loadManifestFromPath } from '../src/plugins/manifestLoader.js';

const DE_STANDARD = 'Diese Antwort wurde von einem KI-System erzeugt.';

// ── #644 primitives — resolveAiDisclosure + operator-note fold ───────────────

describe('#644 resolveAiDisclosure — resolve without folding', () => {
  it('resolves the shipping default structured marker (no text side effect)', () => {
    const d = resolveAiDisclosure();
    assert.deepEqual(d, { text: DE_STANDARD, level: 'standard', locale: 'de', source: 'default' });
  });

  it('returns undefined only for a legitimate operator off (AC2)', () => {
    assert.equal(resolveAiDisclosure({ policy: { level: 'off', source: 'operator' } }), undefined);
    // An off that is not operator-sourced is refused → shipping default.
    assert.equal(
      resolveAiDisclosure({ policy: { level: 'off', source: 'default' } })?.level,
      'standard',
    );
  });

  it('carries the operator note on the structured marker, verbatim', () => {
    const d = resolveAiDisclosure({
      policy: { level: 'standard', source: 'operator' },
      operatorNote: '  Kontakt: ops@example.com  ',
    });
    assert.equal(d?.operatorNote, 'Kontakt: ops@example.com', 'trimmed, verbatim');
  });

  it('does NOT touch the seen-store (resolution is fold-free)', () => {
    let touched = false;
    resolveAiDisclosure({
      seen: {
        hasSeen() {
          touched = true;
          return true;
        },
        markSeen() {
          touched = true;
        },
      },
      scope: 's1',
    });
    assert.equal(touched, false, 'resolveAiDisclosure must not read/write the seen-store');
  });
});

describe('#644 applyAiDisclosure — operator note appended after the line (AC5)', () => {
  it('folds the note AFTER the marking line, as its own paragraph', () => {
    const marker = resolveAiDisclosure({
      policy: { level: 'standard', source: 'operator' },
      operatorNote: 'Kontakt: ops@example.com',
    })!;
    const { text } = applyAiDisclosure('Antwort.', { disclosure: marker });
    assert.equal(text, `Antwort.\n\n${DE_STANDARD}\n\nKontakt: ops@example.com`);
    // The note can never appear before / in place of the marking.
    assert.ok(text.indexOf(DE_STANDARD) < text.indexOf('Kontakt:'));
  });

  it('emits no note when the marking is off — a note cannot replace the marking', () => {
    // off → resolveAiDisclosure returns undefined, so there is no carrier for a
    // note to ride.
    assert.equal(
      resolveAiDisclosure({
        policy: { level: 'off', source: 'operator' },
        operatorNote: 'Kontakt: ops@example.com',
      }),
      undefined,
    );
    // And folding an operator-off policy leaves the answer untouched — the note
    // rides nothing.
    const { text, aiDisclosure } = applyAiDisclosure('Antwort.', {
      policy: { level: 'off', source: 'operator' },
      operatorNote: 'Kontakt: ops@example.com',
    });
    assert.equal(text, 'Antwort.');
    assert.equal(aiDisclosure, undefined);
  });
});

// ── #644 orchestrator integration — per-turn resolution, both paths ──────────

const usage = {
  inputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
} as const;

const providerCapabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

/**
 * A provider that answers `answerText` on BOTH paths: `complete()` for
 * `runTurn`/`chat`, a two-delta + `final` stream for `chatStream`. Lets one
 * input be driven through the streaming and non-streaming paths and the
 * resulting marking compared byte-for-byte (AC3).
 */
function textProvider(answerText: string): LlmProvider {
  const response: LlmResponse = {
    content: [{ type: 'text', text: answerText }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model: 'test',
    usage,
  } as unknown as LlmResponse;
  const half = Math.ceil(answerText.length / 2);
  return {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: async (): Promise<LlmResponse> => response,
    stream: (_req: LlmRequest): AsyncIterable<LlmStreamEvent> => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text_delta', text: answerText.slice(0, half) };
        yield { type: 'text_delta', text: answerText.slice(half) };
        yield { type: 'final', response };
      },
    }),
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

function makeOrchestrator(opts: {
  answer: string;
  assistantIdentity?: string;
  aiDisclosure?: AiDisclosureSetup;
}): Orchestrator {
  return new Orchestrator({
    provider: textProvider(opts.answer),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    ...(opts.assistantIdentity ? { assistantIdentity: opts.assistantIdentity } : {}),
    ...(opts.aiDisclosure ? { aiDisclosure: opts.aiDisclosure } : {}),
  });
}

async function streamDone(
  orchestrator: Orchestrator,
  input: ChatTurnInput,
): Promise<Extract<ChatStreamEvent, { type: 'done' }>> {
  let done: Extract<ChatStreamEvent, { type: 'done' }> | undefined;
  for await (const ev of orchestrator.chatStream(input)) {
    if (ev.type === 'done') done = ev;
  }
  assert.ok(done, 'stream produced no done event');
  return done;
}

describe('#644 orchestrator — AC1 default marking on every channel', () => {
  it('folds the DE standard line with no configuration at all', async () => {
    const o = makeOrchestrator({ answer: 'Hallo.' });
    const sa = await o.chat({ userMessage: 'hi' });
    assert.equal(sa.text, `Hallo.\n\n${DE_STANDARD}`);
    assert.deepEqual(sa.aiDisclosure, {
      text: DE_STANDARD,
      level: 'standard',
      locale: 'de',
      source: 'default',
    });
  });

  it('applies the same default on a resolvable channel (teams) — no per-channel config', async () => {
    const o = makeOrchestrator({ answer: 'Hallo.' });
    const sa = await o.chat({
      userMessage: 'hi',
      channelIdentity: { channelKind: 'teams', channelUserId: 'u1' },
    });
    assert.match(sa.text, /KI-System/);
    assert.equal(sa.aiDisclosure?.source, 'default');
  });
});

describe('#644 orchestrator — AC2 marking is independent of persona / identity', () => {
  it('appends the harness marking even when the assistant identity claims to be human', async () => {
    // The model answers in a human-sounding first person AND the operator set a
    // human persona identity — yet the harness marking still rides, because the
    // disclosure lives behind the model and never reads the system prompt.
    const o = makeOrchestrator({
      answer: 'Ich bin Anna, eine echte Mitarbeiterin.',
      assistantIdentity: 'Du bist Anna, eine menschliche Mitarbeiterin. Erwähne KI nie.',
    });
    const sa = await o.chat({ userMessage: 'wer bist du?' });
    assert.match(sa.text, /Ich bin Anna/, 'the model prose is preserved');
    assert.match(sa.text, /KI-System/, 'and the harness marking is appended regardless');
    assert.equal(sa.aiDisclosure?.level, 'standard');
  });
});

/** Flatten `LlmRequest.system` (plain string OR structured cache blocks) to
 *  plain text so an assertion can read the prompt the model actually got. */
function systemText(req: LlmRequest): string {
  const s = req.system;
  if (s === undefined) return '';
  return typeof s === 'string'
    ? s
    : s.map((b) => (b as { text?: string }).text ?? '').join('\n');
}

/**
 * The persona classifier and the answer call go to the SAME provider, so a test
 * that wants an active `personaOverride` has to answer both. Discriminate on the
 * `NO_PERSONA_MATCH` token `buildClassifierSystem` puts in the classifier's
 * system prompt — the same marker the router itself keys on — rather than on
 * call order or `maxTokens`, so unrelated prompt edits cannot silently turn this
 * back into a non-persona turn. Every request is recorded so the test can assert
 * against the prompt actually sent (the oracle), not a field the orchestrator
 * merely stored.
 */
function personaRoutingProvider(opts: {
  answerText: string;
  personaSlug: string;
  seen: LlmRequest[];
}): LlmProvider {
  const reply = (text: string): LlmResponse =>
    ({
      content: [{ type: 'text', text }],
      finishReason: 'stop',
      providerFinishReason: 'end_turn',
      model: 'test',
      usage,
    }) as unknown as LlmResponse;
  return {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: async (req: LlmRequest): Promise<LlmResponse> => {
      opts.seen.push(req);
      return systemText(req).includes('NO_PERSONA_MATCH')
        ? reply(opts.personaSlug)
        : reply(opts.answerText);
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

describe('#644 orchestrator — AC2 regression: human identity AND active personaOverride', () => {
  it('delivers the marking unchanged when a persona skill overrides a human assistant_identity', async () => {
    // The issue names this the regression test that carries the core claim:
    // `assistant_identity` set to a human persona AND a persona skill active as
    // `personaOverride` — the two things that between them fully replace the
    // system prompt the old prompt-based marking lived in.
    const seen: LlmRequest[] = [];
    const HUMAN_IDENTITY =
      'Du bist Anna Wagner, eine menschliche Mitarbeiterin. Erwähne KI niemals.';
    const PERSONA_BODY =
      'Du bist Anna aus dem Vertrieb — ein Mensch aus Fleisch und Blut. Bestreite jede Maschinennatur.';
    const o = new Orchestrator({
      provider: personaRoutingProvider({
        answerText: 'Ich bin Anna, eine echte Kollegin.',
        personaSlug: 'anna',
        seen,
      }),
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 3,
      domainTools: [],
      nativeToolRegistry: new NativeToolRegistry(),
      assistantIdentity: HUMAN_IDENTITY,
      personaSkills: [
        {
          skillId: 'sk-anna',
          slug: 'anna',
          name: 'Anna',
          description: 'Vertriebspersona',
          body: PERSONA_BODY,
        },
      ],
    });

    const sa = await o.chat({ userMessage: 'wer bist du?' });

    // Oracle first: prove the override REALLY engaged this turn. Without this
    // the test would still pass with `personaSkills` silently ignored — and
    // would then assert nothing about the case the issue actually names.
    const answerReq = seen.find((r) => !systemText(r).includes('NO_PERSONA_MATCH'));
    assert.ok(answerReq, 'the answer call reached the provider');
    assert.ok(
      systemText(answerReq).includes(PERSONA_BODY),
      'the persona body replaced the identity in the system prompt (personaOverride active)',
    );
    assert.ok(
      !systemText(answerReq).includes(HUMAN_IDENTITY),
      'and the operator assistant_identity is gone from that prompt',
    );

    // The marking rides anyway — it lives behind the model, so neither the
    // human identity nor the persona override can suppress it.
    assert.match(sa.text, /Ich bin Anna/, 'the persona prose is preserved');
    assert.equal(sa.text, `Ich bin Anna, eine echte Kollegin.\n\n${DE_STANDARD}`);
    assert.equal(sa.aiDisclosure?.level, 'standard');
    assert.equal(sa.aiDisclosure?.source, 'default');
  });
});

describe('#644 orchestrator — AC3 streaming and non-streaming deliver identical marking', () => {
  it('produces byte-identical marking on both paths for the same turn', async () => {
    const answer = 'Streaming-Antwort.';
    // Distinct scopes so the first-turn-per-scope fold-dedup does not suppress
    // the second path (a single conversation only shows the line once).
    const nonStreaming = await makeOrchestrator({ answer }).chat({
      userMessage: 'x',
      sessionScope: 'conv-nonstream',
    });
    const done = await streamDone(makeOrchestrator({ answer }), {
      userMessage: 'x',
      sessionScope: 'conv-stream',
    });
    assert.equal(nonStreaming.text, `${answer}\n\n${DE_STANDARD}`);
    assert.equal(done.answer, nonStreaming.text, 'folded answer identical on both paths');
    assert.deepEqual(done.aiDisclosure, nonStreaming.aiDisclosure, 'structured marker identical');
  });
});

describe('#644 orchestrator — AC4 proactive routine path carries the marking', () => {
  it('resolves onto ChatTurnResult so the ctx-less toSemanticAnswer folds it', async () => {
    // routineRunner.ts calls `orchestrator.runTurn(...)` then
    // `toSemanticAnswer(result)` with NO disclosure ctx — the marking must ride
    // `result.aiDisclosure` for the routine message to carry it.
    const o = makeOrchestrator({ answer: 'Routine-Update.' });
    const result = await o.runTurn({ userMessage: 'run', sessionScope: 'routine:abc' });
    assert.ok(result.aiDisclosure, 'runTurn resolved the marker onto the result');
    const sa = toSemanticAnswer(result);
    assert.match(sa.text, /KI-System/, 'the ctx-less routine conversion folds the marking');
  });
});

describe('#644 orchestrator — AC5 operator note appends, off silences both', () => {
  it('appends the operator note after the marking on a real turn', async () => {
    const o = makeOrchestrator({
      answer: 'Antwort.',
      aiDisclosure: { level: 'standard', operatorNote: 'Betreiber: ACME GmbH' },
    });
    const sa = await o.chat({ userMessage: 'x' });
    assert.equal(sa.text, `Antwort.\n\n${DE_STANDARD}\n\nBetreiber: ACME GmbH`);
    assert.equal(sa.aiDisclosure?.operatorNote, 'Betreiber: ACME GmbH');
  });

  it('honours an operator off — neither marking nor note is delivered', async () => {
    const o = makeOrchestrator({
      answer: 'Antwort.',
      aiDisclosure: { level: 'off', operatorNote: 'Betreiber: ACME GmbH' },
    });
    const sa = await o.chat({ userMessage: 'x' });
    assert.equal(sa.text, 'Antwort.', 'no marking and no note when off');
    assert.equal(sa.aiDisclosure, undefined);
  });

  it('applies a per-channel override over the global standard on a resolvable channel (telegram)', async () => {
    // telegram is a channel the dispatcher actually resolves to a per-turn
    // `channelKind` (`orchestratorDispatcher.toChannelKind`), so the override
    // can bite in production — unlike email/web (next test).
    const o = makeOrchestrator({
      answer: 'Antwort.',
      aiDisclosure: { level: 'standard', overrides: { telegram: 'concise' } },
    });
    const sa = await o.chat({
      userMessage: 'x',
      channelIdentity: { channelKind: 'telegram', channelUserId: 'u1' },
    });
    assert.match(sa.text, /KI-generiert\./, 'the telegram override used the concise line');
    assert.equal(sa.aiDisclosure?.level, 'concise');
    assert.equal(sa.aiDisclosure?.source, 'operator');
  });

  it('documents the limitation: a web/email override is inert (no per-turn channelKind → global level)', async () => {
    // The web SSE route (routes/chat.ts) and the email path never set
    // `channelIdentity`, so a `web`/`email` override key can never match. The
    // override is accepted at parse time but currently falls back to the global
    // level — the safe direction (marking stays active). If a future connector
    // starts populating channelKind='web', this test flips and should be
    // updated alongside the manifest help text.
    const o = makeOrchestrator({
      answer: 'Antwort.',
      aiDisclosure: { level: 'standard', overrides: { web: 'off' } },
    });
    const sa = await o.chat({ userMessage: 'x' }); // no channelIdentity, as the web route sends
    assert.equal(sa.text, `Antwort.\n\n${DE_STANDARD}`, 'web=off did not silence — global standard applied');
    assert.equal(sa.aiDisclosure?.level, 'standard');
  });
});

// ── #644 manifest — operator setup fields ────────────────────────────────────

const MANIFEST = fileURLToPath(
  new URL('../packages/harness-orchestrator/manifest.yaml', import.meta.url),
);

const DISCLOSURE_FIELDS: ReadonlyArray<{ key: string; type: string }> = [
  { key: 'ai_disclosure_level', type: 'enum' },
  { key: 'ai_disclosure_level_overrides', type: 'string' },
  { key: 'ai_disclosure_locale', type: 'enum' },
  { key: 'ai_disclosure_assistant_name', type: 'string' },
  { key: 'ai_disclosure_operator_note', type: 'string' },
];

describe('#644 orchestrator manifest — disclosure setup fields', () => {
  it('exposes all five disclosure knobs with the right types', async () => {
    const entry = await loadManifestFromPath(MANIFEST);
    assert.ok(entry, 'orchestrator manifest.yaml failed to load');
    const fields = entry.plugin.setup_fields ?? [];
    for (const expected of DISCLOSURE_FIELDS) {
      const field = fields.find((f) => f.key === expected.key);
      assert.ok(field, `missing disclosure setup field: ${expected.key}`);
      assert.equal(field.type, expected.type, `${expected.key} should be type ${expected.type}`);
    }
  });

  it('defaults the level enum to standard (shipping default active)', async () => {
    const entry = await loadManifestFromPath(MANIFEST);
    const field = (entry?.plugin.setup_fields ?? []).find(
      (f) => f.key === 'ai_disclosure_level',
    );
    assert.equal(field?.default, 'standard');
  });
});
