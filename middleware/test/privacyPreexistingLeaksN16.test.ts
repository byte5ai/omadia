/**
 * S2-N16 (#1540) — Privacy Shield leak paths that predate the shield's guards.
 *
 * 1. The canvas skeleton is composed before the turn has a privacy handle:
 *    with a guard running, the text goes through its stored-text scope.
 * 2. The significance scorer (live capture, bulk promotion, scratch reaper)
 *    masks the stored text it scores.
 * 3. A note written in an unprotected turn is marked, and refused to a turn
 *    the shield masks; the readers of the raw store carry the mark over.
 * 5. A plugin's `getNeighbors` under a shield skips content of unprotected
 *    turns.
 * 6. Stored processes carry their provenance; the process tools and the
 *    plan-runner's reuse skip unprotected ones under a shield.
 * 7. The builder preview chat is refused under OMADIA_PRIVACY_FORCE_GUARDED.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { LlmProvider, LlmRequest, LlmResponse } from '@omadia/llm-provider';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { InMemoryMemoryStore, MemoryToolHandler } from '@omadia/memory';
import type {
  EditProcessInput,
  KnowledgeGraph,
  MemorableKnowledgeIngest,
  PrivacyGuardService,
  PrivacyPromptMaskResult,
  ProcessMemoryService,
  ProcessRecord,
  QueryProcessesInput,
  WriteProcessInput,
  WriteProcessResult,
} from '@omadia/plugin-api';

import { composeSkeleton } from '../packages/omadia-ui-orchestrator/src/composition.js';
import { openSkeletonPrivacy } from '../packages/omadia-ui-orchestrator/src/skeletonPrivacy.js';
import { createJobPrivacy } from '../packages/harness-orchestrator-extras/src/jobPrivacy.js';
import { createHaikuSignificanceScorer } from '../packages/harness-orchestrator-extras/src/significanceScorer.js';
import { createScratchPromotionReaper } from '../packages/harness-orchestrator-extras/src/scratchPromotionReaper.js';
import { promoteRuleFileToDurable } from '../packages/harness-orchestrator-extras/src/promoteDurableRule.js';
import {
  isUnprotectedNote,
  markUnprotectedNote,
  stripUnprotectedNoteMarker,
  UNPROTECTED_NOTE_MARKER,
} from '../packages/harness-orchestrator-extras/src/noteProvenance.js';
import {
  ContextMemoryNamespacer,
  MemoryPathDenied,
  OrchestratorMemoryNamespacer,
  TURN_NOTE_PROVENANCE,
  type NoteProvenance,
} from '../packages/harness-orchestrator/src/orchestratorMemoryNamespacer.js';
import {
  createEditProcessHandler,
  createQueryProcessesHandler,
  createRunStoredProcessHandler,
  createWriteProcessHandler,
} from '../packages/harness-orchestrator/src/tools/processMemoryTool.js';
// The modules above are imported from source, so their turn context is too.
import { turnContext } from '../packages/harness-orchestrator/src/turnContext.js';
import { neighborsForPlugin } from '../src/platform/shieldedNeighbors.js';
import {
  PREVIEW_PRIVACY_REFUSED_CODE,
  PreviewChatService,
} from '../src/plugins/builder/previewChatService.js';

// --- shared fakes -----------------------------------------------------------

const REAL = 'anita.oliver@example-kunde.de';
const SURROGATE = 'person.1@example.net';

/** A guard whose stored-text scope swaps REAL for SURROGATE and back. */
function fakeGuard(opts: { outcome?: 'masked' | 'blocked' } = {}): PrivacyGuardService & {
  masked: string[];
} {
  const masked: string[] = [];
  return {
    masked,
    openStoredTextScope: () => ({
      async maskStoredText(text: string): Promise<PrivacyPromptMaskResult> {
        masked.push(text);
        if (opts.outcome === 'blocked') return { outcome: 'blocked', reason: 'residual' } as never;
        return { outcome: 'masked', maskedText: text.split(REAL).join(SURROGATE) } as never;
      },
      restoreStoredText: (text: string) => text.split(SURROGATE).join(REAL),
    }),
  } as unknown as PrivacyGuardService & { masked: string[] };
}

