/** ADR-0225 — `linkChannelIdentity` on the in-memory graph. */
import { describe, it } from 'node:test';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';

import { LINK_CONTRACT } from './_helpers/channelIdentityLinkContract.js';

describe('ADR-0225 · channel identity link (in-memory graph)', () => {
  for (const [name, scenario] of LINK_CONTRACT) {
    it(name, () => scenario(new InMemoryKnowledgeGraph()));
  }
});
