import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  AutoFixOrchestrator,
  computeFingerprint,
  MAX_IDENTICAL_ATTEMPTS,
} from '../../src/plugins/builder/autoFixOrchestrator.js';
import type { BuilderAgent } from '../../src/plugins/builder/builderAgent.js';
import type { DraftStore } from '../../src/plugins/builder/draftStore.js';
import { SpecEventBus, type SpecBusEvent } from '../../src/plugins/builder/specEventBus.js';
import { emptyAgentSpec } from '../../src/plugins/builder/types.js';

type Fingerprintable =
  | Extract<SpecBusEvent, { type: 'build_status' }>
  | Extract<SpecBusEvent, { type: 'runtime_smoke_status' }>;

const buildFailed = (
  errors: ReadonlyArray<{ code: string; file?: string; line?: number; column?: number; message?: string }>,
  buildN = 1,
  reason = 'tsc',
): Extract<SpecBusEvent, { type: 'build_status' }> => ({
  type: 'build_status',
  phase: 'failed',
  buildN,
  reason,
  errorCount: errors.length,
  errors: errors.map((e) => ({
    file: e.file ?? 'src/toolkit.ts',
    line: e.line ?? 1,
    column: e.column ?? 1,
    code: e.code,
    message: e.message ?? 'whatever',
  })),
});

const smokeFailed = (
  results: ReadonlyArray<{ toolId: string; status: 'ok' | 'threw' | 'timeout' | 'validation_failed'; durationMs?: number; errorMessage?: string }>,
  buildN = 1,
): Extract<SpecBusEvent, { type: 'runtime_smoke_status' }> => ({
  type: 'runtime_smoke_status',
  phase: 'failed',
  buildN,
  reason: 'tool_failures',
  results: results.map((r) => ({
    toolId: r.toolId,
    status: r.status,
    durationMs: r.durationMs ?? 100,
    ...(r.errorMessage ? { errorMessage: r.errorMessage } : {}),
  })),
});

describe('autoFixOrchestrator.computeFingerprint', () => {
  it('is stable across identical build_status payloads', () => {
    const a = computeFingerprint(buildFailed([{ code: 'TS2322' }, { code: 'TS2304' }]));
    const b = computeFingerprint(buildFailed([{ code: 'TS2322' }, { code: 'TS2304' }]));
    assert.equal(a, b);
  });

  it('is order-insensitive on error codes (sort)', () => {
    const a = computeFingerprint(buildFailed([{ code: 'TS2322' }, { code: 'TS2304' }]));
    const b = computeFingerprint(buildFailed([{ code: 'TS2304' }, { code: 'TS2322' }]));
    assert.equal(a, b);
  });

  it('is insensitive to line-number drift between attempts', () => {
    const a = computeFingerprint(
      buildFailed([{ code: 'TS2322', line: 12, message: 'foo' }]),
    );
    const b = computeFingerprint(
      buildFailed([{ code: 'TS2322', line: 99, message: 'bar' }]),
    );
    assert.equal(a, b, 'line+message should not perturb fingerprint');
  });

  it('changes when a new error code appears', () => {
    const a = computeFingerprint(buildFailed([{ code: 'TS2322' }]));
    const b = computeFingerprint(buildFailed([{ code: 'TS2322' }, { code: 'TS7006' }]));
    assert.notEqual(a, b);
  });

  it('produces stable smoke fingerprint over toolId+status', () => {
    const a = computeFingerprint(
      smokeFailed([
        { toolId: 'fetch', status: 'threw', errorMessage: 'one' },
        { toolId: 'parse', status: 'timeout' },
      ]),
    );
    const b = computeFingerprint(
      smokeFailed([
        { toolId: 'parse', status: 'timeout', durationMs: 9999 },
        { toolId: 'fetch', status: 'threw', errorMessage: 'two' },
      ]),
    );
    assert.equal(a, b, 'order, durationMs, errorMessage do not affect fingerprint');
  });

  it('build vs smoke fingerprints diverge', () => {
    const buildFp = computeFingerprint(buildFailed([{ code: 'TS2322' }]));
    const smokeFp = computeFingerprint(smokeFailed([{ toolId: 'x', status: 'threw' }]));
    assert.notEqual(buildFp, smokeFp);
  });
});

// ---------------------------------------------------------------------------
// Orchestrator integration
// ---------------------------------------------------------------------------

interface Harness {
  bus: SpecEventBus;
  draftStore: DraftStore;
  builderAgent: BuilderAgent;
  fired: Array<{ draftId: string; userMessage: string }>;
  setAutoFix(enabled: boolean): void;
  emitted: SpecBusEvent[];
  orchestrator: AutoFixOrchestrator;
}