/** Runs `fn` inside a turn; `handle` is the turn's privacy handle, if any. */
function inTurn<T>(handle: { hasBypassed?: () => boolean } | undefined, fn: () => T): T {
  return turnContext.run(
    { turnId: 't-1', turnDate: '2026-10-28', ...(handle ? { privacyHandle: handle } : {}) } as never,
    fn,
  );
}
const PROTECTED = { hasBypassed: () => false };
const BYPASSED = { hasBypassed: () => true };

// --- 1. canvas skeleton -------------------------------------------------------

describe('#1540 · canvas skeleton under a privacy guard', () => {
  it('sends the masked text and restores the skeleton', async () => {
    const seen: string[] = [];
    const tree = {
      type: 'container',
      id: 'root',
      children: [{ type: 'heading', id: 'h', content: `Kontakt ${SURROGATE}`, level: 2 }],
    };
    const skeleton = await composeSkeleton({
      llm: {
        complete: async (req: { messages: Array<{ content: string }> }) => {
          seen.push(req.messages.map((m) => m.content).join('\n'));
          return { text: JSON.stringify({ tree, dataRequirements: [] }) };
        },
      } as never,
      model: 'm',
      userText: `Zeig mir ${REAL}`,
      privacy: openSkeletonPrivacy(fakeGuard()),
    });
    assert.ok(seen.length > 0);
    for (const prompt of seen) assert.ok(!prompt.includes(REAL), 'real value reached the model');
    assert.equal(skeleton.source, 'model');
    assert.ok(JSON.stringify(skeleton.tree).includes(REAL), 'skeleton not restored');
    assert.ok(!JSON.stringify(skeleton.tree).includes(SURROGATE));
  });

  it('falls back without a model call when the guard cannot mask', async () => {
    for (const guard of [
      fakeGuard({ outcome: 'blocked' }),
      {} as PrivacyGuardService, // a guard that predates openStoredTextScope
      {
        openStoredTextScope: () => {
          throw new Error('scope down');
        },
      } as unknown as PrivacyGuardService,
    ]) {
      let calls = 0;
      const skeleton = await composeSkeleton({
        llm: {
          complete: async () => {
            calls += 1;
            return { text: '{}' };
          },
        } as never,
        model: 'm',
        userText: `Zeig mir ${REAL}`,
        privacy: openSkeletonPrivacy(guard),
      });
      assert.equal(calls, 0);
      assert.equal(skeleton.source, 'fallback');
    }
  });
});

// --- 2. significance scorer ---------------------------------------------------

function recordingLlm(): LlmProvider & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    requests,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      requests.push(req);
      return {
        content: [{ type: 'text', text: '{"score":0.9,"entry_type":"memory"}' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
      } as never;
    },
  } as unknown as LlmProvider & { requests: LlmRequest[] };
}

describe('#1540 · significance scorer masks stored text', () => {
  it('scores the masked text through the stored-text scope', async () => {
    const llm = recordingLlm();
    const guard = fakeGuard();
    const scorer = createHaikuSignificanceScorer({
      llm,
      privacy: createJobPrivacy(() => guard, {}),
      log: () => {},
    });
    const result = await scorer.score(`Kunde ${REAL} will Rechnungen am 1.`);
    assert.equal(result.score, 0.9);
    assert.equal(guard.masked.length, 1);
    const wire = JSON.stringify(llm.requests);
    assert.ok(!wire.includes(REAL));
    assert.ok(wire.includes(SURROGATE));
  });

  it('throws without a model call when the run cannot mask (a failed score, not a zero)', async () => {
    const llm = recordingLlm();
    const scorer = createHaikuSignificanceScorer({
      llm,
      privacy: createJobPrivacy(() => fakeGuard({ outcome: 'blocked' }), {}),
      log: () => {},
    });
    await assert.rejects(() => scorer.score(`Kunde ${REAL}`), /privacy: blocked/);
    assert.equal(llm.requests.length, 0);
  });

  it('refuses under OMADIA_PRIVACY_FORCE_GUARDED with no guard running', async () => {
    const llm = recordingLlm();
    const scorer = createHaikuSignificanceScorer({
      llm,
      privacy: createJobPrivacy(() => undefined, { OMADIA_PRIVACY_FORCE_GUARDED: 'true' }),
      log: () => {},
    });
    await assert.rejects(() => scorer.score(`Kunde ${REAL}`));
    assert.equal(llm.requests.length, 0);
  });
});

// --- 3. memory notes ----------------------------------------------------------

