import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import { NativeToolRegistry, Orchestrator } from '@omadia/orchestrator';
import {
  LlmScreener,
  HttpProxyScreener,
  screenProvenance,
  resolveEffectivePosture,
  parseVerdict,
  chunkString,
  MCP_INPUT_REPLY_PREFIX,
  type SecurityScreener,
  type SecurityPostureSetup,
  type SecurityAuditEvent,
  type AiDisclosureSetup,
  type FetchLike,
} from '@omadia/orchestrator';
import {
  UNSCREENED_MARKER,
  bundleProvenance,
  type ChatStreamEvent,
  type ChatTurnInput,
  type ChatTurnAttachment,
} from '@omadia/channel-sdk';
// Internal refusal notice — imported from source for an exact read-back (it is
// module-scoped in orchestrator.ts, not part of the built barrel).
import { SECURITY_QUARANTINE_NOTICE } from '../packages/harness-orchestrator/src/orchestrator.js';
import { loadManifestFromPath } from '../src/plugins/manifestLoader.js';

const DE_STANDARD = 'Diese Antwort wurde von einem KI-System erzeugt.';

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

/** A provider that records every request it is asked to run (so a test can
 *  prove the model was, or was NOT, called and inspect the wire prompt). */
function recordingProvider(answerText: string, seen: LlmRequest[]): LlmProvider {
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
    complete: async (req: LlmRequest): Promise<LlmResponse> => {
      seen.push(req);
      return response;
    },
    stream: (req: LlmRequest): AsyncIterable<LlmStreamEvent> => {
      seen.push(req);
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text_delta', text: answerText.slice(0, half) };
          yield { type: 'text_delta', text: answerText.slice(half) };
          yield { type: 'final', response };
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

/** A screener whose behaviour and call-count the test controls. */
function stubScreener(
  behaviour: 'allow' | 'quarantine' | 'throw',
): SecurityScreener & { calls: number } {
  return {
    calls: 0,
    async screen(): Promise<{ decision: 'allow' | 'quarantine'; reason: string }> {
      this.calls += 1;
      if (behaviour === 'throw') throw new Error('screener offline');
      return behaviour === 'quarantine'
        ? { decision: 'quarantine', reason: 'injected instruction in attachment' }
        : { decision: 'allow', reason: '' };
    },
  };
}

const PDF_ATTACHMENT: ChatTurnAttachment = {
  kind: 'file',
  url: 'https://x/invoice.pdf',
  mediaType: 'application/pdf',
  name: 'invoice.pdf',
};

function systemText(req: LlmRequest): string {
  const s = req.system;
  if (s === undefined) return '';
  return typeof s === 'string'
    ? s
    : s.map((b) => (b as { text?: string }).text ?? '').join('\n');
}

function makeOrchestrator(opts: {
  answer?: string;
  screener?: SecurityScreener;
  securityPosture?: SecurityPostureSetup;
  aiDisclosure?: AiDisclosureSetup;
  seen: LlmRequest[];
  audits: SecurityAuditEvent[];
}): Orchestrator {
  return new Orchestrator({
    provider: recordingProvider(opts.answer ?? 'Antwort.', opts.seen),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    ...(opts.screener ? { securityScreener: () => opts.screener } : {}),
    ...(opts.securityPosture ? { securityPosture: opts.securityPosture } : {}),
    ...(opts.aiDisclosure ? { aiDisclosure: opts.aiDisclosure } : {}),
    securityAuditSink: () => (event: SecurityAuditEvent) => {
      opts.audits.push(event);
    },
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

// ── screener units ───────────────────────────────────────────────────────────

describe('#579 parseVerdict', () => {
  it('parses ALLOW and QUARANTINE, carries the reason', () => {
    assert.deepEqual(parseVerdict('ALLOW'), { decision: 'allow' });
    assert.deepEqual(parseVerdict('QUARANTINE: prompt injection'), {
      decision: 'quarantine',
      reason: 'prompt injection',
    });
    assert.equal(parseVerdict('quarantine').decision, 'quarantine');
  });

  it('throws on an unparseable verdict (→ unscreenable, never a silent allow)', () => {
    assert.throws(() => parseVerdict('I think it is probably fine?'));
  });
});

describe('#579 LlmScreener', () => {
  it('maps the judge reply to a verdict', async () => {
    const seen: LlmRequest[] = [];
    const q = new LlmScreener({
      provider: recordingProvider('QUARANTINE: bad', seen),
      model: 'test',
    });
    assert.deepEqual(await q.screen('payload'), {
      decision: 'quarantine',
      reason: 'bad',
    });
    const a = new LlmScreener({
      provider: recordingProvider('ALLOW', []),
      model: 'test',
    });
    assert.deepEqual(await a.screen('payload'), { decision: 'allow' });
  });
});

describe('#579 HttpProxyScreener', () => {
  const okResponse = (body: unknown) => ({
    ok: true,
    status: 200,
    json: async () => body,
  });

  it('reads a proxy verdict', async () => {
    const fetchImpl: FetchLike = async () =>
      okResponse({ decision: 'quarantine', reason: 'external hit' });
    const s = new HttpProxyScreener({ url: 'https://proxy', fetchImpl });
    assert.deepEqual(await s.screen('x'), {
      decision: 'quarantine',
      reason: 'external hit',
    });
  });

  it('chunks a large payload and any chunk-quarantine wins', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async (_url, init) => {
      calls += 1;
      const { payload } = JSON.parse(init.body) as { payload: string };
      // Quarantine only the chunk that contains the marker word.
      return okResponse(
        payload.includes('BAD')
          ? { decision: 'quarantine', reason: 'hit' }
          : { decision: 'allow' },
      );
    };
    // chunkChars 4 → boundaries at 0/4/8/12; 'BAD' sits at indices 4-6 so it
    // lands wholly inside the second chunk ('BADa').
    const s = new HttpProxyScreener({ url: 'https://proxy', chunkChars: 4, fetchImpl });
    const verdict = await s.screen('aaaaBADaaaaaa');
    assert.ok(calls > 1, 'payload was split into multiple requests');
    assert.equal(verdict.decision, 'quarantine');
  });

  it('catches an injection straddling a chunk boundary (overlap, not luck)', async () => {
    const seen: string[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      const { payload } = JSON.parse(init.body) as { payload: string };
      seen.push(payload);
      // Only a window that contains the WHOLE marker quarantines.
      return okResponse(
        payload.includes('INJECT')
          ? { decision: 'quarantine', reason: 'hit' }
          : { decision: 'allow' },
      );
    };
    // 'INJECT' spans the size-8 boundary (chars 5-10); without overlap it would
    // be split across two windows and slip through. overlap 4 keeps it whole.
    const payload = 'aaaaaINJECTaaaaa';
    const s = new HttpProxyScreener({
      url: 'https://proxy',
      chunkChars: 8,
      overlapChars: 4,
      fetchImpl,
    });
    const verdict = await s.screen(payload);
    assert.equal(verdict.decision, 'quarantine');
    assert.ok(seen.some((w) => w.includes('INJECT')), 'a window held the whole marker');
  });

  it('rejects on a non-2xx response (→ unscreenable, never a silent allow)', async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    });
    const s = new HttpProxyScreener({ url: 'https://proxy', fetchImpl });
    await assert.rejects(() => s.screen('x'));
  });
});

describe('#579 chunkString', () => {
  it('never returns an empty array and preserves bytes (no overlap)', () => {
    assert.deepEqual(chunkString('', 4), ['']);
    assert.deepEqual(chunkString('abcdefg', 3), ['abc', 'def', 'g']);
    assert.equal(chunkString('abcdefg', 3).join(''), 'abcdefg');
  });

  it('overlaps adjacent windows so a boundary phrase stays whole in one window', () => {
    // size 4, no overlap → 'BAD' straddling index 3-5 is split ['aaaB','ADaa'].
    assert.deepEqual(chunkString('aaaBADaa', 4), ['aaaB', 'ADaa']);
    assert.ok(!chunkString('aaaBADaa', 4).some((c) => c.includes('BAD')));
    // size 4, overlap 2 → some window now contains the whole 'BAD'.
    assert.ok(chunkString('aaaBADaa', 4, 2).some((c) => c.includes('BAD')));
  });
});

describe('#579 resolveEffectivePosture — tighten-only', () => {
  it('tightens a scope above the floor and clamps one below it', () => {
    assert.equal(
      resolveEffectivePosture({ floor: 'auto', override: 'strict', mode: 'enforce' }),
      'strict',
    );
    assert.equal(
      resolveEffectivePosture({ floor: 'auto', override: 'dangerous', mode: 'enforce' }),
      'auto',
    );
    assert.equal(resolveEffectivePosture({ floor: 'strict', mode: 'enforce' }), 'strict');
  });
});

describe('#579 screenProvenance — fail-open contract', () => {
  it('allows without calling the screener when there is no non-human content', async () => {
    const s = stubScreener('quarantine');
    const outcome = await screenProvenance(s, bundleProvenance({ userMessage: 'hi' }));
    assert.deepEqual(outcome, { status: 'allow' });
    assert.equal(s.calls, 0);
  });

  it('turns a thrown screen into unscreenable (never propagates)', async () => {
    const outcome = await screenProvenance(
      stubScreener('throw'),
      bundleProvenance({ userMessage: 'hi', attachments: [PDF_ATTACHMENT] }),
    );
    assert.equal(outcome.status, 'unscreenable');
  });

  it('passes a quarantine verdict through', async () => {
    const outcome = await screenProvenance(
      stubScreener('quarantine'),
      bundleProvenance({ userMessage: 'hi', attachments: [PDF_ATTACHMENT] }),
    );
    assert.equal(outcome.status, 'quarantine');
  });
});

// ── orchestrator integration ─────────────────────────────────────────────────

describe('#579 AC1 — default auto screens non-human content, not plain turns', () => {
  it('never consults the screener when there is only direct human input', async () => {
    const seen: LlmRequest[] = [];
    const audits: SecurityAuditEvent[] = [];
    const screener = stubScreener('quarantine');
    const o = makeOrchestrator({ answer: 'Hallo.', screener, seen, audits });
    const sa = await o.chat({ userMessage: 'hi' });
    assert.equal(screener.calls, 0, 'no attachment → nothing to screen');
    assert.ok(seen.length > 0, 'the turn ran');
    assert.match(sa.text, /Hallo\./);
    assert.equal(audits.length, 0);
  });

  it('screens when an attachment is present and allows a clean one', async () => {
    const seen: LlmRequest[] = [];
    const audits: SecurityAuditEvent[] = [];
    const screener = stubScreener('allow');
    const o = makeOrchestrator({ answer: 'Hallo.', screener, seen, audits });
    const sa = await o.chat({ userMessage: 'read this', attachments: [PDF_ATTACHMENT] });
    assert.equal(screener.calls, 1);
    assert.ok(seen.length > 0, 'a clean screen lets the turn run');
    assert.match(sa.text, /Hallo\./);
  });
});

describe('#579 AC4 — quarantine short-circuits the turn (enforce)', () => {
  it('non-streaming: the model never runs; a refusal + audit are produced', async () => {
    const seen: LlmRequest[] = [];
    const audits: SecurityAuditEvent[] = [];
    const o = makeOrchestrator({
      answer: 'should never be produced',
      screener: stubScreener('quarantine'),
      securityPosture: { floor: 'auto', mode: 'enforce' },
      seen,
      audits,
    });
    const sa = await o.chat({ userMessage: 'run this', attachments: [PDF_ATTACHMENT] });
    assert.equal(seen.length, 0, 'the provider (model) was never called');
    assert.ok(sa.text.startsWith(SECURITY_QUARANTINE_NOTICE), 'delivered the refusal');
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.kind, 'quarantine');
    assert.equal(audits[0]!.mode, 'enforce');
    assert.equal(audits[0]!.posture, 'auto');
    assert.deepEqual(audits[0]!.sourceTags, ['attachment:invoice.pdf']);
  });

  it('streaming: mirrors the non-streaming short-circuit', async () => {
    const seen: LlmRequest[] = [];
    const audits: SecurityAuditEvent[] = [];
    const o = makeOrchestrator({
      screener: stubScreener('quarantine'),
      securityPosture: { floor: 'auto', mode: 'enforce' },
      seen,
      audits,
    });
    const done = await streamDone(o, {
      userMessage: 'run this',
      attachments: [PDF_ATTACHMENT],
    });
    assert.equal(seen.length, 0, 'the model never ran on the streaming path either');
    assert.ok(done.answer.startsWith(SECURITY_QUARANTINE_NOTICE));
    assert.equal(audits.length, 1);
  });
});

