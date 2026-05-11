import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type {
  PrivacyDetector,
  PrivacyDetectorOutcome,
  PrivacyOutboundRequest,
} from '@omadia/plugin-api';

import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';

// ---------------------------------------------------------------------------
// Slice 3.2.2 — single-flight dedup + per-detector scanTargets filter.
//
// The Slice-3.2.1 boot-smoke surfaced a 12-call timeout storm: a real
// orchestrator turn with 6 outbound payloads (main + sub-agent + tool
// iterations) × 2 targets (system + message) = 12 detect() calls, all
// timing out on the 22kb static system prompt. 3.2.2 cuts this in two
// directions:
//   - Single-flight cache (turn-scoped) so identical (detector, text)
//     queries share one in-flight promise.
//   - Per-detector scan-target filter so slow detectors (Ollama NER)
//     skip the system prompt altogether — regex still scans it for
//     structured PII inside memory recalls.
// ---------------------------------------------------------------------------

interface CallRecord {
  readonly text: string;
  readonly at: number;
}

function instrumentedDetector(
  id: string,
  outcomeFor: (text: string) => PrivacyDetectorOutcome,
  recordedCalls: CallRecord[],
  scanTargets?: PrivacyDetector['scanTargets'],
): PrivacyDetector {
  return {
    id,
    ...(scanTargets !== undefined ? { scanTargets } : {}),
    async detect(text: string): Promise<PrivacyDetectorOutcome> {
      recordedCalls.push({ text, at: Date.now() });
      return outcomeFor(text);
    },
  };
}

function outboundRequest(
  turnId: string,
  systemPrompt: string,
  messages: ReadonlyArray<{ role: 'user' | 'assistant' | 'system'; content: string }>,
): PrivacyOutboundRequest {
  return {
    sessionId: 'session-perf',
    turnId,
    systemPrompt,
    messages,
  };
}