describe('#1540 · note provenance helpers', () => {
  it('marks once, detects the marker anywhere as a line, strips it', () => {
    const marked = markUnprotectedNote(markUnprotectedNote('Notiz'));
    assert.equal(marked, `${UNPROTECTED_NOTE_MARKER}\nNotiz`);
    assert.ok(isUnprotectedNote(`---\npromoted-from: x\n---\n${marked}`));
    assert.equal(stripUnprotectedNoteMarker(marked), 'Notiz');
    assert.ok(!isUnprotectedNote(`inline ${UNPROTECTED_NOTE_MARKER} text`));
    assert.equal(stripUnprotectedNoteMarker('Notiz'), 'Notiz');
  });
});

describe('#1540 · memory tool and unprotected notes', () => {
  const NOTE = '/memories/customers/lilium.md';
  const PHYSICAL = '/memories/orchestrators/agent-a/customers/lilium.md';

  function namespacer(inner: InMemoryMemoryStore, shield: { on: boolean }) {
    return new OrchestratorMemoryNamespacer('agent-a', inner, () => shield.on, TURN_NOTE_PROVENANCE);
  }

  it('a note written without a shield is marked, and refused to a shielded turn', async () => {
    const inner = new InMemoryMemoryStore();
    const shield = { on: false };
    const tool = new MemoryToolHandler(namespacer(inner, shield));
    await inTurn(undefined, () =>
      tool.handle({ command: 'create', path: NOTE, file_text: `Kontakt: ${REAL}` }),
    );
    assert.ok(isUnprotectedNote(await inner.readFile(PHYSICAL)));

    // Still no shield: the model reads it, without the marker line.
    const plain = await inTurn(undefined, () => tool.handle({ command: 'view', path: NOTE }));
    assert.ok(plain.includes(REAL));
    assert.ok(!plain.includes(UNPROTECTED_NOTE_MARKER));

    // A shield arrives: a turn it masks is refused, str_replace too.
    shield.on = true;
    const viewed = await inTurn(PROTECTED, () => tool.handle({ command: 'view', path: NOTE }));
    assert.ok(!viewed.includes(REAL), viewed);
    assert.match(viewed, /without the Privacy Shield/);
    const replaced = await inTurn(PROTECTED, () =>
      tool.handle({ command: 'str_replace', path: NOTE, old_str: 'Kontakt', new_str: 'X' }),
    );
    assert.ok(!replaced.includes(REAL));
    // A bypassed turn still has a handle: refused as well.
    const bypassed = await inTurn(BYPASSED, () => tool.handle({ command: 'view', path: NOTE }));
    assert.ok(!bypassed.includes(REAL));
    // A turn without a handle (the subscription CLI) keeps its notes.
    const cli = await inTurn(undefined, () => tool.handle({ command: 'view', path: NOTE }));
    assert.ok(cli.includes(REAL));

    // Deleting or overwriting it from a protected turn is allowed.
    await inTurn(PROTECTED, () => tool.handle({ command: 'delete', path: NOTE }));
    assert.equal(await inner.fileExists(PHYSICAL), false);
  });

  it('a note written in a protected turn is stored as written and readable under the shield', async () => {
    const inner = new InMemoryMemoryStore();
    const shield = { on: true };
    const tool = new MemoryToolHandler(namespacer(inner, shield));
    await inTurn(PROTECTED, () =>
      tool.handle({ command: 'create', path: NOTE, file_text: `Kontakt: ${SURROGATE}` }),
    );
    assert.equal(await inner.readFile(PHYSICAL), `Kontakt: ${SURROGATE}`);
    const viewed = await inTurn(PROTECTED, () => tool.handle({ command: 'view', path: NOTE }));
    assert.ok(viewed.includes(SURROGATE));
  });

  it('a write after a tool bypassed the shield is marked; no turn context counts as unprotected', async () => {
    const inner = new InMemoryMemoryStore();
    const ns = namespacer(inner, { on: true });
    await inTurn(BYPASSED, () => ns.writeFile(NOTE, 'a'));
    assert.ok(isUnprotectedNote(await inner.readFile(PHYSICAL)));
    await ns.writeFile('/memories/x.md', 'b');
    assert.ok(isUnprotectedNote(await inner.readFile('/memories/orchestrators/agent-a/x.md')));
  });

  it('the context namespacer applies the same rule (shared _rules/ included)', async () => {
    const inner = new InMemoryMemoryStore();
    const shield = { on: false };
    const provenance: NoteProvenance = { writtenUnprotected: () => true, readerShielded: () => true };
    const ns = new ContextMemoryNamespacer(
      { privateRoot: '/memories/contexts/a/channel/k', shieldActive: () => shield.on, noteProvenance: provenance },
      inner,
    );
    await ns.writeFile('/memories/_rules/odoo.md', `Regel ${REAL}`);
    assert.ok(isUnprotectedNote(await inner.readFile('/memories/_rules/odoo.md')));
    shield.on = true;
    await assert.rejects(() => ns.readFile('/memories/_rules/odoo.md'), MemoryPathDenied);
  });

  it('without injected provenance a marked note is still refused under the shield', async () => {
    const inner = new InMemoryMemoryStore();
    await inner.writeFile(PHYSICAL, markUnprotectedNote(REAL));
    const ns = new OrchestratorMemoryNamespacer('agent-a', inner, () => true);
    await assert.rejects(() => ns.readFile(NOTE), MemoryPathDenied);
    await ns.writeFile('/memories/y.md', 'plain');
    assert.equal(await inner.readFile('/memories/orchestrators/agent-a/y.md'), 'plain');
  });
});