describe('#579 AC5 — unscreenable fails open with evidence', () => {
  it('runs the turn, folds the marker into the WIRE prompt only, audits the miss', async () => {
    const seen: LlmRequest[] = [];
    const audits: SecurityAuditEvent[] = [];
    const o = makeOrchestrator({
      answer: 'Antwort.',
      screener: stubScreener('throw'),
      securityPosture: { floor: 'auto', mode: 'enforce' },
      seen,
      audits,
    });
    const sa = await o.chat({ userMessage: 'read this', attachments: [PDF_ATTACHMENT] });
    // The turn ran…
    assert.equal(seen.length, 1, 'fail-open: the turn still reached the model');
    // …the untrusted marker reached the model (wire system prompt)…
    assert.ok(systemText(seen[0]!).includes(UNSCREENED_MARKER), 'marker on the wire');
    // …but it is NOT echoed into the delivered answer (wire-only, not persisted).
    assert.ok(!sa.text.includes(UNSCREENED_MARKER), 'marker not folded into the answer');
    // …and the miss is audited.
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.kind, 'unscreenable');
  });

  it('is unscreenable when screening is on with content but no screener is wired', async () => {
    const seen: LlmRequest[] = [];
    const audits: SecurityAuditEvent[] = [];
    // No `screener` passed → screening enabled (auto) + content ⇒ unscreenable.
    const o = makeOrchestrator({ answer: 'Antwort.', seen, audits });
    const sa = await o.chat({ userMessage: 'read this', attachments: [PDF_ATTACHMENT] });
    assert.equal(seen.length, 1, 'fail-open: still ran');
    assert.ok(systemText(seen[0]!).includes(UNSCREENED_MARKER));
    assert.equal(audits[0]?.kind, 'unscreenable');
  });
});

