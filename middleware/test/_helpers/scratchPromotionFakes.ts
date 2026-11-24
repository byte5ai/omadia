import type {
  KnowledgeGraph,
  MemorableKnowledgeIngest,
  MemorableKnowledgeIngestResult,
} from '@omadia/plugin-api';

// Fakes shared by `scratchPromotionReaper.test.ts` (no database) and
// `scratchPromotionReaper.pg.test.ts` (real Postgres).

// A fake SignificanceScorer: high for content containing 'SIGNIFICANT',
// low otherwise. Deterministic.
export function makeFakeScorer(): {
  score(text: string): Promise<{ score: number }>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    async score(text: string): Promise<{ score: number }> {
      calls.push(text);
      return { score: text.includes('SIGNIFICANT') ? 0.95 : 0.1 };
    },
    calls,
  };
}

// Fake KG capturing createMemorableKnowledge calls.
export function makeFakeKg(): {
  kg: KnowledgeGraph;
  createCalls: MemorableKnowledgeIngest[];
} {
  const createCalls: MemorableKnowledgeIngest[] = [];
  const kg = {
    async createMemorableKnowledge(
      input: MemorableKnowledgeIngest,
    ): Promise<MemorableKnowledgeIngestResult> {
      createCalls.push(input);
      return {
        memorableKnowledgeNodeId: `mk:scratch-${String(createCalls.length)}`,
        skippedInvolved: 0,
        skippedRequired: 0,
        skippedDerivedFrom: 0,
      };
    },
  } as unknown as KnowledgeGraph;
  return { kg, createCalls };
}