function makeHarness(opts?: { autoFixEnabled?: boolean }): Harness {
  const bus = new SpecEventBus();
  const fired: Harness['fired'] = [];
  let autoFixEnabled = opts?.autoFixEnabled ?? true;

  const fakeDraft = (): unknown => ({
    id: 'd1',
    userEmail: 'op@example.com',
    name: 'Test Draft',
    spec: {
      template: 'agent-integration',
      id: 'de.byte5.agent.test',
      name: 'Test',
      version: '0.1.0',
      description: 'desc',
      category: 'analysis',
      depends_on: [],
      tools: [],
      skill: { role: 'tester' },
      setup_fields: [],
      playbook: { when_to_use: 'tests' },
      network: { outbound: [] },
      slots: {},
      builder_settings: { auto_fix_enabled: autoFixEnabled },
    },
    slots: {},
    transcript: [],
    previewTranscript: [],
    codegenModel: 'sonnet',
    previewModel: 'sonnet',
    status: 'draft',
    installedAgentId: null,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
  });

  const draftStore = {
    load: async (_email: string, id: string) => (id === 'd1' ? fakeDraft() : null),
    update: async (_email: string, _id: string, _patch: unknown) => fakeDraft(),
  } as unknown as DraftStore;

  const builderAgent = {
    runTurn: (opts: { draftId: string; userMessage: string }) => {
      fired.push({ draftId: opts.draftId, userMessage: opts.userMessage });
      return (async function* () {
        yield { type: 'turn_started', turnId: 't' };
      })();
    },
  } as unknown as BuilderAgent;

  const emitted: SpecBusEvent[] = [];
  // Capture EVERY emit — including the orchestrator's own auto_fix_status
  // and the toggle-flip spec_patch — by subscribing before ensureSubscribed.
  // (The orchestrator emits to the same bus channel it listens on, but
  // EventEmitter delivers to all listeners synchronously without re-entry.)
  bus.subscribe('d1', (ev) => {
    emitted.push(ev);
  });

  const orchestrator = new AutoFixOrchestrator({
    bus,
    draftStore,
    builderAgent,
    defaultModel: 'claude-haiku-4-5-20251001',
    resolveModelId: () => 'claude-haiku-4-5-20251001',
    logger: () => {},
  });

  return {
    bus,
    draftStore,
    builderAgent,
    fired,
    setAutoFix: (next: boolean) => {
      autoFixEnabled = next;
    },
    emitted,
    orchestrator,
  };
}

async function settle(): Promise<void> {
  // Yield twice so the orchestrator's async load + spec parse + emit complete.
  await Promise.resolve();
  await new Promise((r) => setImmediate(r));
}