describe('#579 AC6 — shadow mode observes but never blocks', () => {
  it('runs the turn on a quarantine verdict, but still audits it', async () => {
    const seen: LlmRequest[] = [];
    const audits: SecurityAuditEvent[] = [];
    const o = makeOrchestrator({
      answer: 'Antwort.',
      screener: stubScreener('quarantine'),
      securityPosture: { floor: 'auto', mode: 'shadow' },
      seen,
      audits,
    });
    const sa = await o.chat({ userMessage: 'run this', attachments: [PDF_ATTACHMENT] });
    assert.equal(seen.length, 1, 'shadow: the turn runs despite the quarantine verdict');
    assert.match(sa.text, /Antwort\./);
    assert.ok(!sa.text.startsWith(SECURITY_QUARANTINE_NOTICE));
    assert.equal(audits.length, 1, 'the would-have-blocked verdict is still recorded');
    assert.equal(audits[0]!.kind, 'quarantine');
    assert.equal(audits[0]!.mode, 'shadow');
  });
});

describe('#579 AC2 — posture floor + tighten-only, end to end', () => {
  it('dangerous disables screening entirely', async () => {
    const seen: LlmRequest[] = [];
    const audits: SecurityAuditEvent[] = [];
    const screener = stubScreener('quarantine');
    const o = makeOrchestrator({
      answer: 'Antwort.',
      screener,
      securityPosture: { floor: 'dangerous', mode: 'enforce' },
      seen,
      audits,
    });
    const sa = await o.chat({ userMessage: 'run this', attachments: [PDF_ATTACHMENT] });
    assert.equal(screener.calls, 0, 'dangerous → the screener is never consulted');
    assert.match(sa.text, /Antwort\./);
    assert.equal(audits.length, 0);
  });

  it('a scope that tightens the floor raises screening back on', async () => {
    const seen: LlmRequest[] = [];
    const audits: SecurityAuditEvent[] = [];
    const screener = stubScreener('allow');
    const o = makeOrchestrator({
      answer: 'Antwort.',
      screener,
      // floor dangerous (off) but scope tightens to auto (on)
      securityPosture: { floor: 'dangerous', override: 'auto', mode: 'enforce' },
      seen,
      audits,
    });
    await o.chat({ userMessage: 'run this', attachments: [PDF_ATTACHMENT] });
    assert.equal(screener.calls, 1, 'effective auto → screening runs');
  });

  it('LOCKS the strict safe-fallback: strict screens while approvals are unavailable', async () => {
    const seen: LlmRequest[] = [];
    const audits: SecurityAuditEvent[] = [];
    const o = makeOrchestrator({
      answer: 'Antwort.',
      screener: stubScreener('throw'),
      securityPosture: { floor: 'strict', mode: 'enforce' },
      seen,
      audits,
    });
    const sa = await o.chat({ userMessage: 'read this', attachments: [PDF_ATTACHMENT] });
    // strict currently enforces at-least-auto screening → an offline screener
    // fails open with the marker, proving strict did NOT silently skip screening.
    assert.ok(systemText(seen[0]!).includes(UNSCREENED_MARKER));
    assert.equal(audits[0]?.kind, 'unscreenable');
    assert.ok(!sa.text.includes(UNSCREENED_MARKER));
  });
});