describe('PrivacyGuardService · turn-scoped single-flight cache (Slice 3.2.2)', () => {
  it('dedups identical (detector, text) calls within one turn', async () => {
    const calls: CallRecord[] = [];
    const detector = instrumentedDetector(
      'static:1',
      () => ({ hits: [], status: 'ok' }),
      calls,
    );
    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      detectors: [detector],
    });

    // Three outbound calls in one turn — main agent + 2 sub-agents —
    // all share the same system prompt and the same user message.
    const SYSTEM = 'Du bist ein Assistent. Tools: foo, bar.';
    const MESSAGE = 'Hi, was ist los?';
    for (const role of ['main', 'sub-1', 'sub-2']) {
      void role;
      await service.processOutbound(outboundRequest('t-dedup', SYSTEM, [
        { role: 'user', content: MESSAGE },
      ]));
    }

    // Without dedup we'd see 6 calls (3 outbounds × 2 targets). With
    // dedup we see exactly 2 unique-text calls (system + message).
    assert.equal(calls.length, 2, `expected 2 unique detector hits, got ${String(calls.length)}`);

    const receipt = await service.finalizeTurn('t-dedup');
    if (!receipt) throw new Error('expected receipt');
    const run = receipt.detectorRuns.find((r) => r.detector === 'static:1');
    if (!run) throw new Error('expected detector run row');
    // callCount counts every query — so 6 — but the cache absorbs them.
    assert.equal(run.callCount, 6, 'callCount reflects every query (incl. cache hits)');
  });

  it('cache-hits report 0ms latency; only the first call accrues real time', async () => {
    const calls: CallRecord[] = [];
    const detector = instrumentedDetector(
      'slow:1',
      () => ({ hits: [], status: 'ok' }),
      calls,
    );
    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      detectors: [detector],
    });
    const SAME = 'identical text every time';
    for (let i = 0; i < 5; i++) {
      await service.processOutbound(outboundRequest('t-lat', SAME, [
        { role: 'user', content: SAME }, // same text in user message too
      ]));
    }
    // Slice 2.2 prepends a directive to the system prompt, so the system
    // target text differs from the user message even when the caller
    // passes byte-identical strings. We therefore see TWO unique-text
    // detector executions across the 5 outbounds — one for the directive-
    // prefixed system and one for the user message — instead of the
    // pre-2.2 single one. The cache still absorbs the rest.
    assert.equal(calls.length, 2, 'two unique texts → two detector hits');
    const receipt = await service.finalizeTurn('t-lat');
    if (!receipt) throw new Error('expected receipt');
    const run = receipt.detectorRuns[0];
    assert.equal(run?.callCount, 10, '5 outbounds × 2 targets = 10 queries');
    // latencyMs is the sum of real per-call elapsed times. Cache hits
    // contribute 0; only the very first call ran for real. So total
    // latency must be small (a few ms in tests).
    assert.ok(run !== undefined && run.latencyMs < 50, `latency too high: ${String(run?.latencyMs)}`);
  });

  it('cache is turn-scoped — a fresh turn re-queries identical text', async () => {
    const calls: CallRecord[] = [];
    const detector = instrumentedDetector(
      'turn-scoped:1',
      () => ({ hits: [], status: 'ok' }),
      calls,
    );
    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      detectors: [detector],
    });
    // Distinct sys vs msg so each outbound contributes 2 unique cache
    // keys; identical pair across the two turns proves turn-isolation.
    const SYS = 'system-prompt';
    const MSG = 'user-question';
    await service.processOutbound(outboundRequest('t-A', SYS, [
      { role: 'user', content: MSG },
    ]));
    await service.finalizeTurn('t-A');

    await service.processOutbound(outboundRequest('t-B', SYS, [
      { role: 'user', content: MSG },
    ]));
    await service.finalizeTurn('t-B');

    // Each turn has its own cache → 2 unique calls per turn × 2 turns = 4.
    assert.equal(calls.length, 4, 'turns must not share the inflight cache');
  });

  it('caches the same outcome for thrown-detector callers (synthesised error reused)', async () => {
    let physicalCalls = 0;
    const broken: PrivacyDetector = {
      id: 'broken:1',
      async detect() {
        physicalCalls++;
        throw new Error('fault');
      },
    };
    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      detectors: [broken],
    });
    for (let i = 0; i < 4; i++) {
      await service.processOutbound(outboundRequest('t-throw', 'sys', [
        { role: 'user', content: 'msg' },
      ]));
    }
    assert.equal(physicalCalls, 2, 'throws cache too — sys + msg = 2 unique texts');
    const receipt = await service.finalizeTurn('t-throw');
    const run = receipt?.detectorRuns[0];
    assert.equal(run?.status, 'error');
    assert.equal(run?.callCount, 8, 'every query counted');
  });
});