describe('AutoFixOrchestrator integration', () => {
  it('does not trigger when toggle is off', async () => {
    const h = makeHarness({ autoFixEnabled: false });
    h.orchestrator.ensureSubscribed('d1', 'op@example.com');
    h.bus.emit('d1', buildFailed([{ code: 'TS2322' }], 1));
    await settle();
    assert.equal(h.fired.length, 0);
    assert.equal(h.emitted.filter((e) => e.type === 'auto_fix_status').length, 0);
  });

  it('triggers on build_status:failed when toggle is on', async () => {
    const h = makeHarness();
    h.orchestrator.ensureSubscribed('d1', 'op@example.com');
    h.bus.emit('d1', buildFailed([{ code: 'TS2322' }], 1));
    await settle();
    assert.equal(h.fired.length, 1);
    assert.match(h.fired[0]!.userMessage, /Build #1 failed/);
    const triggers = h.emitted.filter(
      (e) => e.type === 'auto_fix_status' && e.phase === 'triggered',
    );
    assert.equal(triggers.length, 1);
  });

  it('dedupes per-buildN: same buildN twice fires only one turn', async () => {
    const h = makeHarness();
    h.orchestrator.ensureSubscribed('d1', 'op@example.com');
    const ev = buildFailed([{ code: 'TS2322' }], 1);
    h.bus.emit('d1', ev);
    await settle();
    h.bus.emit('d1', ev);
    await settle();
    assert.equal(h.fired.length, 1);
  });

  it('triggers again on a higher buildN', async () => {
    const h = makeHarness();
    h.orchestrator.ensureSubscribed('d1', 'op@example.com');
    h.bus.emit('d1', buildFailed([{ code: 'TS2322' }], 1));
    await settle();
    h.bus.emit('d1', buildFailed([{ code: 'TS7006' }], 2));
    await settle();
    assert.equal(h.fired.length, 2);
  });

  it('stops loop after MAX_IDENTICAL_ATTEMPTS consecutive identical fingerprints', async () => {
    const h = makeHarness();
    h.orchestrator.ensureSubscribed('d1', 'op@example.com');
    for (let i = 1; i <= MAX_IDENTICAL_ATTEMPTS + 1; i += 1) {
      h.bus.emit('d1', buildFailed([{ code: 'TS2322' }], i));
      await settle();
    }
    assert.equal(h.fired.length, MAX_IDENTICAL_ATTEMPTS);
    const stops = h.emitted.filter(
      (e) => e.type === 'auto_fix_status' && e.phase === 'stopped_loop',
    );
    assert.equal(stops.length, 1);
    assert.equal(
      (stops[0] as Extract<SpecBusEvent, { type: 'auto_fix_status' }>).identicalCount,
      MAX_IDENTICAL_ATTEMPTS,
    );
  });

  it('emits a spec_patch flipping auto_fix_enabled to false on stopped_loop', async () => {
    const h = makeHarness();
    h.orchestrator.ensureSubscribed('d1', 'op@example.com');
    for (let i = 1; i <= MAX_IDENTICAL_ATTEMPTS + 1; i += 1) {
      h.bus.emit('d1', buildFailed([{ code: 'TS2322' }], i));
      await settle();
    }
    const flips = h.emitted.filter(
      (e) =>
        e.type === 'spec_patch' &&
        e.patches.some(
          (p) =>
            p.op === 'replace' &&
            p.path === '/builder_settings/auto_fix_enabled',
        ),
    );
    assert.equal(flips.length, 1);
  });

  it('resets streak on build_status:ok', async () => {
    const h = makeHarness();
    h.orchestrator.ensureSubscribed('d1', 'op@example.com');
    h.bus.emit('d1', buildFailed([{ code: 'TS2322' }], 1));
    await settle();
    h.bus.emit('d1', buildFailed([{ code: 'TS2322' }], 2));
    await settle();
    h.bus.emit('d1', { type: 'build_status', phase: 'ok', buildN: 3 });
    await settle();
    const streakAfterOk = h.orchestrator.inspectStreak('d1');
    assert.equal(streakAfterOk?.consecutiveCount, 0);
    assert.equal(streakAfterOk?.lastFp, null);
  });

  it('different fingerprints reset the count', async () => {
    const h = makeHarness();
    h.orchestrator.ensureSubscribed('d1', 'op@example.com');
    h.bus.emit('d1', buildFailed([{ code: 'TS2322' }], 1));
    await settle();
    h.bus.emit('d1', buildFailed([{ code: 'TS7006' }], 2));
    await settle();
    h.bus.emit('d1', buildFailed([{ code: 'TS2322' }], 3));
    await settle();
    // Each was a different fingerprint pair (TS2322, TS7006, TS2322 again
    // but preceded by TS7006 → count reset). Each fired.
    assert.equal(h.fired.length, 3);
    const streak = h.orchestrator.inspectStreak('d1');
    assert.equal(streak?.consecutiveCount, 1);
  });

  it('triggers on smoke_failed independently of build_failed', async () => {
    const h = makeHarness();
    h.orchestrator.ensureSubscribed('d1', 'op@example.com');
    h.bus.emit('d1', smokeFailed([{ toolId: 't', status: 'threw' }], 5));
    await settle();
    assert.equal(h.fired.length, 1);
    assert.match(h.fired[0]!.userMessage, /smoke test/);
  });

  it('per-buildN dedup is kind-scoped (build + smoke same buildN both fire)', async () => {
    const h = makeHarness();
    h.orchestrator.ensureSubscribed('d1', 'op@example.com');
    h.bus.emit('d1', buildFailed([{ code: 'TS2322' }], 7));
    await settle();
    h.bus.emit('d1', smokeFailed([{ toolId: 't', status: 'threw' }], 7));
    await settle();
    assert.equal(h.fired.length, 2);
  });

  it('ensureSubscribed is idempotent', async () => {
    const h = makeHarness();
    h.orchestrator.ensureSubscribed('d1', 'op@example.com');
    h.orchestrator.ensureSubscribed('d1', 'op@example.com');
    h.bus.emit('d1', buildFailed([{ code: 'TS2322' }], 1));
    await settle();
    assert.equal(h.fired.length, 1);
  });

  // ── C-5: realistic operator-flow edge cases ───────────────────────────

  it('respects mid-loop toggle-off — next failure does NOT trigger', async () => {
    // Operator enables auto-fix, sees one auto-attempt fire, panics, flips
    // the toggle back off via the WorkspaceHeader switch. The next failure
    // event must be ignored. Models the real concern that an operator
    // wants a hard "stop now" that takes effect immediately on the
    // following build, not "after the current retry-streak is exhausted".
    const h = makeHarness({ autoFixEnabled: true });
    h.orchestrator.ensureSubscribed('d1', 'op@example.com');
    h.bus.emit('d1', buildFailed([{ code: 'TS2322' }], 1));
    await settle();
    assert.equal(h.fired.length, 1, 'first failure triggers under enabled toggle');

    h.setAutoFix(false);
    h.bus.emit('d1', buildFailed([{ code: 'TS2322' }], 2));
    await settle();
    assert.equal(h.fired.length, 1, 'second failure must be silenced — toggle was flipped off');
  });

  it('after stopped_loop, re-enabling the toggle starts fresh', async () => {
    // Operator hits the loop-cap (orchestrator stops, flips toggle off
    // server-side), inspects the code, fixes whatever the agent could
    // not, then re-enables the toggle. A NEW failure (higher buildN)
    // must trigger fresh — the streak counter must have been wiped.
    const h = makeHarness({ autoFixEnabled: true });
    h.orchestrator.ensureSubscribed('d1', 'op@example.com');
    for (let i = 1; i <= MAX_IDENTICAL_ATTEMPTS + 1; i += 1) {
      h.bus.emit('d1', buildFailed([{ code: 'TS2322' }], i));
      await settle();
    }
    assert.equal(h.fired.length, MAX_IDENTICAL_ATTEMPTS, 'pre-condition: stop fired at cap');
    const streakAfterStop = h.orchestrator.inspectStreak('d1');
    assert.equal(streakAfterStop?.consecutiveCount, 0);
    assert.equal(streakAfterStop?.lastFp, null);

    // Operator re-enables. Fake draftStore reflects this since it reads
    // the flag from the closure on every load().
    h.setAutoFix(true);
    h.bus.emit('d1', buildFailed([{ code: 'TS2322' }], 99));
    await settle();
    assert.equal(
      h.fired.length,
      MAX_IDENTICAL_ATTEMPTS + 1,
      'fresh attempt after re-enable must trigger',
    );
    const streakFresh = h.orchestrator.inspectStreak('d1');
    assert.equal(streakFresh?.consecutiveCount, 1, 'streak counts from 1, not from MAX+1');
  });

  it('gracefully ignores failures when the spec is mid-construction', async () => {
    // Pre-Zod-valid drafts (operator just typed `id: 'INVALID UPPERCASE'`,
    // hasn't fixed yet) cause parseAgentSpec to throw. The orchestrator
    // must not crash — it just skips the trigger and waits for the spec
    // to clean up. Otherwise a single bad draft could pull down the
    // whole bus subscription.
    const bus = new SpecEventBus();
    const fired: Array<{ draftId: string }> = [];
    const draftStore = {
      load: async () => ({
        id: 'd1',
        userEmail: 'op@example.com',
        spec: {
          id: 'INVALID UPPERCASE',
          name: 'x',
          description: 'y',
          category: 'analysis',
          skill: { role: 'r' },
          playbook: { when_to_use: 'w' },
          builder_settings: { auto_fix_enabled: true },
        },
        codegenModel: 'sonnet',
      }),
      update: async () => null,
    } as unknown as DraftStore;
    const builderAgent = {
      runTurn: () => {
        fired.push({ draftId: 'd1' });
        return (async function* () {})();
      },
    } as unknown as BuilderAgent;
    const orchestrator = new AutoFixOrchestrator({
      bus,
      draftStore,
      builderAgent,
      defaultModel: 'claude-haiku-4-5-20251001',
      resolveModelId: () => 'claude-haiku-4-5-20251001',
      logger: () => {},
    });
    orchestrator.ensureSubscribed('d1', 'op@example.com');
    bus.emit('d1', buildFailed([{ code: 'TS2322' }], 1));
    await settle();
    assert.equal(fired.length, 0, 'invalid spec must not trigger an auto-turn');
    assert.equal(orchestrator.inspectStreak('d1')?.consecutiveCount, 0);
  });

  // ── Theme B: in-flight pause-lock ─────────────────────────────────────

  it('serialises auto-turns: a second failure mid-flight is dropped, lock clears after turn', async () => {
    // Models the real bug: an in-flight auto-turn kicks off a rebuild
    // whose `build_status:failed` arrives BEFORE the original turn
    // finished. Without the lock the orchestrator would fire a second
    // overlapping turn ("nervös"). With the lock, the second event is
    // dropped silently — but the lock clears in fireTurn's finally so
    // a LATER failure (after the turn is done) can still trigger.
    const bus = new SpecEventBus();
    const fired: Array<{ buildN: number | undefined }> = [];
    let releaseTurn: (() => void) | null = null;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });

    const draftStore = {
      load: async () => ({
        id: 'd1',
        userEmail: 'op@example.com',
        spec: {
          ...emptyAgentSpec(),
          template: 'agent-integration',
          id: 'de.byte5.agent.x',
          name: 'X',
          description: 'd',
          category: 'analysis',
          skill: { role: 'r' },
          playbook: { when_to_use: 'w' },
          builder_settings: { auto_fix_enabled: true },
        },
        codegenModel: 'sonnet',
      }),
      update: async () => null,
    } as unknown as DraftStore;

    const builderAgent = {
      runTurn: (opts: { userMessage: string }) => {
        const m = opts.userMessage.match(/Build #(\d+)/);
        fired.push({ buildN: m ? Number(m[1]) : undefined });
        return (async function* () {
          // Hold the iterator open so the orchestrator's pause-lock
          // stays held across subsequent emits — the test releases it
          // explicitly when ready.
          await turnGate;
          yield { type: 'turn_started', turnId: 't' };
        })();
      },
    } as unknown as BuilderAgent;

    const orchestrator = new AutoFixOrchestrator({
      bus,
      draftStore,
      builderAgent,
      defaultModel: 'claude-haiku-4-5-20251001',
      resolveModelId: () => 'claude-haiku-4-5-20251001',
      logger: () => {},
    });
    orchestrator.ensureSubscribed('d1', 'op@example.com');

    // Failure #1 arms the lock and starts a turn that we hold open.
    bus.emit('d1', buildFailed([{ code: 'TS2322' }], 1));
    await settle();
    assert.equal(fired.length, 1);
    assert.ok(orchestrator.inspectStreak('d1')?.inFlightTurnId !== null, 'lock held');

    // Failure #2 lands during the in-flight turn — DROPPED.
    bus.emit('d1', buildFailed([{ code: 'TS7006' }], 2));
    await settle();
    assert.equal(fired.length, 1, 'second concurrent failure must NOT fire a parallel turn');

    // Release the held turn, let the lock clear.
    releaseTurn?.();
    await settle();
    await settle();
    assert.equal(orchestrator.inspectStreak('d1')?.inFlightTurnId, null, 'lock cleared after turn');

    // A LATER failure (after release) should fire normally — proves the
    // lock isn't permanently stuck.
    bus.emit('d1', buildFailed([{ code: 'TS2304' }], 3));
    await settle();
    await settle();
    assert.equal(fired.length, 2, 'failure after lock-clear fires fresh turn');
  });

  it('clears the in-flight lock even when the turn iterator throws', async () => {
    // Defense in depth: a buggy BuilderAgent that throws mid-turn must
    // not wedge the lock. The .finally() in tryTrigger has to run.
    const bus = new SpecEventBus();
    const draftStore = {
      load: async () => ({
        id: 'd1',
        userEmail: 'op@example.com',
        spec: {
          ...emptyAgentSpec(),
          template: 'agent-integration',
          id: 'de.byte5.agent.x',
          name: 'X',
          description: 'd',
          category: 'analysis',
          skill: { role: 'r' },
          playbook: { when_to_use: 'w' },
          builder_settings: { auto_fix_enabled: true },
        },
        codegenModel: 'sonnet',
      }),
      update: async () => null,
    } as unknown as DraftStore;

    const builderAgent = {
      runTurn: () =>
        (async function* () {
          throw new Error('synthetic agent crash');
        })(),
    } as unknown as BuilderAgent;

    const orchestrator = new AutoFixOrchestrator({
      bus,
      draftStore,
      builderAgent,
      defaultModel: 'claude-haiku-4-5-20251001',
      resolveModelId: () => 'claude-haiku-4-5-20251001',
      logger: () => {},
    });
    orchestrator.ensureSubscribed('d1', 'op@example.com');

    bus.emit('d1', buildFailed([{ code: 'TS2322' }], 1));
    await settle();
    await settle();
    assert.equal(
      orchestrator.inspectStreak('d1')?.inFlightTurnId,
      null,
      'lock must clear even when fireTurn rejects',
    );
  });
});