describe('#579 AC7 — MCP input-card replies are exempt from screening', () => {
  it('does not screen a machine-envelope reply, even with an attachment', async () => {
    const seen: LlmRequest[] = [];
    const audits: SecurityAuditEvent[] = [];
    const screener = stubScreener('quarantine');
    const o = makeOrchestrator({ answer: 'Antwort.', screener, seen, audits });
    const envelope = `${MCP_INPUT_REPLY_PREFIX} ${JSON.stringify({
      correlationId: 'c1',
      inputResponses: { field: 'value' },
    })}`;
    const sa = await o.chat({ userMessage: envelope, attachments: [PDF_ATTACHMENT] });
    assert.equal(screener.calls, 0, 'the MCP reply envelope is exempt');
    assert.ok(!sa.text.startsWith(SECURITY_QUARANTINE_NOTICE), 'the turn was not quarantined');
  });
});

describe('#579 verifier re-entry is screened once per USER turn', () => {
  it('a marked re-entry input skips screening + audit (no double-fire on retry)', async () => {
    const seen: LlmRequest[] = [];
    const audits: SecurityAuditEvent[] = [];
    const screener = stubScreener('quarantine');
    const o = makeOrchestrator({
      answer: 'Antwort.',
      screener,
      securityPosture: { floor: 'auto', mode: 'enforce' },
      seen,
      audits,
    });
    const input: ChatTurnInput = {
      userMessage: 'run this',
      attachments: [PDF_ATTACHMENT],
    };
    // Mark this exact input object as a re-entry — what the verifier does for a
    // correction-retry / borderline-resample of an already-screened user turn.
    o.markScreeningReentry(input);
    const sa = await o.chat(input);
    assert.equal(screener.calls, 0, 're-entry is exempt: the screener is not consulted again');
    assert.equal(audits.length, 0, 'no duplicate audit event for the re-entry');
    assert.ok(
      !sa.text.startsWith(SECURITY_QUARANTINE_NOTICE),
      're-entry runs the turn — it is not re-quarantined',
    );
    assert.ok(seen.length > 0, 'the turn reached the model');
  });

  it('a fresh (unmarked) input with the same content IS still screened', async () => {
    // Guards against the exemption leaking: object identity, not content.
    const seen: LlmRequest[] = [];
    const audits: SecurityAuditEvent[] = [];
    const screener = stubScreener('quarantine');
    const o = makeOrchestrator({
      screener,
      securityPosture: { floor: 'auto', mode: 'enforce' },
      seen,
      audits,
    });
    const sa = await o.chat({ userMessage: 'run this', attachments: [PDF_ATTACHMENT] });
    assert.equal(screener.calls, 1, 'an unmarked turn is screened normally');
    assert.ok(sa.text.startsWith(SECURITY_QUARANTINE_NOTICE));
  });
});