describe('#1540 · plugin memory is refused to the memory tool under a shield', () => {
  it('blocks /memories/plugins and ~agent/plugins while the shield is active', async () => {
    const inner = new InMemoryMemoryStore();
    await inner.writeFile('/memories/orchestrators/agent-a/plugins/crm/cache.json', REAL);
    const shield = { on: true };
    const ns = new OrchestratorMemoryNamespacer('agent-a', inner, () => shield.on);
    await assert.rejects(() => ns.readFile('/memories/plugins/crm/cache.json'), MemoryPathDenied);
    await assert.rejects(() => ns.list('/memories/plugins'), MemoryPathDenied);
    await assert.rejects(() => ns.readFile('/memories/x/../plugins/crm/cache.json'), MemoryPathDenied);
    const ctxNs = new ContextMemoryNamespacer(
      { privateRoot: '/memories/contexts/agent-a/channel/k', agentRoot: '/memories/orchestrators/agent-a', shieldActive: () => shield.on },
      inner,
    );
    await assert.rejects(() => ctxNs.readFile('/memories/~agent/plugins/crm/cache.json'), MemoryPathDenied);
    shield.on = false;
    assert.equal(await ns.readFile('/memories/plugins/crm/cache.json'), REAL);
  });
});

describe('#1540 · raw-store readers carry the mark over', () => {
  it('the durable-rule promotion strips the marker and stamps the memory', async () => {
    const created: MemorableKnowledgeIngest[] = [];
    const kg = {
      async createMemorableKnowledge(input: MemorableKnowledgeIngest) {
        created.push(input);
        return { memorableKnowledgeNodeId: 'mk:1', skippedInvolved: 0, skippedRequired: 0, skippedDerivedFrom: 0 };
      },
    } as unknown as KnowledgeGraph;
    const pool = { query: async () => ({ rows: [] }) } as never;
    await promoteRuleFileToDurable({
      pool,
      kg,
      tenantId: 't',
      virtualPath: '/memories/_rules/odoo.md',
      content: markUnprotectedNote(`Regel für ${REAL}`),
    });
    assert.equal(created.length, 1);
    assert.equal(created[0]?.unprotected, true);
    assert.ok(!JSON.stringify(created[0]).includes(UNPROTECTED_NOTE_MARKER));
  });

  it('the scratch reaper scores without the marker and stamps the memory', async () => {
    const body = `SIGNIFICANT: ${REAL} bekommt Rechnungen am 1. des Monats, netto 14 Tage, als PDF an die Buchhaltung.`;
    const rows = [{ virtual_path: '/memories/orchestrators/a/note.md', content: markUnprotectedNote(body) }];
    const pool = {
      query: async (sql: string) => (/SELECT/i.test(sql) ? { rows } : { rows: [] }),
    } as never;
    const scored: string[] = [];
    const created: MemorableKnowledgeIngest[] = [];
    const reaper = createScratchPromotionReaper({
      pool,
      tenantId: 'default',
      kg: {
        async createMemorableKnowledge(input: MemorableKnowledgeIngest) {
          created.push(input);
          return { memorableKnowledgeNodeId: 'mk:1', skippedInvolved: 0, skippedRequired: 0, skippedDerivedFrom: 0 };
        },
      } as unknown as KnowledgeGraph,
      scorer: {
        async score(text: string) {
          scored.push(text);
          return { score: 0.95 };
        },
      },
      threshold: 0.6,
      ageMs: 0,
      intervalMs: 60_000,
      defaultVisibility: 'team',
      log: () => {},
    });
    await reaper.runOnce();
    assert.equal(created.length, 1);
    assert.equal(created[0]?.unprotected, true);
    assert.ok(!scored.join('').includes(UNPROTECTED_NOTE_MARKER));
    assert.ok(!created[0]?.summary.includes(UNPROTECTED_NOTE_MARKER));
  });
});

