/**
 * #1863 — an entry a user corrected on `/memories` reaches recall as the
 * user's latest word: it carries the day of the correction and the
 * "vom Nutzer korrigiert" marker, other entries carry their date, and the
 * orchestrator's trust rules let the corrected entry outrank older turns and
 * notes. Only a content change stamps the correction.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { EmbeddingClient } from '@omadia/embeddings';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { ContextRetriever, USER_CORRECTED_MARKER } from '@omadia/orchestrator-extras';
import { MEMORY_CORRECTED_AT_PROP, isMemorableContentCorrection } from '@omadia/plugin-api';

const ALIGNED: number[] = [1, 0, 0, 0];
const stubEmbedder: EmbeddingClient = {
  async embed(): Promise<number[]> {
    return [...ALIGNED];
  },
};
const OWNER = 'bob';
const today = (): string => new Date().toISOString().slice(0, 10);

async function seed() {
  const kg = new InMemoryKnowledgeGraph();
  const edited = await kg.createMemorableKnowledge({
    kind: 'reference',
    summary: 'Projekt Storch startet am 7. Dezember.',
    createdBy: 'web:bob',
    involvedOmadiaUserIds: [],
    aclOwners: [OWNER],
    // ADR-0183 — shared on purpose, so alice's recall may see it.
    visibility: 'team',
  });
  const untouched = await kg.createMemorableKnowledge({
    kind: 'insight',
    summary: 'Projekt Storch läuft im Team Nord.',
    createdBy: 'web:bob',
    involvedOmadiaUserIds: [],
    aclOwners: [OWNER],
    // ADR-0183 — shared on purpose, so alice's recall may see it.
    visibility: 'team',
  });
  return { kg, editedId: edited.memorableKnowledgeNodeId, untouchedId: untouched.memorableKnowledgeNodeId };
}

describe('corrected memorable knowledge in recall (#1863)', () => {
  it('stamps a content correction, not a significance-only patch', async () => {
    const { kg, editedId, untouchedId } = await seed();
    await kg.updateMemorableKnowledge(editedId, { summary: 'Projekt Storch startet am 14. Dezember.' }, {
      actorOmadiaUserId: OWNER,
    });
    await kg.updateMemorableKnowledge(untouchedId, { significance: 0.9 }, { actorOmadiaUserId: OWNER });

    const edited = await kg.getMemorableKnowledge(editedId, OWNER);
    const rescored = await kg.getMemorableKnowledge(untouchedId, OWNER);
    assert.equal(typeof edited?.props[MEMORY_CORRECTED_AT_PROP], 'string');
    assert.equal(rescored?.props[MEMORY_CORRECTED_AT_PROP], undefined);
  });

  it('isMemorableContentCorrection compares with the current content', () => {
    const current = { kind: 'reference', summary: 'A', rationale: 'R' };
    assert.equal(isMemorableContentCorrection(current, { summary: 'A' }), false);
    assert.equal(isMemorableContentCorrection(current, { summary: 'B' }), true);
    assert.equal(isMemorableContentCorrection(current, { kind: 'reference' }), false);
    assert.equal(isMemorableContentCorrection(current, { rationale: null }), true);
    assert.equal(isMemorableContentCorrection({ summary: 'A' }, { rationale: null }), false);
    assert.equal(isMemorableContentCorrection(current, { significance: 0.4 }), false);
  });

  it('renders the correction marker and the date of each insight', async () => {
    const { kg, editedId, untouchedId } = await seed();
    await kg.updateMemorableKnowledge(editedId, { summary: 'Projekt Storch startet am 14. Dezember.' }, {
      actorOmadiaUserId: OWNER,
    });
    // The edit drops the stale embedding; the backfill would write a new one.
    kg.setEmbedding(editedId, ALIGNED);
    kg.setEmbedding(untouchedId, ALIGNED);

    const retriever = new ContextRetriever(kg, { teamVisibility: true }, stubEmbedder);
    const result = await retriever.assembleForBudget({
      userMessage: 'Wann startet Projekt Storch?',
      agentId: 'test-agent',
      sessionScope: 'sess-now',
      userId: 'alice',
    });

    const edited = result.recalled?.insights.find((i) => i.mkId === editedId);
    const untouched = result.recalled?.insights.find((i) => i.mkId === untouchedId);
    assert.equal(edited?.correctedByUser, true);
    assert.equal(edited?.asOf, today());
    assert.equal(untouched?.correctedByUser, undefined);
    assert.equal(untouched?.asOf, today(), 'an unedited entry carries its creation day');
    assert.ok(
      result.text.includes(`14. Dezember. (${USER_CORRECTED_MARKER} ${today()}; score`),
      result.text,
    );
    assert.ok(result.text.includes(`Team Nord. (Stand ${today()}; score`), result.text);
  });
});
