import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { EmbeddingClient } from '@omadia/embeddings';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { ContextRetriever } from '@omadia/orchestrator-extras';
import type { RecallRelevanceJudge } from '@omadia/orchestrator-extras';

// B1 · durable-curation tier.
//
// Manual-authored MemorableKnowledge of the configured kinds must surface in
// recall UNCONDITIONALLY: independent of the turn-term gate (so it survives a
// term-less follow-up), with a low/no cosine floor (so a paraphrase still
// hits), and — critically — it must NEVER be handed to the relevance judge.
// A fuzzy insight (manuallyAuthored=false) must keep going through the gate +
// floor + judge exactly as before.

// A query vector and a DELIBERATELY low-overlap durable vector. cosine is low
// (well under the fuzzy 0.6 floor) but > 0, so the durable tier (min-sim 0)
// admits it while the fuzzy leg would not.
const QUERY_VEC: number[] = [1, 0, 0, 0];
const LOW_VEC: number[] = [0.2, 0.98, 0, 0]; // cosine(QUERY,LOW) ≈ 0.2

/** Every text embeds to the query vector — the MK side is seeded directly via
 *  `setEmbedding`, so query↔MK cosine is governed by the seeded MK vector. */
const queryEmbedder: EmbeddingClient = {
  async embed(): Promise<number[]> {
    return [...QUERY_VEC];
  },
};

/** Seed a durable (manual-authored) MK of the given kind with a LOW-cosine
 *  embedding versus the query. Returns its node id. */
async function seedDurableMk(
  kg: InMemoryKnowledgeGraph,
  kind: string,
  summary: string,
): Promise<string> {
  // Exercise the real B2 ingest path: `manuallyAuthored: true` flows through
  // createMemorableKnowledge → the top-level marker — no test-only setter.
  const created = await kg.createMemorableKnowledge({
    kind,
    summary,
    createdBy: 'web:bob',
    involvedOmadiaUserIds: [],
    aclOwners: ['bob'], // non-owner viewer ⇒ needs teamVisibility
    manuallyAuthored: true,
  });
  const id = created.memorableKnowledgeNodeId;
  kg.setEmbedding(id, LOW_VEC);
  return id;
}

/** Seed a fuzzy (auto-captured, manuallyAuthored=false) MK aligned to the
 *  query so it would clear the fuzzy floor and reach the judge. */
async function seedFuzzyMk(
  kg: InMemoryKnowledgeGraph,
  summary: string,
): Promise<string> {
  const created = await kg.createMemorableKnowledge({
    kind: 'reference',
    summary,
    createdBy: 'web:bob',
    involvedOmadiaUserIds: [],
    aclOwners: ['bob'],
  });
  kg.setEmbedding(created.memorableKnowledgeNodeId, [...QUERY_VEC]);
  return created.memorableKnowledgeNodeId;
}

/** A judge that records every candidate id it ever sees and drops all
 *  `insight` candidates. Durable hits must NOT appear in `seen`. */
function recordingJudge(): {
  judge: RecallRelevanceJudge;
  seen: Set<string>;
} {
  const seen = new Set<string>();
  const judge: RecallRelevanceJudge = {
    async filterRelevant(_msg, candidates): Promise<Set<string>> {
      for (const c of candidates) seen.add(c.id);
      // Reject every insight; keep plans/processes.
      return new Set(
        candidates.filter((c) => c.kind !== 'insight').map((c) => c.id),
      );
    },
  };
  return { judge, seen };
}