describe('#579 quarantine refusal folds the AI disclosure on BOTH paths', () => {
  it('non-streaming and streaming both lead with the notice AND fold the disclosure', async () => {
    const posture: SecurityPostureSetup = { floor: 'auto', mode: 'enforce' };
    // Separate orchestrators: the disclosure seen-store dedups per scope and a
    // turn takes exactly one path — sharing one would suppress the second fold.
    const ns = makeOrchestrator({
      screener: stubScreener('quarantine'),
      securityPosture: posture,
      aiDisclosure: { level: 'standard' },
      seen: [],
      audits: [],
    });
    const sa = await ns.chat({ userMessage: 'run this', attachments: [PDF_ATTACHMENT] });

    const st = makeOrchestrator({
      screener: stubScreener('quarantine'),
      securityPosture: posture,
      aiDisclosure: { level: 'standard' },
      seen: [],
      audits: [],
    });
    const done = await streamDone(st, {
      userMessage: 'run this',
      attachments: [PDF_ATTACHMENT],
    });

    for (const answer of [sa.text, done.answer]) {
      assert.ok(answer.startsWith(SECURITY_QUARANTINE_NOTICE), 'refusal notice leads');
      assert.ok(answer.includes(DE_STANDARD), 'AI disclosure folded into the refusal');
    }
  });
});

