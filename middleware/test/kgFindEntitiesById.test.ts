import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { KnowledgeGraph } from '@omadia/plugin-api';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory/dist/inMemoryKnowledgeGraph.js';
import {
  CaptureFilteringKnowledgeGraph,
  MergeTriggeringKnowledgeGraph,
} from '@omadia/orchestrator-extras';
import { InconsistencyTriggeringKnowledgeGraph } from '@omadia/orchestrator-extras/dist/inconsistencyTriggeringKnowledgeGraph.js';

import {
  FIND_BY_ID_ENTITIES,
  runFindEntitiesByIdContract,
} from './kgFindEntitiesByIdContract.js';

// In-memory leg of the exact-id contract; the Neon leg lives in
// kgFindEntitiesById.pg.test.ts. Always runs.
async function seededGraph(): Promise<InMemoryKnowledgeGraph> {
  const kg = new InMemoryKnowledgeGraph();
  await kg.ingestEntities([...FIND_BY_ID_ENTITIES]);
  return kg;
}

let graph: Promise<KnowledgeGraph> | undefined;

runFindEntitiesByIdContract('InMemoryKnowledgeGraph', () => {
  graph ??= seededGraph();
  return graph;
});

// The verifier gets the knowledge graph through the orchestrator-extras
// decorators. `findEntities` must reach the backend with `id` intact — a
// wrapper that rebuilt the options field by field would silently drop it and
// turn the exact lookup back into a model-wide one.
describe('findEntities({ id }) — orchestrator-extras decorators forward the id', () => {
  const wrappers: ReadonlyArray<[string, (inner: KnowledgeGraph) => KnowledgeGraph]> = [
    [
      'CaptureFilteringKnowledgeGraph',
      (inner) => new CaptureFilteringKnowledgeGraph({ inner, filter: {} as never }),
    ],
    [
      'MergeTriggeringKnowledgeGraph',
      (inner) => new MergeTriggeringKnowledgeGraph({ inner, detector: {} as never }),
    ],
    [
      'InconsistencyTriggeringKnowledgeGraph',
      (inner) => new InconsistencyTriggeringKnowledgeGraph({ inner, detector: {} as never }),
    ],
  ];

  for (const [name, wrap] of wrappers) {
    it(`${name} resolves exactly the requested record`, async () => {
      const wrapped = wrap(await seededGraph());

      const hits = await wrapped.findEntities({ model: 'res.partner', id: 7 });

      assert.deepEqual(
        hits.map((n) => n.id),
        ['odoo:res.partner:7'],
      );
    });
  }
});