describe('B1 · durable-curation tier surfaces manual MK', () => {
  it('(a) WITH terms: low-cosine durable reference surfaces despite the fuzzy floor', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const mkId = await seedDurableMk(
      kg,
      'reference',
      'Die Reisekosten-DSN liegt im Vault unter billing/staging',
    );
    const retriever = new ContextRetriever(
      kg,
      { teamVisibility: true },
      queryEmbedder,
    );
    const result = await retriever.assembleForBudget({
      userMessage: 'Wie lauten die Urlaubsregeln für Teilzeitkräfte?',
      agentId: 'test-agent',
      sessionScope: 'sess-now',
      userId: 'alice',
    });
    assert.equal(result.recalled.insights.length, 1, 'durable insight present');
    assert.equal(result.recalled.insights[0]!.mkId, mkId);
  });

  it('(b) TERM-LESS follow-up: durable still surfaces (bypasses the turn gate)', async () => {
    const kg = new InMemoryKnowledgeGraph();
    // Also seed a fuzzy MK; on a term-less turn the fuzzy leg must stay closed
    // while the durable leg still fires.
    await seedFuzzyMk(kg, 'auto-captured note that must NOT surface term-less');
    const mkId = await seedDurableMk(kg, 'decision', 'Wir nutzen Odoo 17 CE');
    const retriever = new ContextRetriever(
      kg,
      { teamVisibility: true },
      queryEmbedder,
    );
    const result = await retriever.assembleForBudget({
      userMessage: 'ok?', // no extractable terms → fuzzy gate closes
      agentId: 'test-agent',
      sessionScope: 'sess-now',
      userId: 'alice',
    });
    assert.equal(
      result.recalled.insights.length,
      1,
      'only the durable insight survives the term-less turn',
    );
    assert.equal(result.recalled.insights[0]!.mkId, mkId);
  });

  it('(c) paraphrased query: low-cosine durable still surfaces', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const mkId = await seedDurableMk(
      kg,
      'reference',
      'Stammdaten-Konvention: Kundennummern sind 6-stellig',
    );
    const retriever = new ContextRetriever(
      kg,
      { teamVisibility: true },
      queryEmbedder,
    );
    // A topically-distant paraphrase — embeds to QUERY_VEC, cosine ≈ 0.2 to the
    // MK. The fuzzy leg (floor 0.6) would drop it; the durable leg keeps it.
    const result = await retriever.assembleForBudget({
      userMessage: 'Erzähl mir etwas völlig anderes über das Wetter',
      agentId: 'test-agent',
      sessionScope: 'sess-now',
      userId: 'alice',
    });
    assert.equal(result.recalled.insights.length, 1);
    assert.equal(result.recalled.insights[0]!.mkId, mkId);
  });

  it('OPT-OUT (durableRelevanceJudgeEnabled=false): durable bypasses the judge and always surfaces', async () => {
    // The default is now judge=ON (R4). Operators who want the legacy #317
    // unconditional always-surface set durableRelevanceJudgeEnabled=false to
    // restore the bypass — durable then never reaches the judge.
    const kg = new InMemoryKnowledgeGraph();
    const durableId = await seedDurableMk(
      kg,
      'reference',
      'Durable curated fact that must bypass the judge',
    );
    const { judge, seen } = recordingJudge();
    const retriever = new ContextRetriever(
      kg,
      { teamVisibility: true, durableRelevanceJudgeEnabled: false },
      queryEmbedder,
      undefined,
      undefined,
      judge,
    );
    const result = await retriever.assembleForBudget({
      userMessage: 'Was waren die wichtigsten Buchungsregeln?',
      agentId: 'test-agent',
      sessionScope: 'sess-now',
      userId: 'alice',
    });
    // The judge would have dropped any insight it saw → durable survives only
    // because it never reached the judge.
    assert.equal(result.recalled.insights.length, 1, 'durable insight kept');
    assert.equal(result.recalled.insights[0]!.mkId, durableId);
    assert.equal(
      seen.has(durableId),
      false,
      'durable id must NOT appear in the judge candidate set',
    );
  });

  it('OPT-IN (durableRelevanceJudgeEnabled): durable IS submitted to the judge and an off-topic one is dropped', async () => {
    // R4 fix: when the operator opts in, durable joins the judge candidate set
    // so an off-topic curated fact no longer surfaces for an unrelated query.
    const kg = new InMemoryKnowledgeGraph();
    const durableId = await seedDurableMk(
      kg,
      'reference',
      'Durable curated fact the judge will reject as off-topic',
    );
    const { judge, seen } = recordingJudge(); // drops every insight
    const retriever = new ContextRetriever(
      kg,
      { teamVisibility: true, durableRelevanceJudgeEnabled: true },
      queryEmbedder,
      undefined,
      undefined,
      judge,
    );
    const result = await retriever.assembleForBudget({
      userMessage: 'Was waren die wichtigsten Buchungsregeln?',
      agentId: 'test-agent',
      sessionScope: 'sess-now',
      userId: 'alice',
    });
    assert.equal(seen.has(durableId), true, 'durable id reached the judge when opted in');
    assert.equal(
      result.recalled.insights.length,
      0,
      'off-topic durable dropped by the judge under opt-in',
    );
  });

  it('OPT-IN: durable is judged even on a TERM-LESS message (closed gate — Forge C1)', async () => {
    // The opt-in must filter durable on the canonical R4 path: a term-less
    // message ("ok") closes the cross-session gate, but durable still loads
    // unconditionally and must reach the judge so an off-topic curated fact
    // does not surface for a contentless turn.
    const kg = new InMemoryKnowledgeGraph();
    const durableId = await seedDurableMk(kg, 'reference', 'Off-topic durable fact');
    const { judge, seen } = recordingJudge(); // drops every insight
    const retriever = new ContextRetriever(
      kg,
      { teamVisibility: true, durableRelevanceJudgeEnabled: true },
      queryEmbedder,
      undefined,
      undefined,
      judge,
    );
    const result = await retriever.assembleForBudget({
      userMessage: 'ok', // no candidate term → cross-session gate CLOSED
      agentId: 'test-agent',
      sessionScope: 'sess-now',
      userId: 'alice',
    });
    assert.equal(seen.has(durableId), true, 'durable judged despite closed gate');
    assert.equal(result.recalled.insights.length, 0, 'off-topic durable dropped on term-less turn');
  });

  it('OPT-IN: a durable the judge KEEPS still surfaces (always-surface preserved for on-topic)', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const durableId = await seedDurableMk(kg, 'reference', 'On-topic durable fact');
    const keepAll: RecallRelevanceJudge = {
      async filterRelevant(_msg, candidates): Promise<Set<string>> {
        return new Set(candidates.map((c) => c.id));
      },
    };
    const retriever = new ContextRetriever(
      kg,
      { teamVisibility: true, durableRelevanceJudgeEnabled: true },
      queryEmbedder,
      undefined,
      undefined,
      keepAll,
    );
    const result = await retriever.assembleForBudget({
      userMessage: 'Was waren die wichtigsten Buchungsregeln?',
      agentId: 'test-agent',
      sessionScope: 'sess-now',
      userId: 'alice',
    });
    assert.equal(result.recalled.insights.length, 1, 'kept durable surfaces');
    assert.equal(result.recalled.insights[0]!.mkId, durableId);
  });

  it('a fuzzy insight still goes through gate + floor + judge unchanged', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const fuzzyId = await seedFuzzyMk(kg, 'generic auto-captured billing note');
    const { judge, seen } = recordingJudge();
    const retriever = new ContextRetriever(
      kg,
      { teamVisibility: true },
      queryEmbedder,
      undefined,
      undefined,
      judge,
    );
    const result = await retriever.assembleForBudget({
      userMessage: 'how do I run the billing migration in staging?',
      agentId: 'test-agent',
      sessionScope: 'sess-now',
      userId: 'alice',
    });
    // The fuzzy MK reached the judge (recorded) and was dropped (kind=insight).
    assert.equal(seen.has(fuzzyId), true, 'fuzzy insight reached the judge');
    assert.equal(
      result.recalled.insights.length,
      0,
      'fuzzy insight judged out — pre-B1 behaviour preserved',
    );
  });

  it('durableTierDisabled=true restores pre-tier behaviour (no durable insertion)', async () => {
    const kg = new InMemoryKnowledgeGraph();
    await seedDurableMk(kg, 'reference', 'Durable fact that must stay hidden');
    const retriever = new ContextRetriever(
      kg,
      { teamVisibility: true, durableTierDisabled: true },
      queryEmbedder,
    );
    const result = await retriever.assembleForBudget({
      userMessage: 'Wie lauten die Urlaubsregeln?',
      agentId: 'test-agent',
      sessionScope: 'sess-now',
      userId: 'alice',
    });
    assert.equal(
      result.recalled.insights.length,
      0,
      'durable tier off → low-cosine manual MK does not surface',
    );
  });

  it('only the configured durableKinds are admitted (a non-durable kind is ignored)', async () => {
    const kg = new InMemoryKnowledgeGraph();
    // kind 'scratch' is NOT in the default reference,decision set.
    await seedDurableMk(kg, 'scratch', 'manual but wrong kind');
    const retriever = new ContextRetriever(
      kg,
      { teamVisibility: true },
      queryEmbedder,
    );
    const result = await retriever.assembleForBudget({
      userMessage: 'Wie lauten die Urlaubsregeln?',
      agentId: 'test-agent',
      sessionScope: 'sess-now',
      userId: 'alice',
    });
    assert.equal(result.recalled.insights.length, 0, 'wrong kind not admitted');
  });

  it('(e) durable insight renders FULL-length (not truncated to the fuzzy 300 cap)', async () => {
    const kg = new InMemoryKnowledgeGraph();
    // A long curated schema (>300 chars) — must reach the agent complete so it
    // doesn't re-run discovery tools for fields it already has.
    const longSchema =
      '# Dynamics: Kurse / Seminare liegen in ud_tutorial (entitySet ud_tutorials). ' +
      'Felder: ud_name (Name), ud_coursenumber (Kursnummer), ud_startdatetime (Start), ' +
      'ud_enddatetime (Ende), ud_msa_city (Ort), ud_maxparticipants (Kapazität), ' +
      'ud_price (Preis). Buchungen: ud_booking. Teilnehmer: ud_participant. ' +
      'Registrierungen: ud_registration. Filter für Zeiträume über ud_startdatetime.';
    assert.ok(longSchema.length > 300, 'fixture must exceed fuzzy cap');
    const mkId = await seedDurableMk(kg, 'reference', longSchema);
    const retriever = new ContextRetriever(
      kg,
      { teamVisibility: true },
      queryEmbedder,
    );
    const result = await retriever.assembleForBudget({
      userMessage: 'Welche Kurse finden nächste Woche statt?',
      agentId: 'test-agent',
      sessionScope: 'sess-now',
      userId: 'alice',
    });
    assert.equal(result.recalled.insights.length, 1);
    const ins = result.recalled.insights[0]!;
    assert.equal(ins.mkId, mkId);
    assert.equal(ins.durable, true, 'flagged durable');
    assert.ok(
      ins.summary.length > 300,
      `durable summary must NOT be cut to 300 (got ${String(ins.summary.length)})`,
    );
    // The full schema text reaches the rendered recall block (agent prompt).
    assert.match(result.text, /ud_participant/);
  });
});