// ── manifest — operator setup fields ─────────────────────────────────────────

const MANIFEST = fileURLToPath(
  new URL('../packages/harness-orchestrator/manifest.yaml', import.meta.url),
);

const SECURITY_FIELDS: ReadonlyArray<{ key: string; type: string }> = [
  { key: 'security_posture', type: 'enum' },
  { key: 'security_posture_override', type: 'enum' },
  { key: 'security_screen_mode', type: 'enum' },
  { key: 'security_screen_url', type: 'url' },
];

describe('#579 manifest — security posture setup fields', () => {
  it('exposes all four security knobs with the right types', async () => {
    const entry = await loadManifestFromPath(MANIFEST);
    assert.ok(entry, 'orchestrator manifest.yaml failed to load');
    const fields = entry.plugin.setup_fields ?? [];
    for (const expected of SECURITY_FIELDS) {
      const field = fields.find((f) => f.key === expected.key);
      assert.ok(field, `missing security setup field: ${expected.key}`);
      assert.equal(field.type, expected.type, `${expected.key} should be ${expected.type}`);
    }
  });

  it('defaults posture to auto and mode to enforce (safe shipping defaults)', async () => {
    const entry = await loadManifestFromPath(MANIFEST);
    const fields = entry?.plugin.setup_fields ?? [];
    assert.equal(fields.find((f) => f.key === 'security_posture')?.default, 'auto');
    assert.equal(fields.find((f) => f.key === 'security_screen_mode')?.default, 'enforce');
  });

  // A declared setup field that nothing reads is WORSE than a missing one: the
  // operator sets it, the UI shows it as configured, and the deployment quietly
  // runs on the shipping default. Nothing else in this suite catches that —
  // verified by mutation: pointing the resolver at the old `_scope` key while
  // the manifest declares `_override` left every other test green.
  //
  // A source-level wiring assertion is deliberate. `resolveSecurityPostureSetup`
  // is module-private and the manifest is YAML, so there is no shared constant
  // the two sides could be compared through; the honest check is that each
  // declared key literally appears in a `read(...)` call.
  it('every declared security field is actually READ by the resolver', async () => {
    const entry = await loadManifestFromPath(MANIFEST);
    const declared = (entry?.plugin.setup_fields ?? [])
      .map((f) => f.key)
      .filter((k) => k.startsWith('security_'));
    assert.ok(declared.length >= 4, 'expected the security_* setup fields to be declared');

    const pluginSource = await readFile(
      fileURLToPath(
        new URL('../packages/harness-orchestrator/src/plugin.ts', import.meta.url),
      ),
      'utf8',
    );
    for (const key of declared) {
      assert.ok(
        pluginSource.includes(`read('${key}')`),
        `manifest declares "${key}" but plugin.ts never reads it — the setting would be silently ignored`,
      );
    }
  });
});