// --- 5. plugin getNeighbors -------------------------------------------------

describe('#1540 · plugin getNeighbors under a shield', () => {
  async function seed() {
    const kg = new InMemoryKnowledgeGraph();
    const base = { userMessage: `Wer ist ${REAL}?`, assistantAnswer: 'Anita Oliver.', entityRefs: [] };
    const open = await kg.ingestTurn({ scope: 's', time: '2026-10-28T09:01:00.000Z', ...base, unprotected: true });
    const guarded = await kg.ingestTurn({ scope: 's', time: '2026-10-28T09:02:00.000Z', ...base, unprotected: false });
    await kg.ingestFacts([
      { factId: 'fact:open', sourceTurnId: open.turnId, subject: 'Anita Oliver', predicate: 'is', object: 'Kontakt' },
      { factId: 'fact:guarded', sourceTurnId: guarded.turnId, subject: 'person', predicate: 'is', object: 'Kontakt' },
    ] as never);
    const mk = await kg.createMemorableKnowledge({
      kind: 'reference',
      summary: `Anita Oliver ${REAL}`,
      createdBy: 'auto:x',
      aclOwners: [],
      derivedFromTurnIds: [open.turnId],
    } as never);
    return { kg, open: open.turnId, guarded: guarded.turnId, mk: mk.memorableKnowledgeNodeId };
  }

  it('drops unprotected turns and what was derived from them', async () => {
    const s = await seed();
    const session = (await s.kg.getNeighbors(s.open)).find((n) => n.type === 'Session');
    assert.ok(session);
    const all = await neighborsForPlugin(s.kg, session.id, false);
    assert.ok(all.some((n) => n.id === s.open));
    const shielded = await neighborsForPlugin(s.kg, session.id, true);
    assert.ok(!shielded.some((n) => n.id === s.open));
    assert.ok(shielded.some((n) => n.id === s.guarded));

    const aroundOpen = (await neighborsForPlugin(s.kg, s.open, true)).map((n) => n.id);
    assert.ok(!aroundOpen.includes('fact:open'));
    assert.ok(!aroundOpen.includes(s.mk));
    const aroundGuarded = (await neighborsForPlugin(s.kg, s.guarded, true)).map((n) => n.id);
    assert.ok(aroundGuarded.includes('fact:guarded'));
  });
});

// --- 6. stored processes ------------------------------------------------------

function processService(stored: ProcessRecord, duplicate?: WriteProcessResult) {
  const calls = { write: [] as WriteProcessInput[], edit: [] as EditProcessInput[], query: [] as QueryProcessesInput[] };
  const service: ProcessMemoryService = {
    async write(input) {
      calls.write.push(input);
      return duplicate ?? { ok: true, record: { ...stored, ...(input.unprotected ? { unprotected: true } : {}) } };
    },
    async edit(input) {
      calls.edit.push(input);
      return { ok: true, record: stored };
    },
    async query(input) {
      calls.query.push(input);
      return input.excludeUnprotected && stored.unprotected ? [] : [{ record: stored, score: 0.9 }];
    },
    async get() {
      return stored;
    },
    async history() {
      return [];
    },
  };
  return { service, calls };
}

const OPEN_PROCESS: ProcessRecord = {
  id: 'process:s:kunde-anita-oliver-mahnen',
  scope: 's',
  title: 'Kunde: Anita Oliver mahnen',
  steps: [`Mail an ${REAL}`],
  visibility: 'team',
  version: 1,
  createdAt: '2026-10-28T09:00:00.000Z',
  updatedAt: '2026-10-28T09:00:00.000Z',
  unprotected: true,
};