describe('PrivacyDetector · scanTargets filter (Slice 3.2.2)', () => {
  it('scanTargets.systemPrompt=false skips the system prompt entirely', async () => {
    const sysOnlyCalls: CallRecord[] = [];
    const allCalls: CallRecord[] = [];
    const sysOnlyDetector = instrumentedDetector(
      'sys-blind:1',
      () => ({ hits: [], status: 'ok' }),
      sysOnlyCalls,
      { systemPrompt: false, userMessages: true, assistantMessages: true },
    );
    const baseline = instrumentedDetector(
      'all:1',
      () => ({ hits: [], status: 'ok' }),
      allCalls,
    );
    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      detectors: [sysOnlyDetector, baseline],
    });

    await service.processOutbound(outboundRequest('t-filter', 'system content', [
      { role: 'user', content: 'user msg' },
    ]));
    const receipt = await service.finalizeTurn('t-filter');

    // sys-blind only saw the user message
    assert.equal(sysOnlyCalls.length, 1);
    assert.equal(sysOnlyCalls[0]?.text, 'user msg');
    // baseline saw both
    assert.equal(allCalls.length, 2);

    const sysBlind = receipt?.detectorRuns.find((r) => r.detector === 'sys-blind:1');
    assert.equal(sysBlind?.callCount, 1, 'recordOutcome only fires for scanned targets');
  });

  it('scanTargets.userMessages=false keeps system prompt but skips user messages', async () => {
    const calls: CallRecord[] = [];
    const sysOnly = instrumentedDetector(
      'sys-only:1',
      () => ({ hits: [], status: 'ok' }),
      calls,
      { systemPrompt: true, userMessages: false, assistantMessages: false },
    );
    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      detectors: [sysOnly],
    });
    await service.processOutbound(outboundRequest('t-sys', 'system content', [
      { role: 'user', content: 'user msg' },
      { role: 'assistant', content: 'asst msg' },
    ]));
    assert.equal(calls.length, 1);
    // Slice 2.2 prepends a `<privacy-proxy-directive>` block to non-empty
    // system prompts; the original body must still be intact at the end.
    assert.ok(calls[0]?.text.endsWith('system content'));
  });

  it('default (no scanTargets) keeps Slice-3.1 behaviour: scan everything', async () => {
    const calls: CallRecord[] = [];
    const detector = instrumentedDetector(
      'default:1',
      () => ({ hits: [], status: 'ok' }),
      calls,
      // No scanTargets — undefined
    );
    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      detectors: [detector],
    });
    await service.processOutbound(outboundRequest('t-default', 'sys', [
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a' },
    ]));
    assert.equal(calls.length, 3, 'sys + user + assistant');
  });

  it('detectors that opt out of all targets contribute a 0-call run row', async () => {
    const calls: CallRecord[] = [];
    const detector = instrumentedDetector(
      'opted-out:1',
      () => ({ hits: [], status: 'ok' }),
      calls,
      { systemPrompt: false, userMessages: false, assistantMessages: false },
    );
    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      detectors: [detector],
    });
    await service.processOutbound(outboundRequest('t-out', 'sys', [
      { role: 'user', content: 'u' },
    ]));
    const receipt = await service.finalizeTurn('t-out');
    assert.equal(calls.length, 0);
    const run = receipt?.detectorRuns.find((r) => r.detector === 'opted-out:1');
    assert.equal(run?.callCount, 0);
    assert.equal(run?.status, 'ok');
  });
});

describe('PrivacyGuardService · cache + filter combined (Slice 3.2.2 acceptance)', () => {
  it('reproduces the 3.2.1-pain scenario: 6 outbounds × 2 targets, NER-skip-system + cache → 1 unique NER call', async () => {
    // System prompt is identical across all 6 outbounds (typical real
    // turn with a static 22kb prompt). The NER detector skips system,
    // and the user message is identical across sub-agent invocations
    // so the cache absorbs the rest.
    const nerCalls: CallRecord[] = [];
    const regexCalls: CallRecord[] = [];
    const ner = instrumentedDetector(
      'ner:1',
      () => ({ hits: [], status: 'ok' }),
      nerCalls,
      { systemPrompt: false, userMessages: true, assistantMessages: true },
    );
    const regex = instrumentedDetector(
      'regex:1',
      () => ({ hits: [], status: 'ok' }),
      regexCalls,
    );
    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      detectors: [regex, ner],
    });

    const HUGE_SYSTEM = 'X'.repeat(22_000);
    const USER_Q = 'Wann hat John Urlaub genommen?';
    for (let i = 0; i < 6; i++) {
      await service.processOutbound(outboundRequest('t-acceptance', HUGE_SYSTEM, [
        { role: 'user', content: USER_Q },
      ]));
    }
    const receipt = await service.finalizeTurn('t-acceptance');
    if (!receipt) throw new Error('expected receipt');

    // Pre-3.2.2: 12 NER calls. Post-3.2.2: 1 NER call (skip system + cache).
    assert.equal(nerCalls.length, 1, `expected 1 NER call, got ${String(nerCalls.length)}`);
    // Regex: still scans everything, but cache dedups → 2 unique texts.
    assert.equal(regexCalls.length, 2, `expected 2 regex calls, got ${String(regexCalls.length)}`);

    const nerRun = receipt.detectorRuns.find((r) => r.detector === 'ner:1');
    // NER run sees user-message queries only → 6 callCount (one per outbound),
    // 5 of which are cache hits.
    assert.equal(nerRun?.callCount, 6, 'NER queried only on user messages');

    const regexRun = receipt.detectorRuns.find((r) => r.detector === 'regex:1');
    // Regex sees both targets → 12 callCount, 10 of which are cache hits.
    assert.equal(regexRun?.callCount, 12);
  });
});
