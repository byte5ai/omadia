/**
 * Re-export of the public `MemoryStore` + `MemoryEntry` contract from
 * `@omadia/plugin-api`. Kept as a module-local alias so package
 * internals (filesystem.ts, seeder.ts, memoryTool.ts, devMemoryRouter.ts)
 * reference a single import path; external consumers should depend on the
 * plugin-api surface directly.
 */
export type { MemoryStore, MemoryEntry } from '@omadia/plugin-api';