describe('#1540 · process provenance in the process tools', () => {
  it('write and edit stamp the provenance of the writing turn', async () => {
    const { service, calls } = processService({ ...OPEN_PROCESS, unprotected: undefined });
    const write = createWriteProcessHandler(service);
    const edit = createEditProcessHandler(service);
    const input = { title: 'Backend: Deploy', steps: ['a'], scope: 's' };
    await inTurn(undefined, () => write(input));
    await inTurn(PROTECTED, () => write(input));
    await inTurn(BYPASSED, () => write(input));
    assert.deepEqual(calls.write.map((c) => c.unprotected === true), [true, false, true]);
    await inTurn(undefined, () => edit({ id: 'p', visibility: 'team' }));
    await inTurn(PROTECTED, () => edit({ id: 'p', visibility: 'team' }));
    assert.deepEqual(calls.edit.map((c) => c.unprotected === true), [true, false]);
  });

  it('under a shield query, run and duplicate never show an unprotected process', async () => {
    const { service, calls } = processService(OPEN_PROCESS, {
      ok: false,
      reason: 'duplicate',
      conflictingId: OPEN_PROCESS.id,
      conflictingTitle: OPEN_PROCESS.title,
      similarity: 0.97,
      conflictingUnprotected: true,
    });
    const query = createQueryProcessesHandler(service);
    const run = createRunStoredProcessHandler(service);
    const write = createWriteProcessHandler(service);
    const edit = createEditProcessHandler(service);

    const shielded = [
      await inTurn(PROTECTED, () => query({ query: 'mahnen' })),
      await inTurn(PROTECTED, () => run({ id: OPEN_PROCESS.id })),
      await inTurn(PROTECTED, () => write({ title: 'Kunde: Mahnung', steps: ['a'], scope: 's' })),
      await inTurn(PROTECTED, () => edit({ id: OPEN_PROCESS.id, visibility: 'team' })),
    ].map(String);
    assert.equal(calls.query[0]?.excludeUnprotected, true);
    for (const out of shielded) {
      assert.ok(!out.includes('Anita'), out);
      assert.ok(!out.includes(REAL), out);
      assert.ok(!out.includes('anita-oliver'), out);
    }

    // Without a handle nothing is filtered.
    const open = String(await inTurn(undefined, () => run({ id: OPEN_PROCESS.id })));
    assert.ok(open.includes('Anita Oliver'));
  });
});

describe('#1540 · plan-runner reuses no unprotected process under a shield', () => {
  it('passes excludeUnprotected inside a shielded turn', async () => {
    // The plan-runner imports turnContext from the orchestrator's dist, so the
    // turn is opened through that layer here.
    const { turnContext: distTurnContext } = await import('@omadia/orchestrator');
    const { pickReusableProcess } = await import('@omadia/plugin-plan-runner/dist/plugin.js');
    const { service, calls } = processService(OPEN_PROCESS);
    const reuse = await distTurnContext.run(
      { turnId: 't', turnDate: '2026-10-28', privacyHandle: PROTECTED } as never,
      () => pickReusableProcess(service, 'mahnen', 0.5),
    );
    assert.equal(reuse, null);
    assert.equal(calls.query[0]?.excludeUnprotected, true);
    const open = await pickReusableProcess(service, 'mahnen', 0.5);
    assert.equal(open?.title, OPEN_PROCESS.title);
  });
});

// --- 7. builder preview chat --------------------------------------------------

describe('#1540 · builder preview chat under OMADIA_PRIVACY_FORCE_GUARDED', () => {
  it('refuses before the draft is touched or a model resolved', async () => {
    let touched = 0;
    const service = new PreviewChatService({
      resolveProvider: async () => {
        touched += 1;
        throw new Error('no');
      },
      draftStore: {
        load: async () => {
          touched += 1;
          return null;
        },
        update: async () => {
          touched += 1;
        },
      } as never,
      policyEnv: { OMADIA_PRIVACY_FORCE_GUARDED: 'true' },
    });
    const events = [];
    for await (const ev of service.runTurn({
      handle: { draftId: 'd', agentId: 'a', toolkit: { tools: [] } } as never,
      userEmail: 'u@example.com',
      userMessage: `Suche ${REAL}`,
      modelChoice: 'sonnet',
    })) {
      events.push(ev);
    }
    assert.equal(touched, 0);
    assert.deepEqual(events.map((e) => e.type), ['error']);
    assert.equal((events[0] as { code: string }).code, PREVIEW_PRIVACY_REFUSED_CODE);
  });
});
