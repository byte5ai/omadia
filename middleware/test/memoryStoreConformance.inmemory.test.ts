import { InMemoryMemoryStore } from '@omadia/memory';

import { runMemoryStoreConformance } from './memoryStoreConformance.js';

runMemoryStoreConformance(async () => {
  const store = new InMemoryMemoryStore();
  return {
    store,
    cleanup: async () => {
      // Fresh instance per case; nothing to tear down.
    },
  };
}, 'InMemoryMemoryStore');
