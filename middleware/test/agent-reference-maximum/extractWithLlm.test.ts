import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { extractWithLlm } from '../../packages/agent-reference-maximum/extractor.js';

function makeStubLlm(text: string): {
  complete(req: {
    model: string;
    system?: string;
    messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
    maxTokens?: number;
  }): Promise<{ text: string }>;
} {
  return {
    async complete() {
      return { text };
    },
  };
}

describe('agent-reference / extractWithLlm (OB-29-3)', () => {
  it('parses clean JSON output', async () => {
    const llm = makeStubLlm(
      '{"entities":[{"type":"Person","name":"Marcel"},{"type":"Topic","name":"ThemeF"}]}',
    );
    const r = await extractWithLlm({ body: 'irrelevant', llm });
    assert.equal(r.length, 2);
    const ids = r.map((e) => e.id).sort();
    assert.deepEqual(ids, ['marcel', 'themef']);
  });

  it('strips markdown fences around JSON', async () => {
    const llm = makeStubLlm(
      '```json\n{"entities":[{"type":"Person","name":"Anna Müller"}]}\n```',
    );
    const r = await extractWithLlm({ body: 'x', llm });
    assert.equal(r.length, 1);
    assert.equal(r[0]!.id, 'anna-mueller');
  });

  it('returns empty array on malformed output', async () => {
    const llm = makeStubLlm('I cannot find any entities, sorry.');
    const r = await extractWithLlm({ body: 'x', llm });
    assert.deepEqual(r, []);
  });

  it('returns empty array on empty entities', async () => {
    const llm = makeStubLlm('{"entities":[]}');
    const r = await extractWithLlm({ body: 'x', llm });
    assert.deepEqual(r, []);
  });

  it('deduplicates repeated entities', async () => {
    const llm = makeStubLlm(
      '{"entities":[{"type":"Person","name":"Bob"},{"type":"Person","name":"Bob"}]}',
    );
    const r = await extractWithLlm({ body: 'x', llm });
    assert.equal(r.length, 1);
  });

  it('skips entities with empty / unslugifiable names', async () => {
    const llm = makeStubLlm(
      '{"entities":[{"type":"Person","name":""},{"type":"Person","name":"###"}]}',
    );
    const r = await extractWithLlm({ body: 'x', llm });
    assert.deepEqual(r, []);
  });

  it('coerces unknown type to Topic (defensive)', async () => {
    const llm = makeStubLlm(
      '{"entities":[{"type":"Beverage","name":"Coffee"}]}',
    );
    const r = await extractWithLlm({ body: 'x', llm });
    assert.equal(r.length, 1);
    assert.equal(r[0]!.model, 'Topic');
    assert.equal(r[0]!.id, 'coffee');
  });
});
