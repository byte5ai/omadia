import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FilesystemMemoryStore } from '@omadia/memory';

import { runMemoryStoreConformance } from './memoryStoreConformance.js';

runMemoryStoreConformance(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omadia-mem-fs-'));
  const store = new FilesystemMemoryStore(dir);
  await store.init();
  return {
    store,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}, 'FilesystemMemoryStore');
